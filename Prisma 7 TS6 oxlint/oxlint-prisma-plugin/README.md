# oxlint Prisma plugin

Catches Prisma query keys that don't exist on the model — a typo'd or stale
field in `select`, `include`, `where`, `cursor`, `data` or `orderBy` — by
reading `db/schema.prisma` directly instead of relying on the generated types.

## Why this exists

TypeScript used to catch these. Unknown keys in an object literal are rejected
by the **excess-property check**: assign a fresh literal to a type, and any key
the target doesn't declare is an error.

[microsoft/TypeScript#62722] (shipped in TS 6.0, ported to tsgo) stopped
applying that check to literals reaching a generic parameter through Prisma's
`Subset<T, Args>` pattern. Since then a wrong field name type-checks cleanly and
fails at runtime instead:

```
PrismaClientValidationError: Unknown arg `productionUser` in where.OR.1.productionUser
```

Patching the generated client was tried and doesn't work — see "Rejected
alternatives" below. Reading the schema in a lint rule does.

The upstream reports are [prisma#29519] and [prisma#29449]; both were still open
and unconfirmed when these rules were written.

### What TypeScript still catches

The exemption applies **per object literal**, and only to literals holding at
least one *valid* key. So the compiler still reports:

- a literal made up solely of unknown keys — `where: { user: { bogusField: 1 } }`
- operator typos — `{ craete: … }`, `{ contians: "x" }` — because the operator
  object usually contains nothing but the typo
- `distinct` and `groupBy.by` — checked against a `ScalarFieldEnum` union rather
  than by excess-property checking

These rules therefore target one shape: **an unknown key sitting next to a valid
one**. `scripts/oxlint/lint-playground/oxlint/prisma-rule-errors.ts` documents
the boundary case by case, with `@ts-expect-error` marking everything the
compiler still reports. That file is type-checked, so it can't drift: an unused
marker is itself a compile error.

## Rules

| Rule | Covers |
| --- | --- |
| `no-unknown-select-field` | `select` / `include`, nested and across `select`↔`include`. Also rejects scalars in `include` (relations only). |
| `no-unknown-where-field` | `where` and `cursor`, through `AND`/`OR`/`NOT`, relation filters (`some`/`every`/`none`/`is`/`isNot`) and the to-one shorthand `user: { orgId: 1 }`. |
| `no-unknown-data-field` | `data` for create/update/upsert/createMany, including nested writes (`create`, `connect`, `connectOrCreate`, `update`, `upsert`, …). |
| `no-unknown-orderby-field` | `orderBy`, including ordering through to-one relations. Skips Prisma's own `_count` / `_avg` / `_relevance` keys. |

## Configuration

Registered in the root [`oxlint.config.ts`](../../../oxlint.config.ts):

```ts
jsPlugins: ["./scripts/oxlint/oxlint-prisma-plugin/index.cjs"],
rules: {
  "prisma/no-unknown-select-field": ["error", { schemaDir: "db" }],
  "prisma/no-unknown-where-field": ["error", { schemaDir: "db" }],
  "prisma/no-unknown-data-field": ["error", { schemaDir: "db" }],
  "prisma/no-unknown-orderby-field": ["error", { schemaDir: "db" }],
}
```

Two things bite here, both silently:

- **The `prisma/` prefix is `meta.name` in [`index.cjs`](./index.cjs)**, not the
  directory name. Rename the plugin without updating both configs and every rule
  stops matching: oxlint prints `Plugin 'prisma' not found` among the rest of
  its output and lints on without them.
- **`schemaDir` is required.** Omit it and the rule returns no visitor — it
  reports nothing and says nothing. It stays explicit because it's the one thing
  coupling these rules to a specific schema location, and a wrong default would
  fail the same quiet way.

`schemaDir` is resolved by walking up from each linted file to the first
ancestor containing that directory, so `"db"` finds `<repo>/db` from anywhere.

The same registration exists in the playground config,
[`lint-playground/oxlint/.oxlintrc.json`](../lint-playground/oxlint/.oxlintrc.json)
— keep both in sync when adding a rule.

## How it works

- [`schema.cjs`](./rules/schema.cjs) parses `db/*.prisma` into
  `{ Model: { fields: { field: { relation } }, uniqueKeys: Set } }`. `relation`
  is the target model for relation fields (letting the rules follow a key into
  the next model) and null for scalars and enums. `uniqueKeys` holds the
  compound keys Prisma synthesises from `@@unique`/`@@id` — `@@unique([a, b])`
  becomes `a_b` — which are valid `where` keys without being fields.
- [`shared.cjs`](./rules/shared.cjs) matches `(db|prisma|tx).<model>.<method>(…)`
  calls and resolves the schema. Parsing runs once per process, and the
  directory walk is cached per (directory, `schemaDir`), so all four rules
  together cost about what one did: ~5 ms parse, and filesystem work only for
  the files that actually contain a Prisma call.
- Each rule then walks its argument, following relations, and reports keys the
  model doesn't have.

Detection is syntax-only — no type information. The rules bail wherever they
can't resolve something confidently: unknown roots, computed keys and spreads
are skipped rather than guessed at.

## Not covered

Deliberate gaps, each with a live example in the playground file:

- **Filters built as a variable.** `const f = {…}; db.user.findMany({ where: f })`
  — no literal reaches the call site. This was never checked, TS 5.9 included
  ([prisma#28388], closed as expected TypeScript behaviour), and a syntax-only
  rule can't follow the binding.
- **Operator typos beside a valid operator.**
  `login: { contains: "x", modee: "insensitive" }`. Unrecognised operator keys
  are skipped on purpose: the valid set varies by field type and relation kind
  (Json filters take `path`/`string_contains`, scalar lists take `has`/`hasEvery`,
  …), so flagging them invites false positives. The single-typo case — the
  realistic one — is still caught by tsc.
- **`orderBy` / `where` nested inside `select` or `include`.** Only the
  top-level argument is walked.
- **`include` keys are not checked for being relations beyond the scalar case**,
  and `_count` is accepted everywhere.

## Rejected alternatives

- **Patching the generated client's `SelectSubset` with `Exact<T, U>`.** `Exact`
  does restore the check under TS 7 in isolation, but wiring it into the real
  client produced ~24 false positives across Json and tuple inputs
  (`Type '[string]' is not assignable to type '[string] & (JsonNull | InputJsonValue)'`)
  and the `Without<>` unions of create/update. The upstream plugin's author
  reached the same conclusion independently.
- **Changing `Enumerable<T>` to `Array<T>`** (the Prisma 5 shape), or making
  `Subset` recursive so unknown keys resolve to `never`. Neither restores the
  check: what's missing is the compiler's freshness check, not a type shape.
- **Pinning TypeScript 5.9 as a second CI gate.** It does catch all of this, but
  costs a second full type-check (~12 GB heap on this repo) to cover a class of
  bug a lint rule handles for ~70 ms.

[microsoft/TypeScript#62722]: https://github.com/microsoft/TypeScript/pull/62722
[prisma#29519]: https://github.com/prisma/prisma/issues/29519
[prisma#29449]: https://github.com/prisma/prisma/issues/29449
[prisma#28388]: https://github.com/prisma/prisma/issues/28388
