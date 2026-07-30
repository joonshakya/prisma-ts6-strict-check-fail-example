const {
  createModelsResolver,
  findObjectProp,
  forEachObjectLiteral,
  getStaticKey,
  hasKey,
  prismaCallModelName,
} = require("./shared.cjs")

// Methods that write, i.e. take `data` (or `create`/`update` on upsert).
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
])

// Nested writes whose operand is a `where` filter on the related model.
const NESTED_WRITE_AS_WHERE = new Set(["connect", "disconnect", "set", "delete", "deleteMany"])

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `data` keys that are not fields on the Prisma model",
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

    function validateData(objectExpr, modelName) {
      const model = models[modelName]
      if (!model) return // Unknown model — don't guess.

      for (const prop of objectExpr.properties) {
        const key = getStaticKey(prop)
        if (key === null) continue // spread or computed — skip

        const field = model.fields[key]
        if (!field) {
          context.report({
            node: prop.key,
            messageId: "unknownField",
            data: { field: key, model: modelName },
          })
          continue
        }

        // Scalar values — including Json objects and update operators like
        // `{ increment: 1 }` — carry no field names of their own.
        if (field.relation && prop.value.type === "ObjectExpression") {
          validateNestedWrite(prop.value, field.relation)
        }
      }
    }

    /**
     * A nested write is a set of operator keys (`create`, `connect`, …), each
     * describing data or a filter on the related model. Unrecognised operator
     * keys are skipped rather than reported: this rule only claims to know
     * field names, and Prisma's operator set varies by relation kind.
     */
    function validateNestedWrite(objectExpr, targetModel) {
      for (const prop of objectExpr.properties) {
        const key = getStaticKey(prop)
        if (key === null) continue

        if (key === "connectOrCreate") {
          forEachObjectLiteral(prop.value, (operand) => {
            const where = findObjectProp(operand, "where")
            const create = findObjectProp(operand, "create")
            if (where) validateData_asWhereKeys(where, targetModel)
            if (create) validateData(create, targetModel)
          })
          continue
        }

        if (key === "createMany") {
          forEachObjectLiteral(prop.value, (operand) => {
            const data = operand.properties.find((p) => getStaticKey(p) === "data")
            if (data) forEachObjectLiteral(data.value, (row) => validateData(row, targetModel))
          })
          continue
        }

        if (key === "create") {
          forEachObjectLiteral(prop.value, (operand) => validateData(operand, targetModel))
          continue
        }

        if (key === "upsert") {
          forEachObjectLiteral(prop.value, (operand) => validateUpsert(operand, targetModel))
          continue
        }

        if (key === "update" || key === "updateMany") {
          forEachObjectLiteral(prop.value, (operand) => validatePairOrData(operand, targetModel))
          continue
        }

        if (NESTED_WRITE_AS_WHERE.has(key)) {
          forEachObjectLiteral(prop.value, (operand) =>
            validateData_asWhereKeys(operand, targetModel)
          )
          continue
        }
      }
    }

    /**
     * A nested `upsert` operand is `{ create, update }`, plus a `where` for
     * to-many relations. Unlike `update` below it never carries bare data, so
     * `create`/`update` here are always operators rather than field names.
     */
    function validateUpsert(objectExpr, targetModel) {
      const where = findObjectProp(objectExpr, "where")
      if (where) validateData_asWhereKeys(where, targetModel)
      for (const name of ["create", "update"]) {
        const nested = findObjectProp(objectExpr, name)
        if (nested) validateData(nested, targetModel)
      }
    }

    /**
     * A nested `update`/`updateMany` operand comes in two shapes: the explicit
     * `{ where, data }` pair used for to-many relations, and the bare data
     * object allowed for to-one relations.
     */
    function validatePairOrData(objectExpr, targetModel) {
      if (!hasKey(objectExpr, "where")) {
        validateData(objectExpr, targetModel)
        return
      }

      const where = findObjectProp(objectExpr, "where")
      if (where) validateData_asWhereKeys(where, targetModel)
      const data = findObjectProp(objectExpr, "data")
      if (data) validateData(data, targetModel)
    }

    /**
     * Validate the keys of a `where`-shaped operand inside a nested write.
     * Only field names are checked; compound `@@unique` keys are accepted, and
     * relation filters are left to the `no-unknown-where-field` rule.
     */
    function validateData_asWhereKeys(objectExpr, modelName) {
      const model = models[modelName]
      if (!model) return

      for (const prop of objectExpr.properties) {
        const key = getStaticKey(prop)
        if (key === null) continue
        if (model.uniqueKeys.has(key)) continue
        if (model.fields[key]) continue

        context.report({
          node: prop.key,
          messageId: "unknownField",
          data: { field: key, model: modelName },
        })
      }
    }

    return {
      CallExpression(node) {
        const modelName = prismaCallModelName(node, WRITE_METHODS)
        if (!modelName) return

        models = ensureModels()
        if (!models || !models[modelName]) return

        const arg = node.arguments[0]
        if (!arg || arg.type !== "ObjectExpression") return

        // `data` is an object for create/update, an array for createMany.
        const data = arg.properties.find((prop) => getStaticKey(prop) === "data")
        if (data) forEachObjectLiteral(data.value, (row) => validateData(row, modelName))

        // upsert takes `create` and `update` in place of `data`.
        for (const name of ["create", "update"]) {
          const nested = findObjectProp(arg, name)
          if (nested) validateData(nested, modelName)
        }
      },
    }
  },
}
