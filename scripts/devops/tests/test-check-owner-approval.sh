#!/usr/bin/env bash
# test-check-owner-approval.sh — both directions for the owner-approval step of the Flow Gate:
# the real .github/CODEOWNERS resolves open / re-protected paths as intended (last match wins),
# an unowned code file that imports the DB client, the API, a finance service, or adds a
# controller is refused unless the owner APPROVED the head, and every fail-closed path refuses.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/check-owner-approval.mjs"
REPO="$(cd "$GUARD_DIR/../.." && pwd)"
CO="$REPO/.github/CODEOWNERS"
OWNER=yaremenko-maksym
HEAD=1111111111111111111111111111111111111111
OLD=2222222222222222222222222222222222222222
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

echo "== test-check-owner-approval.sh =="

# ── AC 1: the real CODEOWNERS, last match wins ────────────────────────────────────────────
owner_is() { # <expected> <path>
  assert_green "CODEOWNERS: $2 -> $1" --contains "$1" -- node "$SUBJECT" --codeowners "$CO" --owner-of "$2"
}
owner_is "$OWNER" "apps/api/src/finance/finance.service.ts"
owner_is "$OWNER" "packages/shared/src/utils/money.ts"
owner_is "$OWNER" ".github/workflows/ci.yml"
owner_is "$OWNER" ".github/CODEOWNERS"
owner_is "(unowned)" "apps/web/app/components/ui/button.tsx"
owner_is "(unowned)" "apps/landing/src/main.tsx"
owner_is "(unowned)" "apps/e2e/tests/login.spec.ts"
owner_is "(unowned)" "docs/runbooks/human-only.md"
owner_is "$OWNER" "docs/business/pricing.md"
owner_is "$OWNER" "apps/web/app/lib/route-access.ts"
owner_is "$OWNER" "apps/web/app/routes/_authenticated/finance/components/TransactionsTable.tsx"
owner_is "$OWNER" 'apps/web/app/routes/invoice.v.$transactionId.tsx'
owner_is "$OWNER" "apps/web/Dockerfile"
owner_is "(unowned)" "apps/web/app/lib/route-access.spec.ts"

# Every re-protect line names a path that exists — a rename would silently unprotect it.
assert_green "every CODEOWNERS path exists in the repo" --contains "missing=0" \
  -- node "$SUBJECT" --codeowners "$CO" --check-paths "$REPO"
printf '* @o\napps/web/no-such-file.tsx @o\n' >"$T/gone-co"
assert_red "a CODEOWNERS line on a missing path is refused" --contains "no-such-file.tsx" \
  -- node "$SUBJECT" --codeowners "$T/gone-co" --check-paths "$REPO"

printf '* @o\napps/web/*.tsx\n' >"$T/bad-co"
assert_red "an unsupported CODEOWNERS glob is refused, not guessed" --contains "outside the supported shapes" \
  -- node "$SUBJECT" --codeowners "$T/bad-co" --owner-of apps/web/x.tsx

owner_is "$OWNER" "apps/web/package.json"
owner_is "$OWNER" "apps/e2e/playwright.config.ts"
owner_is "$OWNER" "apps/landing/tsconfig.app.json"
owner_is "$OWNER" "apps/web/vite.config.ts"
owner_is "$OWNER" "apps/web/sub/.npmrc"

# ── AC 2: detection ───────────────────────────────────────────────────────────────────────
# pr <name> <reviews-json> [changedFiles]
pr() { printf '{"headSha":"%s","counts":{"changedFiles":%s},"reviews":%s}\n' "$HEAD" "${3:-1}" "$2" >"$T/$1.pr.json"; }
# mk <name> <filename> <status> [previous_filename] — content (if any) is read from $T/<name>.src
mk() {
  node -e '
    const fs = require("fs"); const [n, f, s, p] = process.argv.slice(1)
    const file = { filename: f, status: s }; if (p) file.previous_filename = p
    fs.writeFileSync(n + ".files.json", JSON.stringify([file]))
    const c = fs.existsSync(n + ".src") ? [{ filename: f, content: fs.readFileSync(n + ".src", "utf8") }] : []
    fs.writeFileSync(n + ".contents.json", JSON.stringify(c))
  ' "$T/$1" "$2" "$3" "${4:-}"
  pr "$1" '[]'
}
src() { printf '%s\n' "$2" >"$T/$1.src"; } # src <name> <content>
run() {
  node "$SUBJECT" --codeowners "$CO" --pr "$T/$1.pr.json" --files "$T/$1.files.json" \
    --contents "$T/$1.contents.json" --owner "$OWNER"
}

src db "import { Pool } from 'pg'"
mk db apps/web/app/lib/x.ts added
assert_red "web file importing pg -> refused" --contains "db-client: apps/web/app/lib/x.ts" -- run db

src drz 'import a from "./a"
import { eq } from "drizzle-orm"'
mk drz apps/e2e/helpers/seed.ts modified
assert_red "e2e file importing drizzle-orm -> refused" --contains "db-client" -- run drz

src multi "import {
  Pool,
} from
  'pg'"
mk multi apps/web/app/lib/m.ts modified
assert_red "BYPASS 1: an import split across lines still matches" --contains "db-client" -- run multi

src rel "import { users } from '../../../api/src/users/users.repo'"
mk rel apps/web/app/lib/r.ts modified
assert_red "BYPASS 1: a relative path resolving into apps/api -> refused" --contains "api-source" \
  --contains "../../../api/src" -- run rel

src rel2 "import x from '../../../api/../api/src/x'"
mk rel2 apps/web/app/lib/r2.ts modified
assert_red "BYPASS 1: a non-normalised relative path into the API -> refused" --contains "api-source" -- run rel2

src dyn 'const name = "p" + "g"
const m = require(name)'
mk dyn apps/landing/src/d.ts modified
assert_red "BYPASS 1: a computed require(...) -> refused" --contains "dynamic-specifier" -- run dyn

src dyn2 'const m = await import(`${base}/database/schema`)'
mk dyn2 apps/web/app/lib/d2.ts modified
assert_red "BYPASS 1: a template-literal import(...) with \${} -> refused" --contains "dynamic-specifier" -- run dyn2

src schema "import { transactions } from '../../../api/src/database/schema'"
mk schema apps/web/app/lib/y.ts modified
assert_red "importing the drizzle schema (a finance table) -> refused" --contains "db-client" -- run schema

src api "const s = require('@crm/api/finance')"
mk api apps/landing/src/z.ts modified
assert_red "require of @crm/api -> refused" --contains "api-source" -- run api

src fin "const m = await import('./payouts.service')"
mk fin apps/web/app/lib/f.ts modified
assert_red "literal dynamic import of a finance service -> refused" --contains "finance: apps/web/app/lib/f.ts" -- run fin

mk ctl apps/web/server/users.controller.ts added
src ctl 'export class X {}'
mk ctl apps/web/server/users.controller.ts added
assert_red "new *.controller.ts file -> refused" --contains "controller: apps/web/server/users.controller.ts" -- run ctl

src deco "@Controller('x')
export class Y {}"
mk deco apps/e2e/mock/server.ts modified
assert_red "@Controller( decorator -> refused" --contains "controller" -- run deco

src mvown 'export const a = 1'
mk mvown apps/web/app/lib/moved.ts renamed apps/api/src/finance/finance.service.ts
assert_red "BYPASS 2: rename out of an owner path into an open zone -> refused" --contains "moved-from-owned" -- run mvown

src mvrp 'export const a = 1'
mk mvrp apps/web/app/lib/moved2.ts renamed apps/web/app/lib/route-access.ts
assert_red "BYPASS 2: rename of a re-protected file -> refused" --contains "moved-from-owned" -- run mvrp

src cpown 'export const a = 1'
mk cpown apps/web/app/lib/copy.ts copied apps/api/src/auth/auth.service.ts
assert_red "BYPASS 2: copy from an owner path -> refused" --contains "moved-from-owned" -- run cpown

src alias '{ "dependencies": { "db": "npm:pg@8.11.0" } }'
mk alias apps/e2e/fixtures/deps.json modified
assert_red "BYPASS 3: an npm: alias to a DB package in an open JSON file -> refused" --contains "dep-alias" -- run alias

src ws '{ "@crm/api": "workspace:*" }'
mk ws apps/landing/src/x.json modified
assert_red "BYPASS 3: a JSON key naming @crm/api -> refused" --contains "dep-alias" -- run ws

mk nocontent apps/web/app/big.ts modified
assert_red "code file whose content was not fetched -> fail closed" --contains "uninspectable" -- run nocontent

src short 'x'
mk short docs/a.md modified
pr short '[]' 2
assert_red "file list shorter than changed_files -> fail closed" --contains "incomplete list" -- run short

pr empty '[]' 0
printf '[]\n' >"$T/empty.files.json"
printf '[]\n' >"$T/empty.contents.json"
assert_red "empty file list -> fail closed" --contains "empty" -- run empty

# fetch plan: unowned inspectable files only
printf '[{"filename":"apps/web/a.ts","status":"modified"},{"filename":"apps/web/app/lib/route-access.ts","status":"modified"},{"filename":"apps/api/src/x.ts","status":"added"},{"filename":"docs/a.md","status":"modified"},{"filename":"apps/web/gone.ts","status":"removed"}]\n' >"$T/plan.json"
assert_green "fetch plan lists only the unowned inspectable file" --contains "apps/web/a.ts" \
  --not-contains "route-access" --not-contains "apps/api" --not-contains "docs/a.md" --not-contains "gone.ts" \
  -- node "$SUBJECT" --codeowners "$CO" --files "$T/plan.json" --fetch-plan

# Approval
src appr "import pg from 'pg'"
mk appr apps/web/app/lib/x.ts added
pr appr "[{\"author\":\"$OWNER\",\"state\":\"APPROVED\",\"commit_id\":\"$HEAD\"}]"
assert_green "owner APPROVED the head -> passes, triggers still listed" --contains "approved head" --contains "db-client" -- run appr

approval_case() { # <name> <reviews-json>
  cp "$T/appr.files.json" "$T/$1.files.json"
  cp "$T/appr.contents.json" "$T/$1.contents.json"
  pr "$1" "$2"
}
approval_case stale "[{\"author\":\"$OWNER\",\"state\":\"APPROVED\",\"commit_id\":\"$OLD\"}]"
assert_red "owner APPROVED an older commit -> refused" --contains "needs an APPROVE" -- run stale
approval_case other "[{\"author\":\"someone-else\",\"state\":\"APPROVED\",\"commit_id\":\"$HEAD\"}]"
assert_red "another user's APPROVE -> refused" --contains "needs an APPROVE" -- run other
approval_case retract "[{\"author\":\"$OWNER\",\"state\":\"APPROVED\",\"commit_id\":\"$HEAD\"},{\"author\":\"$OWNER\",\"state\":\"CHANGES_REQUESTED\",\"commit_id\":\"$HEAD\"}]"
assert_red "owner's later CHANGES_REQUESTED wins over his APPROVE -> refused" --contains "needs an APPROVE" -- run retract
approval_case cmt "[{\"author\":\"$OWNER\",\"state\":\"APPROVED\",\"commit_id\":\"$HEAD\"},{\"author\":\"$OWNER\",\"state\":\"COMMENTED\",\"commit_id\":\"$HEAD\"}]"
assert_green "a later COMMENTED review does not retract the APPROVE" --contains "approved head" -- run cmt

# Negatives: what must NOT trip
src ui "import { TransactionsTable } from './TransactionsTable'
import { z } from 'zod'
import { api } from '@/lib/axios'
const Page = lazy(() => import('./page'))
// a comment mentioning await import(path) is prose
const t = require('./t')"
mk ui apps/web/app/components/x.tsx modified
assert_green "UI file with ordinary / literal imports -> passes" --contains "no trigger" -- run ui

src reprot "import pg from 'pg'"
mk reprot apps/web/app/lib/route-access.ts modified
assert_green "re-protected file is CODEOWNERS' job, not scanned" --contains "unowned-scanned=0" -- run reprot

src backend "import pg from 'pg'"
mk backend apps/api/src/users/users.controller.ts added
assert_green "owner-owned API file is not scanned" --contains "unowned-scanned=0" -- run backend

src md "import pg from 'pg'"
mk md docs/notes.md modified
assert_green "markdown is not inspected -> passes" --contains "no trigger" -- run md

src mvopen 'export const a = 1'
mk mvopen apps/web/app/a2.ts renamed apps/web/app/a.ts
assert_green "rename inside the open zone -> passes" --contains "no trigger" -- run mvopen

mk rm apps/web/app/old.controller.ts removed
assert_green "removing a controller -> passes" --contains "no trigger" -- run rm

src json '{ "dependencies": { "zod": "^4.0.0", "pgx": "1.0.0" } }'
mk json apps/e2e/fixtures/ok.json modified
assert_green "JSON without DB / API dependency names -> passes" --contains "no trigger" -- run json

guard_test_summary "test-check-owner-approval.sh"
