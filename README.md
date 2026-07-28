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
const posts = await prisma.post.findMany({
  select: {
    id: true,
    name: true,
    nonExistentField: true, // TS5: error. TS>=6: silently passes.
  },
})

posts.forEach((post) => {
  console.log(post.name, post.nonExistentField) // TS5: error. TS>=6: silently passes.
})
```

**TypeScript 5.x** (5.9.3) catches `nonExistentField` at compile time with:

- `TS2353`: Object literal may only specify known properties, and 'nonExistentField' does not exist in type 'PostSelect<DefaultArgs>'.
- `TS2339`: Property 'nonExistentField' does not exist on type '{ name: string; id: number; }'.

**TypeScript >=6** (tested with 6.0.3) allows it through without any error.

This behavior is **identical across Prisma 6 and Prisma 7** — it is purely a TypeScript version regression.

## Project Structure

```
prisma-ts-strict/
├── .gitignore
├── package.json                 # Root: setup + typecheck:all scripts
├── run-typecheck.sh             # Runs tsc --noEmit across all 4 projects
├── README.md
│
├── Prisma 6 TS5/                # prisma@^6, typescript@^5
│   ├── .gitignore
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.prisma
│   └── index.ts
│
├── Prisma 6 TS6/                # prisma@^6, typescript@^6
│   └── ... (same files)
│
├── Prisma 7 TS5/                # prisma@^7, typescript@^5
│   ├── .gitignore
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.prisma
│   ├── prisma.config.ts         # Prisma 7: separate config file
│   └── index.ts
│
└── Prisma 7 TS6/                # prisma@^7, typescript@^6
    └── ... (same files)
```

### Schema

Every project uses the same `schema.prisma`:

```prisma
model Post {
  id   Int    @id @default(autoincrement())
  name String
}
```

Only `id` and `name` exist on the model — `nonExistentField` is intentionally not present.

### What's in each project

| File | Purpose |
|------|---------|
| `package.json` | Declares `@prisma/client`, `prisma`, and `typescript` at the target versions |
| `tsconfig.json` | `strict: true`, `noEmit: true`, targeting ES2022 |
| `schema.prisma` | Single `Post` model with `id: Int` and `name: String` |
| `index.ts` | Initializes PrismaClient, calls `findMany` with `select: { id, name, nonExistentField }`, then logs `post.name` and `post.nonExistentField` (runtime access to the phantom field) |
| `prisma.config.ts` | (Prisma 7 only) — replaces `url` in schema, uses `@prisma/adapter-libsql` |

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3.0

## Setup

```bash
# Install dependencies, generate Prisma Client, push schema to SQLite
bun run setup
```

This runs `bun install && prisma generate && prisma db push` inside each of the 4 project directories.

## Run Type Checks

```bash
# Run tsc --noEmit on all 4 projects
bun run typecheck:all
```

Or run individually:

```bash
(cd "Prisma 6 TS5" && bun run typecheck)
(cd "Prisma 6 TS6" && bun run typecheck)
(cd "Prisma 7 TS5" && bun run typecheck)
(cd "Prisma 7 TS6" && bun run typecheck)
```

## Results

```
=== Prisma 6 TS5 ===     → FAIL  (TS2353 + TS2339 on nonExistentField)
=== Prisma 6 TS6 ===     → OK    (no errors)
=== Prisma 7 TS5 ===     → FAIL  (TS2353 + TS2339 on nonExistentField)
=== Prisma 7 TS6 ===     → OK    (no errors)
```

| Folder | Prisma | TypeScript | `nonExistentField` caught? | Errors |
|--------|--------|-----------|---------------------------|--------|
| Prisma 6 TS5 | 6.19.3 | 5.9.3 | ✅ Yes | `TS2353`, `TS2339` |
| Prisma 6 TS6 | 6.19.3 | 6.0.3 | ❌ No | none |
| Prisma 7 TS5 | 7.9.1 | 5.9.3 | ✅ Yes | `TS2353`, `TS2339` |
| Prisma 7 TS6 | 7.9.1 | 6.0.3 | ❌ No | none |

## Analysis

- **TypeScript 5.9.3** correctly rejects `nonExistentField` in the `select` object literal. This is standard excess property checking on generic types — the same behavior that has kept Prisma's `select` type-safe since Prisma adopted strict `Select` types.

- **TypeScript >=6** (tested with 6.0.3) no longer performs this check. The `select` object compiles without error, meaning a field that does not exist on the model can be passed through without any compile-time warning. At runtime it resolves to `undefined`.

- The regression is **TypeScript-only**. Prisma 6 and Prisma 7 behave identically when paired with the same TypeScript version. Prisma 7's generated types use the same `PostSelect` pattern — excess property checking is purely a TypeScript compiler concern.

- Both errors (`TS2353` for the select object, `TS2339` for accessing the result) are missing in TS>=6. This means the entire unsafe field path — declaration to access — goes unchecked.

## Version Details

All package versions resolved at time of testing:

| Package | Version |
|---------|---------|
| bun | 1.3.14 |
| @prisma/client (v6 track) | 6.19.3 |
| @prisma/client (v7 track) | 7.9.1 |
| typescript (v5 track) | 5.9.3 |
| typescript (>=6 track) | 6.0.3 |
