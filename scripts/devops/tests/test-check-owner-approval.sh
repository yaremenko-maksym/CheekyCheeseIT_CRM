#!/usr/bin/env bash
# test-check-owner-approval.sh — both directions for the `Owner Verdict` required check:
# the real .github/CODEOWNERS resolves open / re-protected paths as intended (last match wins);
# the critical-zone list is a superset of the Flow Gate's; a non-owner PR that touches a zone, or
# whose unowned files reach the DB / API / a finance module, add a controller or defeat the AST
# scan (one case per named bypass), stays red until a fresh `Owner Verdict: APPROVE` review by the
# owner; owner-authored and clean PRs pass; every fail-closed path refuses.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/check-owner-approval.mjs"
ZONES="$GUARD_DIR/owner-verdict-zones.json"
REPO="$(cd "$GUARD_DIR/../.." && pwd)"
CO="$REPO/.github/CODEOWNERS"
OWNER=yaremenko-maksym
AUTHOR=some-manager
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
owner_is "$OWNER" "apps/web/package.json"
owner_is "$OWNER" "apps/e2e/playwright.config.ts"
owner_is "$OWNER" "apps/landing/tsconfig.app.json"
owner_is "$OWNER" "apps/web/vite.config.ts"
owner_is "$OWNER" "apps/web/sub/.npmrc"
owner_is "$OWNER" "apps/web/index.html"
owner_is "$OWNER" "apps/landing/.babelrc.json"
owner_is "$OWNER" "apps/e2e/jsconfig.json"

# Every re-protect line names a path that exists — a rename would silently unprotect it.
assert_green "every CODEOWNERS path exists in the repo" --contains "missing=0" \
  -- node "$SUBJECT" --codeowners "$CO" --check-paths "$REPO"
printf '* @o\napps/web/no-such-file.tsx @o\n' >"$T/gone-co"
assert_red "a CODEOWNERS line on a missing path is refused" --contains "no-such-file.tsx" \
  -- node "$SUBJECT" --codeowners "$T/gone-co" --check-paths "$REPO"
printf '* @o\napps/web/*.tsx\n' >"$T/bad-co"
assert_red "an unsupported CODEOWNERS glob is refused, not guessed" --contains "outside the supported shapes" \
  -- node "$SUBJECT" --codeowners "$T/bad-co" --owner-of apps/web/x.tsx

# ── the zones data file ───────────────────────────────────────────────────────────────────
zones_check() { # <mode>
  node --input-type=module -e '
    import { readFileSync } from "node:fs"
    const [mode, zonesPath, flowGate, subject, co] = process.argv.slice(1)
    const zones = JSON.parse(readFileSync(zonesPath, "utf8")).zones.map((z) => z.glob)
    if (mode === "superset") {
      const { CRITICAL_PATH_GLOBS } = await import(flowGate)
      const miss = CRITICAL_PATH_GLOBS.filter((g) => !zones.includes(g))
      console.log(`flow-gate globs=${CRITICAL_PATH_GLOBS.length} missing=${miss.length} ${miss.join(" ")}`)
      process.exit(miss.length ? 1 : 0)
    }
    const { parseCodeowners } = await import(subject)
    const web = parseCodeowners(readFileSync(co, "utf8")).filter(
      (r) => r.owners.length && (r.kind === "file" || r.kind === "dir") && (r.file ?? r.dir).startsWith("apps/web/app/"))
    const miss = web.filter((r) => !zones.includes(r.file ?? `${r.dir}**`))
    console.log(`web re-protect lines=${web.length} missing=${miss.length} ${miss.map((r) => r.pattern).join(" ")}`)
    process.exit(miss.length || web.length === 0 ? 1 : 0)
  ' "$1" "$ZONES" "$REPO/scripts/architect/flow-gate.mjs" "$SUBJECT" "$CO"
}
assert_green "zones are a superset of flow-gate CRITICAL_PATH_GLOBS (contracts.md 2.1)" --contains "missing=0" \
  -- zones_check superset
assert_green "every apps/web auth/finance re-protect line is a critical zone" --contains "missing=0" \
  -- zones_check coverage

# ── AC 2 + owner requirement: the gate ────────────────────────────────────────────────────
# pr <name> <reviews-json> [changedFiles] [author]
pr() {
  printf '{"headSha":"%s","author":"%s","counts":{"changedFiles":%s},"reviews":%s}\n' \
    "$HEAD" "${4-$AUTHOR}" "${3:-1}" "$2" >"$T/$1.pr.json"
}
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
  node "$SUBJECT" --codeowners "$CO" --zones "$ZONES" --tsconfig-root "$REPO" --pr "$T/$1.pr.json" \
    --files "$T/$1.files.json" --contents "$T/$1.contents.json" --owner "$OWNER" ${2:+--json}
}
case_red() { # <name> <file> <status> <content> <expected-kind> <desc> [prev]
  src "$1" "$4"
  mk "$1" "$2" "$3" "${7:-}"
  assert_red "$6" --contains "$5" --contains "[missing]" -- run "$1"
}

# Detections (AC 2)
case_red db apps/web/app/lib/x.ts added "import { Pool } from 'pg'" "db-client: apps/web/app/lib/x.ts" \
  "web file importing pg -> refused"
case_red drz apps/e2e/helpers/seed.ts modified $'import a from "./a"\nimport { eq } from "drizzle-orm"' "db-client" \
  "e2e file importing drizzle-orm -> refused"
case_red schema apps/web/app/lib/y.ts modified "import { transactions } from '../../../api/src/database/schema'" \
  "api-source" "importing the drizzle schema (a finance table) -> refused"
case_red api apps/landing/src/z.ts modified "import s from '@crm/api/finance'" "api-source" \
  "import of @crm/api -> refused"
case_red fin apps/web/app/lib/f.ts modified "const m = await import('./payouts.service')" "finance: apps/web/app/lib/f.ts" \
  "literal dynamic import of a finance service -> refused"
case_red ctl apps/web/server/users.controller.ts added 'export class X {}' "controller: apps/web/server/users.controller.ts" \
  "new *.controller.ts file -> refused"
case_red deco apps/e2e/mock/server.ts modified $'@Controller(\'x\')\nexport class Y {}' "controller" \
  "@Controller(...) decorator -> refused"

# The named bypasses (Master addenda 1 + 2), one case each
case_red multi apps/web/app/lib/m.ts modified $'import {\n  Pool,\n} from\n  \'pg\'' "db-client" \
  "BYPASS multi-line import -> refused"
case_red rel apps/web/app/lib/r.ts modified "import { users } from '../../../api/src/users/users.repo'" "api-source" \
  "BYPASS relative ../../api/src -> refused"
case_red rel2 apps/web/app/lib/r2.ts modified "import x from '../../../api/../api/src/x'" "api-source" \
  "BYPASS non-normalised relative path into the API -> refused"
case_red mvown apps/web/app/lib/moved.ts renamed 'export const a = 1' "moved-from-owned" \
  "BYPASS rename from an owned path -> refused" apps/api/src/users/users.service.ts
case_red cpown apps/web/app/lib/copy.ts copied 'export const a = 1' "moved-from-owned" \
  "BYPASS copy from an owned path -> refused" apps/api/src/users/users.service.ts
case_red tpl apps/web/app/lib/d2.ts modified 'const m = require(`${base}/database/schema`)' "loader-alias" \
  "BYPASS template-literal require -> refused"
case_red dyn apps/landing/src/d.ts modified $'const name = "p" + "g"\nconst m = require(name)' "loader-alias" \
  "BYPASS computed require(name) -> refused"
case_red ralias apps/web/app/lib/ra.ts modified $'const r = require\nr(\'pg\')' "loader-alias" \
  "BYPASS const r = require; r('x') -> refused"
case_red creq apps/e2e/helpers/cr.ts modified $'import { createRequire } from "node:module"\nconst q = createRequire(import.meta.url)\nq("pg")' \
  "loader-alias" "BYPASS createRequire -> refused"
case_red mreq apps/e2e/helpers/mr.cjs modified "module.require('pg')" "loader-alias" \
  "BYPASS module.require -> refused"
case_red glob apps/web/app/lib/g.ts modified "const mods = import.meta.glob('../../../api/src/**/*.ts')" "loader-alias" \
  "BYPASS import.meta.glob -> refused"
case_red at apps/web/app/lib/at.ts modified "import { x } from '@/../../api/src/finance/finance.service'" "api-source" \
  "BYPASS alias @/ resolving into the API -> refused"
case_red tilde apps/web/app/lib/tl.ts modified "import { x } from '~/db'" "unresolved-specifier" \
  "BYPASS alias ~/ with no tsconfig path -> refused (fail closed)"
case_red html apps/web/public/evil.html added '<script src="/api/x"></script>' "non-inert-file-type" \
  "BYPASS an .html file in an open zone -> refused"
case_red mdx docs/page.mdx added 'import pg from "pg"' "non-inert-file-type" \
  "an .mdx file -> refused (not parsed, not inert)"
case_red unk apps/web/app/x.weird added 'x' "non-inert-file-type" "an unknown extension -> refused"
case_red ev apps/web/app/lib/ev.ts modified "eval('1')" "eval" "eval(...) -> refused"
case_red nf apps/web/app/lib/nf.ts modified "const f = new Function('return 1')" "eval" "new Function -> refused"
case_red ctor apps/web/app/lib/ct.ts modified "const f = (()=>{}).constructor('return 1')" "eval" \
  ".constructor(...) -> refused"
case_red bad apps/web/app/lib/bad.ts modified 'import { from' "unparseable" "a file that does not parse -> refused"

# Master addendum 3: inverted loader detection — only a literal static ESM import is allowed
case_red lreq apps/web/app/lib/lr.ts modified "const t = require('./t')" "reference to \`require\`" \
  "a literal require('./t') is a trigger too"
case_red proc apps/e2e/helpers/p.ts modified "const b = process.binding('fs')" "reference to \`process\`" \
  "a reference to process -> refused"
case_red modx apps/landing/src/mx.cjs modified "module.exports = {}" "reference to \`module\`" \
  "a reference to module -> refused"
case_red expo apps/landing/src/ex.cjs modified "exports.a = 1" "reference to \`exports\`" \
  "a reference to exports -> refused"
case_red nwr apps/web/app/lib/nw.ts modified "const x = __non_webpack_require__('pg')" "__non_webpack_require__" \
  "__non_webpack_require__ -> refused"
case_red short_proc apps/web/app/lib/sp.ts modified "const o = { process }" "reference to \`process\`" \
  "a shorthand { process } is a reference -> refused"
case_red gcomp apps/web/app/lib/gc.ts modified "const r = globalThis['req' + 'uire']" "globalThis[...]" \
  "a computed member of globalThis -> refused"
case_red wcomp apps/web/app/lib/wc.ts modified "const r = window[name]" "window[...]" \
  "a computed member of window -> refused"
case_red gprop apps/web/app/lib/gp.ts modified "const r = self.eval" "self.eval" "self.eval -> refused"
case_red nodefs apps/e2e/helpers/fs.ts modified "import { readFileSync } from 'node:fs'" "module specifier node:fs" \
  "a node:* import -> refused"
case_red cp apps/e2e/helpers/cp.ts modified "import { exec } from 'child_process'" "module specifier child_process" \
  "a child_process import -> refused"
case_red nmod apps/e2e/helpers/nm.ts modified "import { createRequire as c } from 'module'" "module specifier module" \
  "an import of 'module' (renamed binding) -> refused"
case_red ieq apps/web/app/lib/ie.ts modified "import x = require('./x')" "import = require" \
  "import x = require(...) -> refused"
case_red ctor2 apps/web/app/lib/c2.ts modified "const f = ''['constructor']['constructor']('return 1')" "eval" \
  "a ['constructor'] call -> refused"

printf '* @o\napps/**\n' >"$T/open-co"
src pj '{ "dependencies": { "db": "npm:pg@8" } }'
mk pj apps/web/package.json modified
assert_red "BYPASS an unowned package.json (npm: alias) is a trigger, even without CODEOWNERS" \
  --contains "non-inert-file-type: apps/web/package.json" -- node "$SUBJECT" --codeowners "$T/open-co" \
  --zones "$ZONES" --pr "$T/pj.pr.json" --files "$T/pj.files.json" --contents "$T/pj.contents.json" --owner "$OWNER"

mk nocontent apps/web/app/big.ts modified
assert_red "code file whose content was not fetched -> fail closed" --contains "uninspectable" -- run nocontent

# Critical zones (owner requirement 1)
zone_red() { # <name> <file> <zone>
  mk "$1" "$2" modified
  assert_red "zone $3: $2 -> refused without a verdict" --contains "zone:$3" -- run "$1"
}
zone_red zr apps/web/app/lib/route-access.ts rbac
zone_red zw .github/workflows/ci.yml pipeline
zone_red zh .claude/hooks/pre-bash-x.sh pipeline
zone_red zs .claude/settings.json pipeline
zone_red zf apps/api/src/finance/finance.service.ts finance
zone_red zg apps/api/src/users/users.guard.ts auth
zone_red zm apps/api/drizzle/0001_x.sql migrations-schema
zone_red zself scripts/devops/owner-verdict-zones.json pipeline
mk zmv apps/web/app/lib/x.ts renamed apps/web/app/context/auth.tsx
assert_red "zone hit through previous_filename of a rename -> refused" --contains "zone:auth" -- run zmv

# Fail-closed inputs
src short 'x'
mk short docs/a.md modified
pr short '[]' 2
assert_red "file list shorter than changed_files -> fail closed" --contains "incomplete list" -- run short
pr empty '[]' 0
printf '[]\n' >"$T/empty.files.json"
printf '[]\n' >"$T/empty.contents.json"
assert_red "empty file list -> fail closed" --contains "empty" -- run empty
mk noauth docs/a.md modified
pr noauth '[]' 1 ''
assert_red "no PR author -> fail closed" --contains "no PR author" -- run noauth

# fetch plan: unowned non-removed code files only
printf '[{"filename":"apps/web/a.ts","status":"modified"},{"filename":"apps/web/app/lib/route-access.ts","status":"modified"},{"filename":"apps/api/src/x.ts","status":"added"},{"filename":"docs/a.md","status":"modified"},{"filename":"apps/web/gone.ts","status":"removed"}]\n' >"$T/plan.json"
assert_green "fetch plan lists only the unowned code file" --contains "apps/web/a.ts" \
  --not-contains "route-access" --not-contains "apps/api" --not-contains "docs/a.md" --not-contains "gone.ts" \
  -- node "$SUBJECT" --codeowners "$CO" --files "$T/plan.json" --fetch-plan

# Verdict parsing (owner requirement 2 + 5): fresh / stale / BLOCK / non-owner / owner-authored
src v "import pg from 'pg'"
mk v apps/web/app/lib/x.ts added
review() { # <author> <state> <body> [commit_id]
  node -e 'console.log(JSON.stringify({ author: process.argv[1], state: process.argv[2], body: process.argv[3], commit_id: process.argv[4] }))' "$1" "$2" "$3" "${4:-$HEAD}"
}
verdict_case() { # <name> <reviews-json> [author]
  cp "$T/v.files.json" "$T/$1.files.json"
  cp "$T/v.contents.json" "$T/$1.contents.json"
  pr "$1" "$2" 1 "${3:-$AUTHOR}"
}
FRESH="$(review "$OWNER" COMMENTED $'Owner Verdict: APPROVE\n\nCommit: '"$HEAD")"
verdict_case fresh "[$FRESH]"
assert_green "fresh owner APPROVE (COMMENT review) on head -> passes, triggers listed" --contains "[approved]" \
  --contains "db-client" -- run fresh
verdict_case short7 "[$(review "$OWNER" APPROVED $'Owner Verdict: APPROVE\nCommit: `1111111`')]"
assert_red "a 7-char Commit: prefix is rejected (full 40 hex only)" --contains "[stale]" -- run short7
verdict_case stale "[$(review "$OWNER" COMMENTED $'Owner Verdict: APPROVE\nCommit: '"$OLD")]"
assert_red "APPROVE for an older commit (push after verdict) -> stale" --contains "[stale]" -- run stale
verdict_case cid "[$(review "$OWNER" COMMENTED $'Owner Verdict: APPROVE\nCommit: '"$HEAD" "$OLD")]"
assert_red "Commit: names the head but the review's commit_id is older -> stale" --contains "[stale]" \
  --contains "submitted on 2222222" -- run cid
verdict_case nocid "[$(review "$OWNER" COMMENTED $'Owner Verdict: APPROVE\nCommit: '"$HEAD" null)]"
assert_red "review with no commit_id -> stale" --contains "[stale]" -- run nocid
verdict_case nocommit "[$(review "$OWNER" COMMENTED 'Owner Verdict: APPROVE')]"
assert_red "APPROVE without a Commit: line -> stale" --contains "[stale]" -- run nocommit
verdict_case block "[$FRESH,$(review "$OWNER" COMMENTED $'Owner Verdict: BLOCK\nCommit: '"$HEAD")]"
assert_red "a newer Owner Verdict: BLOCK wins -> refused" --contains "[blocked]" -- run block
verdict_case reapprove "[$(review "$OWNER" COMMENTED 'Owner Verdict: BLOCK'),$FRESH]"
assert_green "an APPROVE after a BLOCK wins" --contains "[approved]" -- run reapprove
verdict_case later "[$FRESH,$(review "$OWNER" COMMENTED 'looks fine, small nit')]"
assert_green "a later owner review without the marker does not retract" --contains "[approved]" -- run later
verdict_case other "[$(review someone-else COMMENTED $'Owner Verdict: APPROVE\nCommit: '"$HEAD")]"
assert_red "a non-owner's verdict does not count" --contains "[missing]" -- run other
verdict_case notfirst "[$(review "$OWNER" COMMENTED $'LGTM\nOwner Verdict: APPROVE\nCommit: '"$HEAD")]"
assert_red "the marker not on the first line does not count" --contains "[missing]" -- run notfirst
verdict_case cr "[$(review "$OWNER" CHANGES_REQUESTED $'Owner Verdict: APPROVE\nCommit: '"$HEAD")]"
assert_red "APPROVE text in a CHANGES_REQUESTED review -> refused" --contains "[missing]" -- run cr
verdict_case dism "[$(review "$OWNER" DISMISSED $'Owner Verdict: APPROVE\nCommit: '"$HEAD")]"
assert_red "a DISMISSED review does not count" --contains "[missing]" -- run dism
verdict_case own '[]' "$OWNER"
assert_green "owner-authored PR passes without a verdict" --contains "[owner-authored]" -- run own
assert_green "--json carries the status for the merge workflow" --contains '"status":"approved"' -- run fresh json

# Negatives: what must NOT trip
src ui "import { TransactionsTable } from './TransactionsTable'
import { z } from 'zod'
import { api } from '@/lib/axios'
const Page = lazy(() => import('./page'))
// a comment mentioning require(name) and import.meta.glob is prose, not code
const u = import.meta.env.VITE_X
const cfg = { module: 'x', require: false }
const v = cfg.process"
mk ui apps/web/app/components/x.tsx modified
assert_green "UI file with ordinary / literal imports -> passes" --contains "[not-required]" -- run ui
src reprot "import pg from 'pg'"
mk reprot apps/web/app/components/stats/FinanceChart.tsx modified
pr reprot '[]' 1 "$OWNER"
assert_green "owner-authored PR on a re-protected zone file passes" --contains "unowned-scanned=0" -- run reprot
src md "import pg from 'pg'"
mk md docs/notes.md modified
assert_green "markdown is inert -> passes" --contains "[not-required]" -- run md
src mvopen 'export const a = 1'
mk mvopen apps/web/app/a2.ts renamed apps/web/app/a.ts
assert_green "rename inside the open zone -> passes" --contains "[not-required]" -- run mvopen
mk rm apps/web/app/old.controller.ts removed
assert_green "removing a controller -> passes" --contains "[not-required]" -- run rm
src json '{ "dependencies": { "pg": "8" } }'
mk json apps/e2e/fixtures/ok.json modified
assert_green "plain data JSON is inert -> passes" --contains "[not-required]" -- run json

guard_test_summary "test-check-owner-approval.sh"
