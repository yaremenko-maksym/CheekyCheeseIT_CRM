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
case_red cp apps/e2e/helpers/cp.ts modified "import { exec } from 'child_process'" "Node built-in child_process" \
  "e2e: a child_process import -> refused"
case_red nmod apps/e2e/helpers/nm.ts modified "import { createRequire as c } from 'module'" "Node built-in module" \
  "e2e: an import of 'module' (renamed binding) -> refused"

# Master addendum 4: Node built-ins via isBuiltin(); e2e allowlist; Reflect; globals passed as values
case_red webfs apps/web/app/lib/fs.ts modified "import { readFileSync } from 'node:fs'" "Node built-in node:fs" \
  "web: node:fs -> refused (browser code may import no built-in)"
case_red webpath apps/landing/src/p.ts modified "import path from 'path'" "Node built-in path" \
  "landing: a bare built-in (path) -> refused"
case_red e2evm apps/e2e/helpers/vm.ts modified "import vm from 'node:vm'" "Node built-in node:vm" "e2e: node:vm -> refused"
case_red e2ewt apps/e2e/helpers/wt.ts modified "import { Worker } from 'worker_threads'" "Node built-in worker_threads" \
  "e2e: bare worker_threads -> refused"
case_red e2eins apps/e2e/helpers/in.ts modified "const i = await import('node:inspector')" "Node built-in node:inspector" \
  "e2e: a literal import() of node:inspector -> refused"
case_red e2enet apps/e2e/helpers/net.ts modified "import net from 'node:net'" "Node built-in node:net" \
  "e2e: node:net (already used, not allowlisted) -> refused"
case_red e2efake apps/e2e/helpers/fk.ts modified "import x from 'node:nope'" "Node built-in node:nope" \
  "e2e: an unknown node: specifier -> refused"
src e2eok "import { readFileSync } from 'node:fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'node:url'
import os from 'os'
import { randomUUID } from 'node:crypto'"
mk e2eok apps/e2e/helpers/ok.ts modified
assert_green "e2e: fs / fs/promises / path / url / os / crypto are allowed" --contains "[not-required]" -- run e2eok
assert_green "E2E_BUILTINS is exactly fs, path, url, os, crypto" --contains '["fs","path","url","os","crypto"]' \
  -- env S="$SUBJECT" node --input-type=module -e "const m = await import(process.env.S); console.log(JSON.stringify(m.E2E_BUILTINS))"
case_red rget apps/web/app/lib/rg.ts modified "const r = Reflect.get(o, k)" "Reflect.get" "Reflect.get -> refused"
case_red rapply apps/web/app/lib/rp.ts modified "Reflect.apply(f, null, [])" "Reflect.apply" "Reflect.apply -> refused"
case_red rcons apps/web/app/lib/rc.ts modified "Reflect.construct(F, [])" "Reflect.construct" "Reflect.construct -> refused"
case_red rcomp apps/web/app/lib/rx.ts modified "Reflect['get'](o, k)" "Reflect[...]" "Reflect['get'] -> refused"
case_red gval apps/web/app/lib/gv.ts modified "const g = self" "\`self\` passed as a value" "const g = self -> refused"
case_red garg apps/web/app/lib/ga.ts modified "inspect(window)" "\`window\` passed as a value" "f(window) -> refused"
case_red gobj apps/web/app/lib/go.ts modified "Object.entries(globalThis)" "\`globalThis\` passed as a value" \
  "Object.entries(globalThis) -> refused"
case_red gtern apps/web/app/lib/gt.ts modified "let g; g = ok ? window : null" "\`window\` passed as a value" \
  "a global through ?: into an assignment -> refused"
case_red gprop2 apps/web/app/lib/gq.ts modified "const o = { w: global }" "\`global\` passed as a value" \
  "a global as a property value -> refused"
case_red gret apps/web/app/lib/gr.ts modified "export const f = () => globalThis" "\`globalThis\` passed as a value" \
  "a global returned from an arrow -> refused"
src gok "const href = window.location.href
if (typeof window !== 'undefined') window.addEventListener('resize', onResize)
const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
const w = window.innerWidth"
mk gok apps/web/app/components/g.tsx modified
assert_green "plain window / globalThis member reads are NOT triggers (trade-off)" --contains "[not-required]" -- run gok
# Master addendum 5 item 3: a property NAMED like the global object is the global object; a
# property named like a loader is a trigger whatever the receiver.
case_red galias1 apps/web/app/lib/ga1.ts modified "const p = a.globalThis.process" "a.globalThis.process" \
  "a.globalThis.process (any receiver) -> refused"
case_red galias2 apps/web/app/lib/ga2.ts modified "const g = window.self" "\`window.self\` (global object) passed as a value" \
  "const g = window.self -> refused"
case_red galias3 apps/web/app/lib/ga3.ts modified "const g = document.defaultView" \
  "\`document.defaultView\` (global object) passed as a value" "const g = document.defaultView -> refused"
case_red galias4 apps/web/app/lib/ga4.ts modified "const r = x.top['require']" "x.top[...] (computed global member)" \
  "x.top['require'] (computed member of a global alias) -> refused"
case_red galias5 apps/web/app/lib/ga5.ts modified "const m = x.getBuiltinModule('fs')" "x.getBuiltinModule" \
  "x.getBuiltinModule (any receiver) -> refused"
case_red galias6 apps/web/app/lib/ga6.ts modified "const r = cfg['require']" "cfg['require']" \
  "a literal element access named require -> refused"
case_red galias7 apps/web/app/lib/ga7.ts modified "use(a.parent)" "\`a.parent\` (global object) passed as a value" \
  "f(a.parent) -> refused (trade-off: tree nodes named parent are flagged too)"
# Item 6: isGlobalExpr sees through , / ?? / || / && / ?: ; a non-literal key on a receiver that is
# not provably local is a trigger.
case_red gwrap1 apps/web/app/lib/gw1.ts modified "const k = 'process'; const p = (0, globalThis)[k]" \
  "computed global member" "(0, globalThis)[k] -> refused"
case_red gwrap2 apps/web/app/lib/gw2.ts modified "const x = null; const k = 'process'; const p = (x ?? window)[k]" \
  "computed global member" "(x ?? window)[k] -> refused"
case_red gwrap3 apps/web/app/lib/gw3.ts modified "const c = true, o = {}, k = 'process'; const p = (c ? self : o)[k]" \
  "computed global member" "(c ? self : o)[k] -> refused"
case_red gfree apps/web/app/lib/gf.ts modified "const k = 'x'; const v = someGlobal[k]" \
  "someGlobal[<non-literal>] (receiver not provably local)" "a free name with a non-literal key -> refused"
case_red gfree2 apps/web/app/lib/gf2.ts modified "const o = {}, k = 'x'; const v = (o || other).a[k]" \
  "receiver not provably local" "(local || free).a[k] -> refused"
src glocal "import { rows } from './rows'
export function pick(items: string[], i: number, props: { m: Record<string, number> }, key: string) {
  const map = new Map<string, number>()
  return [items[i], props.m[key], rows[i], rows[0], (rows ?? [])[1], map.get(key)]
}"
mk glocal apps/web/app/components/gl.tsx modified
assert_green "non-literal keys on parameters / imports, numeric keys anywhere are NOT triggers" \
  --contains "[not-required]" -- run glocal
src galiasok "const top = 10
const parent = getParent()
const h = window.location.href
const y = rect.top + window.scrollY
if (node.parent) walk(node.parent.children)"
mk galiasok apps/web/app/components/ga.tsx modified
assert_green "local top / parent, member reads of .top / .parent, window.location.href are NOT triggers" \
  --contains "[not-required]" -- run galiasok
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
review() { # <author> <state> <body> [commit_id] [edited: true|false|absent]
  node -e 'const [author, state, body, commit_id, e] = process.argv.slice(1); const r = { author, state, body, commit_id }
    if (e !== "absent") r.edited = e === "true"; console.log(JSON.stringify(r))' "$1" "$2" "$3" "${4:-$HEAD}" "${5:-false}"
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
const v = cfg.processing"
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

# ── owner-verdict-decide.sh (Master addendum 5 item 2): fails closed ─────────────────────
DECIDE="$GUARD_DIR/owner-verdict-decide.sh"
STUB="$T/stub-gh"
# The stub answers any `gh api ...` with the file $STUB_OUT, exits $STUB_RC, logs argv to $STUB_LOG.
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >>"${STUB_LOG:-/dev/null}"' \
  'if [ -n "${STUB_OUT:-}" ]; then cat "$STUB_OUT"; fi' 'exit "${STUB_RC:-0}"' >"$STUB"
chmod +x "$STUB"
DD="$T/decide"
mkdir -p "$DD"
printf '{"headSha":"%s"}\n' "$HEAD" >"$DD/pr.json"
printf '[{"filename":"apps/web/app/x.ts"}]\n' >"$DD/files.json"
printf 'ready\n' >"$T/labels-clean"
printf 'ready\ndo-not-merge\n' >"$T/labels-block"
decide() { # <status> <stub-rc> <labels-file>
  env STATUS="$1" HEAD_SHA="$HEAD" D="$DD" REPO=acme/crm PR_NUMBER=7 GH_BIN="$STUB" \
    STUB_RC="$2" STUB_OUT="$3" GITHUB_OUTPUT= bash "$DECIDE"
}
assert_green "Decide: approved, clean labels -> go=true" --contains "go=true" -- decide approved 0 "$T/labels-clean"
assert_green "Decide: labels API fails -> go=false (fails closed)" --contains "go=false" \
  --contains "could not read the PR labels" -- decide approved 1 ""
assert_green "Decide: do-not-merge label -> go=false" --contains "go=false" -- decide approved 0 "$T/labels-block"
assert_green "Decide: status missing -> go=false" --contains "go=false" -- decide missing 0 "$T/labels-clean"
printf '{"headSha":"%s"}\n' "$OLD" >"$DD/pr.json"
assert_green "Decide: head moved -> go=false" --contains "go=false" --contains "head moved" \
  -- decide approved 0 "$T/labels-clean"
printf '{"headSha":"%s"}\n' "$HEAD" >"$DD/pr.json"
printf 'not json\n' >"$DD/files.json"
assert_green "Decide: files.json unreadable -> go=false" --contains "go=false" -- decide approved 0 "$T/labels-clean"
printf '[{"filename":".github/workflows/ci.yml"}]\n' >"$DD/files.json"
assert_green "Decide: a workflow file -> go=false (manual merge)" --contains "go=false" \
  -- decide approved 0 "$T/labels-clean"

# ── owner-verdict-wait-checks.sh (item 1): waits on the check runs of HEAD_SHA ─────────────
WAIT="$GUARD_DIR/owner-verdict-wait-checks.sh"
run_json() { # <name> <status> <conclusion-json> [app_id]
  printf '{"name":"%s","status":"%s","conclusion":%s,"started_at":"2026-11-28T00:00:00Z","app_id":%s}\n' \
    "$1" "$2" "$3" "${4:-15368}"
}
{ run_json "CI" completed '"success"'; run_json "Owner Verdict" completed '"success"'; } >"$T/runs-green"
{ run_json "CI" completed '"failure"'; run_json "Owner Verdict" completed '"success"'; } >"$T/runs-red"
{ run_json "CI" completed '"success"'; run_json "Owner Verdict" completed '"success"' 99; } >"$T/runs-otherapp"
{ run_json "CI" completed '"success"'; run_json "Owner Verdict" in_progress null; } >"$T/runs-pending"
run_json "CI" completed '"success"' >"$T/runs-missing"
wait_checks() { # <runs-file> <stub-rc>
  env REPO=acme/crm HEAD_SHA="$HEAD" REQUIRED_CONTEXTS="CI
Owner Verdict" GH_BIN="$STUB" STUB_OUT="$1" STUB_RC="$2" STUB_LOG="$T/wait.log" \
    INTERVAL_SECONDS=0 TIMEOUT_SECONDS=0 bash "$WAIT"
}
rm -f "$T/wait.log"
assert_green "Wait: all required contexts green on HEAD_SHA -> merge" --contains "all required checks are green" \
  -- wait_checks "$T/runs-green" 0
assert_green "Wait: it reads commits/<HEAD_SHA>/check-runs, not the PR's checks" \
  --contains "commits/$HEAD/check-runs" --not-contains "pr checks" -- cat "$T/wait.log"
assert_red "Wait: a failed required check -> refused" --contains "fail:failure CI" -- wait_checks "$T/runs-red" 0
assert_red "Wait: a required context with no run on HEAD_SHA -> not green at the timeout" \
  --contains "pending Owner Verdict (no run on this commit)" -- wait_checks "$T/runs-missing" 0
assert_red "Wait: a run still in progress -> not green at the timeout" \
  --contains "pending Owner Verdict (in_progress)" -- wait_checks "$T/runs-pending" 0
assert_red "Wait: a look-alike from another app does not count" \
  --contains "pending Owner Verdict (no run on this commit)" -- wait_checks "$T/runs-otherapp" 0
assert_red "Wait: the API read fails -> not green (transient, then timeout)" \
  --contains "check-runs read failed" -- wait_checks "$T/runs-green" 1

guard_test_summary "test-check-owner-approval.sh"
