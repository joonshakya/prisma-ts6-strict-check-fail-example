const {
  createModelsResolver,
  forEachObjectLiteral,
  getStaticKey,
  prismaCallModelName,
} = require("./shared.cjs")

// Methods whose first argument accepts `orderBy`.
const QUERY_METHODS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
])

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `orderBy` keys that are not fields on the Prisma model",
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
    },
  },

  create(context) {
    const options = context.options?.[0]
    if (!options?.schemaDir) return {}

    const ensureModels = createModelsResolver(context, options.schemaDir)
    let models

    function validateOrderBy(objectExpr, modelName) {
      const model = models[modelName]
      if (!model) return // Unknown model — don't guess.

      for (const prop of objectExpr.properties) {
        const key = getStaticKey(prop)
        if (key === null) continue // spread or computed — skip

        // Aggregate and fulltext orderBy keys (`_count`, `_avg`, `_sum`, `_min`,
        // `_max`, `_relevance`) are Prisma's own, not fields on the model.
        if (key.startsWith("_")) continue

        const field = model.fields[key]
        if (!field) {
          context.report({
            node: prop.key,
            messageId: "unknownField",
            data: { field: key, model: modelName },
          })
          continue
        }

        // A to-one relation is ordered by the related model's fields
        // (`user: { name: "asc" }`). A to-many relation only takes `_count`,
        // which the underscore check above already skipped. Scalars take a
        // direction or `{ sort, nulls }` — no field names either way.
        if (field.relation) {
          forEachObjectLiteral(prop.value, (operand) => validateOrderBy(operand, field.relation))
        }
      }
    }

    return {
      CallExpression(node) {
        const modelName = prismaCallModelName(node, QUERY_METHODS)
        if (!modelName) return

        models = ensureModels()
        if (!models || !models[modelName]) return

        const arg = node.arguments[0]
        if (!arg || arg.type !== "ObjectExpression") return

        // `orderBy` takes a single object or an array of them.
        const orderBy = arg.properties.find((prop) => getStaticKey(prop) === "orderBy")
        if (orderBy) {
          forEachObjectLiteral(orderBy.value, (operand) => validateOrderBy(operand, modelName))
        }
      },
    }
  },
}
