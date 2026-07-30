const {
  createModelsResolver,
  findObjectProp,
  getStaticKey,
  prismaCallModelName,
} = require("./shared.cjs")

// Methods whose first argument accepts `select` / `include`.
const QUERY_METHODS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createManyAndReturn",
  "update",
  "updateManyAndReturn",
  "upsert",
  "delete",
])

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `select`/`include` keys that are not fields on the Prisma model",
    },
    schema: [
      {
        type: "object",
        properties: {
          schemaDir: { type: "string" },
        },
        required: ["schemaDir"],
        additionalProperties: false,
      },
    ],
    messages: {
      unknownField:
        "'{{field}}' is not a field on Prisma model '{{model}}'. Check the schema in db/schema.prisma.",
      notARelation:
        "'{{field}}' is a scalar field on Prisma model '{{model}}'. `include` only accepts relations — use `select` for scalars.",
    },
  },

  create(context) {
    const options = context.options?.[0]
    if (!options?.schemaDir) return {}

    const ensureModels = createModelsResolver(context, options.schemaDir)
    let models

    /** `mode` is "select" or "include" — `include` accepts relations only. */
    function validateSelection(objectExpr, modelName, mode) {
      const model = models[modelName]
      if (!model) return // Unknown model — don't guess.

      for (const prop of objectExpr.properties) {
        const key = getStaticKey(prop)
        if (key === null) continue // spread or computed — skip
        if (key === "_count") continue // Prisma virtual aggregate field

        const field = model.fields[key]
        if (!field) {
          context.report({
            node: prop.key,
            messageId: "unknownField",
            data: { field: key, model: modelName },
          })
          continue
        }

        if (mode === "include" && !field.relation) {
          context.report({
            node: prop.key,
            messageId: "notARelation",
            data: { field: key, model: modelName },
          })
          continue
        }

        // Recurse into nested select/include on a relation field.
        if (field.relation && prop.value.type === "ObjectExpression") {
          const nestedSelect = findObjectProp(prop.value, "select")
          const nestedInclude = findObjectProp(prop.value, "include")
          if (nestedSelect) validateSelection(nestedSelect, field.relation, "select")
          if (nestedInclude) validateSelection(nestedInclude, field.relation, "include")
        }
      }
    }

    return {
      CallExpression(node) {
        const modelName = prismaCallModelName(node, QUERY_METHODS)
        if (!modelName) return

        // Only now — a confirmed `<root>.<model>.<method>` call — do we need the
        // schema. Resolve (and memoize) it lazily.
        models = ensureModels()
        if (!models || !models[modelName]) return

        const arg = node.arguments[0]
        if (!arg || arg.type !== "ObjectExpression") return

        const select = findObjectProp(arg, "select")
        const include = findObjectProp(arg, "include")
        if (select) validateSelection(select, modelName, "select")
        if (include) validateSelection(include, modelName, "include")
      },
    }
  },
}
