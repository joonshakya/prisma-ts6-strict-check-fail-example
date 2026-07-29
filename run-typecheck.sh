#!/bin/bash
set -e

for dir in "Prisma 6 TS5" "Prisma 6 TS6" "Prisma 7 TS5" "Prisma 7 TS6" "Prisma 8 TS5" "Prisma 8 TS6"; do
  echo "=== $dir ==="
  (cd "$dir" && bun run typecheck) && echo "OK" || echo "FAIL (expected due to nonExistentField)"
  echo ""
done
