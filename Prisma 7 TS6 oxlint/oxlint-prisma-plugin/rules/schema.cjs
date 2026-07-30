const fs = require("node:fs")
const path = require("node:path")

/**
 * Parse the `.prisma` files in a directory into a model -> field map.
 *
 * The map shape is:
 *   { [ModelName]: { fields: { [fieldName]: { relation: string | null } }, uniqueKeys: Set<string> } }
 * where `relation` is the target model name for relation fields, or null for
 * scalar / enum fields. This lets the lint rules both verify a key exists and,
 * for nested `select`/`include`/`where`, follow a relation to the next model.
 *
 * `uniqueKeys` holds the compound-key names Prisma synthesises from `@@unique`
 * and `@@id` block attributes (`@@unique([a, b])` -> `a_b`, or the explicit
 * `name:` when given). Those are valid `where` keys on findUnique/update/delete
 * without being fields, so the rules must not flag them.
 *
 * Parsing is intentionally line-based rather than a full Prisma grammar: our
 * schema is plain `model`/`enum` blocks with one field per line
 * (`name Type modifiers`). Field attributes are ignored.
 */
function parsePrismaSchema(schemaDir) {
  const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".prisma"))

  // First pass: collect declared model names so we can classify a field's type
  // as a relation (-> model) vs a scalar/enum (-> null).
  const modelNames = new Set()
  const fileContents = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(schemaDir, file), "utf8")
    fileContents.push(content)
    for (const match of content.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) {
      modelNames.add(match[1])
    }
  }

  const models = {}
  for (const content of fileContents) {
    parseModelsFromContent(content, models, modelNames)
  }

  return models
}

function parseModelsFromContent(content, models, modelNames) {
  const lines = content.split("\n")
  let currentModel = null

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim()
    if (line === "") continue

    const modelStart = line.match(/^model\s+(\w+)\s*\{/)
    if (modelStart) {
      currentModel = modelStart[1]
      models[currentModel] = { fields: {}, uniqueKeys: new Set() }
      continue
    }

    // A non-model block declaration (enum/type/view/datasource/generator) opens
    // with a trailing `{`. Require the brace so a *field* named `type`, `view`,
    // etc. isn't mistaken for a block start. Only meaningful when not already
    // inside a model.
    if (currentModel === null) {
      continue
    }
    if (/^(enum|type|view|datasource|generator)\s+\w+\s*\{/.test(line)) {
      currentModel = null
      continue
    }

    if (line === "}") {
      currentModel = null
      continue
    }

    const compoundKey = parseCompoundKey(line)
    if (compoundKey) {
      models[currentModel].uniqueKeys.add(compoundKey)
      continue
    }

    // Skip block-level and field attributes (@@index, @id, ...).
    if (line.startsWith("@")) continue

    // Field line: `name Type[?|[]] @attr...`
    const fieldMatch = line.match(/^(\w+)\s+(\w+)/)
    if (!fieldMatch) continue

    const [, fieldName, typeName] = fieldMatch
    const relation = modelNames.has(typeName) ? typeName : null
    models[currentModel].fields[fieldName] = { relation }
  }
}

/**
 * Derive the `where` key Prisma generates for a `@@unique`/`@@id` block
 * attribute: the explicit `name:` argument when present, otherwise the field
 * list joined with `_`. Returns null for any other line.
 */
function parseCompoundKey(line) {
  const attribute = line.match(/^@@(unique|id)\s*\((.*)\)\s*$/)
  if (!attribute) return null

  const args = attribute[2]
  const explicitName = args.match(/\bname\s*:\s*"([^"]+)"/)
  if (explicitName) return explicitName[1]

  const fieldList = args.match(/\[([^\]]*)\]/)
  if (!fieldList) return null

  const fields = fieldList[1]
    .split(",")
    // A field may carry arguments of its own, e.g. `@@unique([name(sort: Desc)])`.
    .map((field) => field.trim().replace(/\(.*$/, "").trim())
    .filter((field) => field !== "")
  if (fields.length === 0) return null

  return fields.join("_")
}

function stripComment(line) {
  // Prisma uses `//` line comments. Schema field lines don't contain string
  // literals with `//`, so cutting at the first `//` is safe here.
  const idx = line.indexOf("//")
  return idx === -1 ? line : line.slice(0, idx)
}

module.exports = { parsePrismaSchema }
