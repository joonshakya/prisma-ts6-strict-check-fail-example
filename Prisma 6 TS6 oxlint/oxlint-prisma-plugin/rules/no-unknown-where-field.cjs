const {
  createModelsResolver,
  findObjectProp,
  forEachObjectLiteral,
  getStaticKey,
  prismaCallModelName,
} = require("./shared.cjs")

// Methods whose first argument accepts a `where` filter.
const QUERY_METHODS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
])

// Logical combinators; their operands are `where` filters on the same model.
const LOGICAL_OPS = new Set(["AND", "OR", "NOT"])

// Relation filters; their operands are `where` filters on the related model.
const RELATION_FILTER_OPS = new Set(["some", "every", "none", "is", "isNot"])

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `where`/`cursor` keys that are not fields on the Prisma model",
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

    function validateWhere(objectExpr, modelName) {
      const model = models[modelName]
      if (!model) return // Unknown model — don't guess.

      for (const prop of objectExpr.properties) {
        const key = getStaticKey(prop)
        if (key === null) continue // spread or computed — skip

        if (LOGICAL_OPS.has(key)) {
          forEachObjectLiteral(prop.value, (operand) => validateWhere(operand, modelName))
          continue
        }

        // Compound `@@unique`/`@@id` keys are valid here without being fields.
        // Their operand lists the constituent fields of this same model.
        if (model.uniqueKeys.has(key)) {
          forEachObjectLiteral(prop.value, (operand) => validateWhere(operand, modelName))
          continue
        }

        const field = model.fields[key]
        if (!field) {
          context.report({
            node: prop.key,
            messageId: "unknownField",
            data: { field: key, model: modelName },
          })
          continue
        }

        // Only relations lead to another model. Scalar filter objects
        // (`{ gt: 1 }`), Json filters and composite types are left alone.
        if (field.relation && prop.value.type === "ObjectExpression") {
          validateRelationFilter(prop.value, field.relation)
        }
      }
    }

    function validateRelationFilter(objectExpr, targetModel) {
      const operators = objectExpr.properties.filter((prop) =>
        RELATION_FILTER_OPS.has(getStaticKey(prop))
      )

      if (operators.length > 0) {
        for (const operator of operators) {
          forEachObjectLiteral(operator.value, (operand) => validateWhere(operand, targetModel))
        }
        return
      }

      // No operator key: a to-one relation filtered by the related model's
      // fields directly, e.g. `user: { organisationId: 1 }`.
      validateWhere(objectExpr, targetModel)
    }

    return {
      CallExpression(node) {
        const modelName = prismaCallModelName(node, QUERY_METHODS)
        if (!modelName) return

        models = ensureModels()
        if (!models || !models[modelName]) return

        const arg = node.arguments[0]
        if (!arg || arg.type !== "ObjectExpression") return

        const where = findObjectProp(arg, "where")
        if (where) validateWhere(where, modelName)

        // `cursor` is a whereUnique on the same model: field names and compound
        // `@@unique` keys. `validateWhere` accepts a superset of that, so it
        // can't produce false positives here.
        const cursor = findObjectProp(arg, "cursor")
        if (cursor) validateWhere(cursor, modelName)
      },
    }
  },
}
