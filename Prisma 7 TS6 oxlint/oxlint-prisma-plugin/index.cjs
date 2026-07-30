const noUnknownDataField = require("./rules/no-unknown-data-field.cjs")
const noUnknownOrderbyField = require("./rules/no-unknown-orderby-field.cjs")
const noUnknownSelectField = require("./rules/no-unknown-select-field.cjs")
const noUnknownWhereField = require("./rules/no-unknown-where-field.cjs")

module.exports = {
  meta: {
    name: "prisma",
  },
  rules: {
    "no-unknown-data-field": noUnknownDataField,
    "no-unknown-orderby-field": noUnknownOrderbyField,
    "no-unknown-select-field": noUnknownSelectField,
    "no-unknown-where-field": noUnknownWhereField,
  },
}
