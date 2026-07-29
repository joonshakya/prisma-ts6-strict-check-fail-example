# Prisma Strict Type Check Demo

Demonstrates a regression in TypeScript >=6 where excess property checking on Prisma's `select` objects is silently dropped — a behavior that TypeScript 5.x correctly catches.

## The Problem

Given this Prisma schema:

```prisma
model Post {
  id   Int    @id @default(autoincrement())
  name String
}
```

Attempting to select a field that does not exist:

```ts
// Prisma 6 / 7 — object-based select
const posts = await prisma.post.findMany({
  select: {
    id: true,
    name: true,
    nonExistentField: true, // TS5: error. TS>=6: silently passes.
  },
})
```

The same concept applies to **Prisma Next (Prisma 8)**, which uses a string-based `select()`:

```ts
const posts = await db.orm.public.Post.select('id', 'name', 'nonExistentField').all()
```

**TypeScript 5.x** (5.9.3) catches `nonExistentField` in both APIs:
- Prisma 6/7: `TS2353` — Object literal may only specify known properties
- Prisma 8: `TS2345` — Argument of type '"nonExistentField"' is not assignable

**TypeScript >=6** (tested with 6.0.3) behaves differently per API:

| API style | TS5 | TS>=6 |
|-----------|-----|-------|
| **Object-based select** (Prisma 6/7) `{ nonExistentField: true }` | ❌ Error | ✅ **Silently passes** |
| **String-based select** (Prisma 8) `'nonExistentField'` | ❌ Error | ❌ **Error** |

The regression only affects **object literal excess property checking**. Prisma 8's string-based `select()` is immune.

## Project Structure

```
prisma-ts-strict/
├── .gitignore
├── package.json                    # Root: setup + typecheck:all scripts
├── run-typecheck.sh                # Runs tsc --noEmit across all 6 projects
├── README.md
│
├── Prisma 6 TS5/                   # prisma@^6, typescript@^5
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.prisma
│   └── index.ts
├── Prisma 6 TS6/                   # prisma@^6, typescript@^6
├── Prisma 7 TS5/                   # prisma@^7, typescript@^5 (adds prisma.config.ts + adapter)
├── Prisma 7 TS6/                   # prisma@^7, typescript@^6
├── Prisma 8 TS5/                   # prisma-next@^0.16 (Prisma 8 early access), typescript@^5
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma-next.config.ts
│   ├── src/prisma/contract.prisma
│   ├── src/prisma/db.ts
│   └── index.ts
└── Prisma 8 TS6/                   # prisma-next@^0.16, typescript@^6
```

## Schema

**Prisma 6/7** use `schema.prisma`:

```prisma
model Post {
  id   Int    @id @default(autoincrement())
  name String
}
```

**Prisma 8 (Prisma Next)** uses a contract file (`contract.prisma`) with the same model:

```prisma
model Post {
  id   Int    @id @default(autoincrement())
  name String
}
```

Only `id` and `name` exist on the model — `nonExistentField` is intentionally not present.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3.0

## Setup

```bash
bun run setup
```

This runs:
- Prisma 6/7: `bun install && prisma generate && prisma db push`
- Prisma 8: `bun install && prisma-next contract emit`

## Run Type Checks

```bash
bun run typecheck:all
```

Or individually:

```bash
(cd "Prisma 6 TS5" && bun run typecheck)
(cd "Prisma 6 TS6" && bun run typecheck)
(cd "Prisma 7 TS5" && bun run typecheck)
(cd "Prisma 7 TS6" && bun run typecheck)
(cd "Prisma 8 TS5" && bun run typecheck)
(cd "Prisma 8 TS6" && bun run typecheck)
```

## Results

```
=== Prisma 6 TS5 ===     → FAIL  (TS2353 + TS2339 on nonExistentField)
=== Prisma 6 TS6 ===     → OK    (no errors)
=== Prisma 7 TS5 ===     → FAIL  (TS2353 + TS2339 on nonExistentField)
=== Prisma 7 TS6 ===     → OK    (no errors)
=== Prisma 8 TS5 ===     → FAIL  (TS2345 + TS2339 on nonExistentField)
=== Prisma 8 TS6 ===     → FAIL  (TS2345 + TS2339 on nonExistentField)
```

| Folder | Prisma | TypeScript | API style | `nonExistentField` caught? | Errors |
|--------|--------|-----------|-----------|---------------------------|--------|
| Prisma 6 TS5 | 6.19.3 | 5.9.3 | Object `select` | ✅ Yes | `TS2353`, `TS2339` |
| Prisma 6 TS6 | 6.19.3 | 6.0.3 | Object `select` | ❌ No | none |
| Prisma 7 TS5 | 7.9.1 | 5.9.3 | Object `select` | ✅ Yes | `TS2353`, `TS2339` |
| Prisma 7 TS6 | 7.9.1 | 6.0.3 | Object `select` | ❌ No | none |
| Prisma 8 TS5 | 0.16.0 | 5.9.3 | String `select()` | ✅ Yes | `TS2345`, `TS2339` |
| Prisma 8 TS6 | 0.16.0 | 6.0.3 | String `select()` | ✅ Yes | `TS2345`, `TS2339` |

## Analysis

- **TypeScript 5.9.3** catches `nonExistentField` in both API styles. Object literal excess property checking and string literal union checking both work.

- **TypeScript >=6** (tested with 6.0.3) drops **object literal excess property checking**. Prisma 6/7's `select: { nonExistentField: true }` compiles without error. At runtime the field resolves to `undefined`.

- **Prisma 8 (Prisma Next)** is **not affected** because its `select('id', 'name')` API uses string arguments constrained by a `keyof` union, not object literal keys on a mapped type. TS>=6 still validates string literal assignability correctly.

- The regression is **TypeScript-only**. Prisma 6 and Prisma 7 behave identically at the same TS version. Prisma 7's generated types use the same `PostSelect` pattern as Prisma 6.

- Both errors (`TS2353` for the select object, `TS2339` for accessing the result) are missing in TS>=6 for Prisma 6/7. The entire unsafe field path — declaration to access — goes unchecked.

- **Mitigation**: Projects on Prisma 6/7 that upgrade to TS>=6 lose type safety on `select` objects. Options include:
  - Migrating to Prisma Next's string-based API when Prisma 8 ships
  - Adding runtime validation for selected fields
  - Using eslint or other linting tools to enforce field existence

## Version Details

| Package | Version |
|---------|---------|
| bun | 1.3.14 |
| @prisma/client (v6 track) | 6.19.3 |
| @prisma/client (v7 track) | 7.9.1 |
| prisma-next | 0.16.0 |
| typescript (v5 track) | 5.9.3 |
| typescript (>=6 track) | 6.0.3 |
