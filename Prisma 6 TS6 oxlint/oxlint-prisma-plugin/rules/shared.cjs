const path = require("node:path")
const { parsePrismaSchema } = require("./schema.cjs")

// Roots a Prisma delegate call hangs off of: the `db` client (import db from
// "db"), the occasional `prisma` alias, and the transaction client `tx`.
const PRISMA_ROOTS = new Set(["db", "prisma", "tx"])

// Parse each schema dir once per process and memoize.
const schemaCache = new Map()
function getModels(schemaDir) {
  let models = schemaCache.get(schemaDir)
  if (!models) {
    models = parsePrismaSchema(schemaDir)
    schemaCache.set(schemaDir, models)
  }
  return models
}

/** Resolve the model name from a delegate accessor like `db.estimate`. */
function modelNameFor(property) {
  if (property.type !== "Identifier") return null
  return property.name.charAt(0).toUpperCase() + property.name.slice(1)
}

function getStaticKey(prop) {
  if (prop.type !== "Property" || prop.computed) return null
  if (prop.key.type === "Identifier") return prop.key.name
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") return prop.key.value
  return null
}

/** Find a named property (`select`/`where`/`data`) whose value is an object literal. */
function findObjectProp(objectExpr, name) {
  for (const prop of objectExpr.properties) {
    if (getStaticKey(prop) === name && prop.value.type === "ObjectExpression") {
      return prop.value
    }
  }
  return null
}

function hasKey(objectExpr, name) {
  return objectExpr.properties.some((prop) => getStaticKey(prop) === name)
}

/**
 * Prisma accepts an object or an array of objects in most nested positions
 * (`OR: [...]`, `connect: [...]`, `create: {...}`). Apply `fn` to each object
 * literal, ignoring anything we can't statically see into.
 */
function forEachObjectLiteral(node, fn) {
  if (node.type === "ObjectExpression") {
    fn(node)
    return
  }
  if (node.type === "ArrayExpression") {
    for (const element of node.elements) {
      if (element && element.type === "ObjectExpression") fn(element)
    }
  }
}

// Memoize the walk per (directory, schemaDir). Each rule resolves the schema
// independently, and files in the same directory walk the same ancestors, so
// without this the same lookup runs once per rule per file.
const resolvedCache = new Map()

/**
 * `schemaDir` in config is relative to a workspace root. Resolve it by walking
 * up from the linted file to the first ancestor that contains the dir with at
 * least one parseable model.
 */
function resolveModels(filename, schemaDir) {
  if (!filename) return null

  const startDir = path.dirname(filename)
  const cacheKey = `${startDir}\0${schemaDir}`
  if (resolvedCache.has(cacheKey)) return resolvedCache.get(cacheKey)

  let dir = startDir
  let result = null
  for (let i = 0; i < 30; i++) {
    const candidate = path.join(dir, schemaDir)
    try {
      const models = getModels(candidate)
      if (Object.keys(models).length > 0) {
        result = models
        break
      }
    } catch {
      // dir doesn't exist here — keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  resolvedCache.set(cacheKey, result)
  return result
}

/**
 * Resolve the schema lazily on the first qualifying Prisma call. Files that
 * never call `<root>.<model>.<method>(…)` — the large majority — then do no
 * filesystem work at all. The result (models, or null on failure) is memoized
 * per file so we don't re-walk on every call within the same file.
 */
function createModelsResolver(context, schemaDir) {
  let models
  let resolved = false
  return function ensureModels() {
    if (!resolved) {
      const filename = context.filename ?? context.getFilename?.()
      models = resolveModels(filename, schemaDir)
      resolved = true
    }
    return models
  }
}

/**
 * Match `<root>.<model>.<method>(…)` and return the model name, or null when
 * the call isn't a Prisma delegate call we recognise.
 */
function prismaCallModelName(node, methods) {
  const callee = node.callee
  if (callee.type !== "MemberExpression" || callee.computed) return null

  const method = callee.property.type === "Identifier" ? callee.property.name : null
  if (!method || !methods.has(method)) return null

  // The object the method is called on must be `<root>.<model>`.
  const delegate = callee.object
  if (delegate.type !== "MemberExpression" || delegate.computed) return null

  const root = delegate.object
  const rootName =
    root.type === "Identifier" ? root.name : root.type === "ThisExpression" ? "this" : null
  if (!rootName || !PRISMA_ROOTS.has(rootName)) return null

  return modelNameFor(delegate.property)
}

module.exports = {
  PRISMA_ROOTS,
  createModelsResolver,
  findObjectProp,
  forEachObjectLiteral,
  getStaticKey,
  hasKey,
  prismaCallModelName,
}
