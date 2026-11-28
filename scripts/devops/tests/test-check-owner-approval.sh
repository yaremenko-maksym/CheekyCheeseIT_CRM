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
case_red nf apps/web/app/lib/nf.ts modified "const f = new Function('return 1')" "denied name \`Function\`" "new Function -> refused"
case_red ctor apps/web/app/lib/ct.ts modified "const f = (()=>{}).constructor('return 1')" "denied name \`constructor\`" \
  ".constructor(...) -> refused"
case_red bad apps/web/app/lib/bad.ts modified 'import { from' "unparseable" "a file that does not parse -> refused"

# Master addendum 3: inverted loader detection — only a literal static ESM import is allowed
case_red lreq apps/web/app/lib/lr.ts modified "const t = require('./t')" "reference to \`require\`" \
  "a literal require('./t') is a trigger too"
case_red proc apps/e2e/helpers/p.ts modified "const b = process.binding('fs')" "denied name \`process\`" \
  "a reference to process -> refused"
case_red modx apps/landing/src/mx.cjs modified "module.exports = {}" "reference to \`module\`" \
  "a reference to module -> refused"
case_red expo apps/landing/src/ex.cjs modified "exports.a = 1" "reference to \`exports\`" \
  "a reference to exports -> refused"
case_red nwr apps/web/app/lib/nw.ts modified "const x = __non_webpack_require__('pg')" "__non_webpack_require__" \
  "__non_webpack_require__ -> refused"
case_red short_proc apps/web/app/lib/sp.ts modified "const o = { process }" "denied name \`process\`" \
  "a shorthand { process } is a reference -> refused"
case_red gcomp apps/web/app/lib/gc.ts modified "const r = globalThis['req' + 'uire']" "globalThis[...]" \
  "a computed member of globalThis -> refused"
case_red wcomp apps/web/app/lib/wc.ts modified "const r = window[name]" "window[...]" \
  "a computed member of window -> refused"
case_red gprop apps/web/app/lib/gp.ts modified "const r = self.eval" "denied name \`eval\`" "self.eval -> refused"
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
case_red rget apps/web/app/lib/rg.ts modified "const r = Reflect.get(o, k)" "denied name \`Reflect\`" "Reflect.get -> refused"
case_red rapply apps/web/app/lib/rp.ts modified "Reflect.apply(f, null, [])" "denied name \`Reflect\`" "Reflect.apply -> refused"
case_red rcons apps/web/app/lib/rc.ts modified "Reflect.construct(F, [])" "denied name \`Reflect\`" "Reflect.construct -> refused"
case_red rcomp apps/web/app/lib/rx.ts modified "Reflect['get'](o, k)" "denied name \`Reflect\`" "Reflect['get'] -> refused"
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
const w = window.innerWidth"
mk gok apps/web/app/components/g.tsx modified
assert_green "plain window / globalThis member reads are NOT triggers (trade-off)" --contains "[not-required]" -- run gok
# Master addendum 5 item 3: a property NAMED like the global object is the global object; a
# property named like a loader is a trigger whatever the receiver.
case_red galias1 apps/web/app/lib/ga1.ts modified "const p = a.globalThis.process" "denied name \`process\`" \
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
# Item 6: isGlobalExpr sees through , / ?? / || / && / ?: ;
# any non-literal, non-numeric key is a trigger (addendum 7d blanket rule).
case_red gwrap1 apps/web/app/lib/gw1.ts modified "const k = 'process'; const p = (0, globalThis)[k]" \
  "computed global member" "(0, globalThis)[k] -> refused"
case_red gwrap2 apps/web/app/lib/gw2.ts modified "const x = null; const k = 'process'; const p = (x ?? window)[k]" \
  "computed global member" "(x ?? window)[k] -> refused"
case_red gwrap3 apps/web/app/lib/gw3.ts modified "const c = true, o = {}, k = 'process'; const p = (c ? self : o)[k]" \
  "computed global member" "(c ? self : o)[k] -> refused"
case_red gfree apps/web/app/lib/gf.ts modified "const k = 'x'; const v = someGlobal[k]" \
  "someGlobal[<non-literal>] (non-literal computed key)" "a free name with a non-literal key -> refused"
case_red gfree2 apps/web/app/lib/gf2.ts modified "const o = {}, k = 'x'; const v = (o || other).a[k]" \
  "non-literal computed key" "(local || free).a[k] -> refused"
src glocal "import { rows } from './rows'
export function pick(key: string) {
  const map = new Map<string, number>()
  const byId: Record<string, number> = { a: 1 }
  return [rows[0], (rows ?? [])[1], rows[0][1], byId['a'], byId.a, map.get(key)]
}"
mk glocal apps/web/app/components/gl.tsx modified
assert_green "numeric and string-literal keys anywhere are NOT triggers" \
  --contains "[not-required]" -- run glocal
# Addendum 7d: the blanket rule. Every bypass of the locality logic named in 7b / 7c / 7d triggers.
case_red bl1 apps/web/app/lib/bl1.ts modified "const k = 'x'; const o = {}; export const v = o.toString[k]" \
  "non-literal computed key" "o.toString[k] (member of a local) -> refused"
case_red bl2 apps/web/app/lib/bl2.ts modified "const k = 'x'; const a = [1]; export const v = a.map[k]" \
  "non-literal computed key" "a.map[k] -> refused"
case_red bl3 apps/web/app/lib/bl3.ts modified "const k = 'x'; export const v = ({ f() {} }).f[k]" \
  "non-literal computed key" "({f(){}}).f[k] -> refused"
case_red bl4 apps/web/app/lib/bl4.ts modified "class Box { m() {} } const k = 'x'; export const v = new Box().m[k]" \
  "non-literal computed key" "new Box().m[k] -> refused"
case_red bl5 apps/web/app/lib/bl5.ts modified "const k = 'x'; const a = {}; export const v = a[k].call[k]" \
  "non-literal computed key" "a[k].call[k] (computed key earlier in the chain) -> refused"
case_red bl6 apps/web/app/lib/bl6.ts modified "const k = 'x'; const o = {}; export const v = o[k].bind(o)[k]" \
  "non-literal computed key" "o[k].bind()[k] -> refused"
case_red bl7 apps/web/app/lib/bl7.ts modified "const k = 'x'; const o: any = {}; Object.assign(o, { f: p }); export const v = o[k]" \
  "non-literal computed key" "a local mutated through a call argument -> refused"
case_red bl8 apps/web/app/lib/bl8.ts modified "const k = 'x'; class Box {} const b = new Box(); export const v = b[k]" \
  "non-literal computed key" "a local-class instance with a non-literal key -> refused"
# Addendum 7c bypasses (aliases).
case_red alias1 apps/web/app/lib/al1.ts modified "const k = 'x'; export function f(p: any) { const c = p; return c[k] }" \
  "c[<non-literal>] (non-literal computed key)" "const c = p (alias of a parameter) -> refused"
case_red alias2 apps/web/app/lib/al2.ts modified "const k = 'x'; const c = {}; export function g(c: any) { return 1 }
export const v = c[k]" "non-literal computed key" "the same name also bound as a parameter -> refused"
case_red alias3 apps/web/app/lib/al3.ts modified "const k = 'con' + 'structor'; const s = ''; const c = s[k]; c[k]('1')()" \
  "c[<non-literal>] (non-literal computed key)" "const c = s[k]; c[k]() (chain via alias) -> refused"
case_red alias4 apps/web/app/lib/al4.ts modified "const k = 'x'; const o = {}; o.f = p; export const v = o[k]" \
  "non-literal computed key" "a property written after the literal -> refused"
case_red alias5 apps/web/app/lib/al5.ts modified "const k = 'x'; const o = { ...w }; export const v = o[k]" \
  "non-literal computed key" "an object literal with a spread -> refused"
case_red imp1 apps/web/app/lib/im1.ts modified "import { rows } from './rows'
export const pick = (i: number) => rows[i]" "non-literal computed key" "an import -> refused (blanket rule)"
# Addendum 7b: a computed-key chain triggers whatever the receiver; a parameter / loop / catch
# binding is never local.
case_red chain1 apps/web/app/lib/ch1.ts modified "const k = 'con' + 'structor'; function f(o: any) { o[k][k]('1')() }" \
  "(non-literal computed key)" "function f(o) { o[k][k]() } -> refused"
case_red chain2 apps/web/app/lib/ch2.ts modified "const k = 'con' + 'structor'; for (const s of ['']) s[k][k]('1')()" \
  "(non-literal computed key)" "for (const s of ['']) s[k][k]() -> refused"
case_red chain3 apps/web/app/lib/ch3.ts modified "const k = 'con' + 'structor'; const s = String(); s[k][k]('1')()" \
  "(non-literal computed key)" "const s = String(); s[k][k]() -> refused"
case_red chain4 apps/web/app/lib/ch4.ts modified "import { rows } from './rows'
export const cell = (i: number, j: number) => rows[i][j]" \
  "(non-literal computed key)" "rows[i][j] with non-literal keys -> refused (fail closed)"
case_red param1 apps/web/app/lib/pa1.ts modified "export const pick = (props: { m: Record<string, number> }, key: string) => props.m[key]" \
  "non-literal computed key" "a parameter receiver -> refused (blanket rule)"
case_red catch1 apps/web/app/lib/ca1.ts modified "const k = 'x'; try { f() } catch (e) { e[k] }" \
  "non-literal computed key" "a catch binding -> refused (blanket rule)"
case_red forin1 apps/web/app/lib/fi1.ts modified "const k = 'x'; for (const a in obj) a[k]" \
  "non-literal computed key" "a for-in binding -> refused (blanket rule)"
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
case_red ctor2 apps/web/app/lib/c2.ts modified "const f = ''['constructor']['constructor']('return 1')" "denied name \`constructor\` (string)" \
  "a ['constructor'] call -> refused"
# Master addendum 8 (SR-M-5 / SR-M-6, review 6099087723): token-level denylist. Each probe of the
# review is red, and red through the new detail string (not the x[k] rule).
DN='denied name `'
case_red d1 apps/web/app/lib/d1.ts modified "const R = Reflect; export const v = R.get(o, 'x')" "${DN}Reflect\`" \
  "const R = Reflect; R.get(...) (aliased Reflect) -> refused"
case_red d2 apps/web/app/lib/d2x.ts modified "const { get } = Reflect; export const v = get(o, 'x')" "${DN}Reflect\`" \
  "const { get } = Reflect -> refused"
case_red d3 apps/e2e/helpers/d3.ts modified "const F = (() => 0).constructor; F('return 1')()" "${DN}constructor\`" \
  "F = (()=>0).constructor; F() -> refused"
case_red d4 apps/e2e/helpers/d4.ts modified "new ((() => 0).constructor)('return 1')" "${DN}constructor\`" \
  "new ((()=>0).constructor)(...) -> refused"
case_red d5 apps/e2e/helpers/d5.ts modified '(() => 0).constructor`return 1`' "${DN}constructor\`" \
  "a tagged template on .constructor -> refused"
case_red d6 apps/e2e/helpers/d6.ts modified "(() => 0).constructor.call(null, 'return 1')()" "${DN}constructor\`" \
  ".constructor.call(...) -> refused"
case_red d7 apps/e2e/helpers/d7.ts modified "const F = (() => 0)['constructor']; F('return 1')()" \
  "${DN}constructor\` (string)" "F = (()=>0)['constructor'] -> refused"
case_red d8 apps/e2e/helpers/d8.ts modified "const { constructor: F } = () => 0; F('return 1')()" "${DN}constructor\`" \
  "const { constructor: F } -> refused"
case_red d9 apps/e2e/helpers/d9.ts modified \
  "Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), 'constructor').value('return 1')" \
  "${DN}getOwnPropertyDescriptor\`" "getOwnPropertyDescriptor(getPrototypeOf(f), ...).value -> refused"
case_red d10 apps/e2e/helpers/d10.ts modified \
  "Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => 0))).find(([n]) => n === 'con' + 'structor')[1].value('return 1')" \
  "${DN}getOwnPropertyDescriptors\`" "Object.entries(getOwnPropertyDescriptors(...)) -> refused"
case_red d11 apps/web/app/lib/d11.ts modified "export const v = ''['\\u0063onstructor']" "${DN}constructor\` (string)" \
  "an escaped string literal (cooked text) -> refused"
case_red d12 apps/web/app/lib/d12.ts modified 'export const v = `${a}constructor`' "${DN}constructor\` (string)" \
  "a template chunk -> refused"
case_red d12_head apps/web/app/lib/d12h.ts modified 'export const v = `constructor${a}`' "${DN}constructor\` (string)" \
  "a TemplateHead carrying a denied name -> refused"
case_red d12_mid apps/web/app/lib/d12m.ts modified 'export const v = `${a}constructor${b}`' "${DN}constructor\` (string)" \
  "a TemplateMiddle carrying a denied name -> refused"
case_red d13 apps/web/app/lib/d13.ts modified "const dark = globalThis.matchMedia?.('(x)')" "${DN}globalThis\`" \
  "a plain globalThis member read -> refused (addendum 8: globalThis is a denied name)"
for n in setPrototypeOf __proto__ defineProperty defineProperties __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ getOwnPropertyNames; do
  case_red "dn_$n" "apps/web/app/lib/dn_$n.ts" modified "export const v = o.$n" "${DN}$n\`" "o.$n -> refused"
done
assert_green "DENIED_NAMES is exactly the addendum-10 list" \
  --contains '["constructor","Reflect","Function","eval","globalThis","getOwnPropertyDescriptor","getOwnPropertyDescriptors","getOwnPropertyNames","getPrototypeOf","setPrototypeOf","__proto__","defineProperty","defineProperties","__defineGetter__","__defineSetter__","__lookupGetter__","__lookupSetter__","process"]' \
  -- env S="$SUBJECT" node --input-type=module -e "const m = await import(process.env.S); console.log(JSON.stringify(m.DENIED_NAMES))"
# Computed keys in destructuring / assignment patterns.
CK='computed key in a destructuring pattern'
case_red p1 apps/web/app/lib/p1.ts modified "const k = 'x'; const { [k]: v } = o" "$CK" "const { [k]: v } = o -> refused"
case_red p2 apps/web/app/lib/p2.ts modified "const k = 'x'; export function f({ [k]: v }: any) { return v }" "$CK" \
  "a computed key in a parameter pattern -> refused"
case_red p3 apps/web/app/lib/p3.ts modified "const k = 'x'; let v; ({ a: { [k]: v } } = o)" "$CK" \
  "a nested computed key in an assignment pattern -> refused"
case_red p4 apps/web/app/lib/p4.ts modified "const k = 'x'; let v; for ({ [k]: v } of xs);" "$CK" \
  "a computed key in a for-of assignment pattern -> refused"
case_red p_arr apps/web/app/lib/p_arr.ts modified "const k = 'x'; let v; [{ [k]: v }] = o" "$CK" \
  "an array pattern target -> refused"
case_red p_spread apps/web/app/lib/p_spread.ts modified "const k = 'x'; let v; ({ ...{ [k]: v } } = o)" "$CK" \
  "a spread pattern target -> refused"
case_red p_paren apps/web/app/lib/p_paren.ts modified "const k = 'x'; let v; (({ [k]: v }) = o)" "$CK" \
  "a parenthesized pattern target -> refused"
case_red p_as apps/web/app/lib/p_as.ts modified "const k = 'x'; let v; (({ [k]: v }) as any) = o" "$CK" \
  "a pattern wrapped in as any -> refused"
src dok "export class Box { constructor(readonly id: string) {} }
export const byId = (id: string, v: number) => ({ [id]: v })
export const h = window.location.href
export const P = () => <p>constructor process</p>"
mk dok apps/web/app/components/dok.tsx modified
assert_green "class constructor, { [id]: v } construction, window.location, JSX text are NOT triggers" \
  --contains "[not-required]" -- run dok

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

# ── fix round on c3cf93fdf (security review SR-*, code review CR-*, pending scanner list) ────
# Verdict: an edited owner review resets (SR-H-1); a dismissed BLOCK still blocks (SR-M-1).
verdict_case edited "[$(review "$OWNER" COMMENTED $'Owner Verdict: APPROVE\nCommit: '"$HEAD" "$HEAD" true)]"
assert_red "SR-H-1: an edited APPROVE review -> not approved" --contains "[missing]" --contains "edited" -- run edited
verdict_case editlater "[$FRESH,$(review "$OWNER" COMMENTED 'plain comment' "$HEAD" true)]"
assert_red "SR-H-1: a later owner review edited (e.g. a BLOCK edited away) resets an earlier APPROVE" \
  --contains "[missing]" --contains "edited" -- run editlater
verdict_case editold "[$(review "$OWNER" COMMENTED 'old note' "$OLD" true),$FRESH]"
assert_green "SR-H-1: an edited review BEFORE a fresh APPROVE does not matter" --contains "[approved]" -- run editold
verdict_case noedit "[$(review "$OWNER" COMMENTED $'Owner Verdict: APPROVE\nCommit: '"$HEAD" "$HEAD" absent)]"
assert_red "SR-H-1: a review without the edited flag (old REST shape) fails closed" --contains "[missing]" -- run noedit
verdict_case dismblock "[$FRESH,$(review "$OWNER" DISMISSED $'Owner Verdict: BLOCK\nCommit: '"$HEAD")]"
assert_red "SR-M-1: a DISMISSED BLOCK after an APPROVE still blocks" --contains "[blocked]" -- run dismblock
verdict_case dismappr "[$(review "$OWNER" COMMENTED 'Owner Verdict: BLOCK'),$(review "$OWNER" DISMISSED $'Owner Verdict: APPROVE\nCommit: '"$HEAD")]"
assert_red "SR-M-1: a DISMISSED APPROVE does not lift a BLOCK" --contains "[blocked]" -- run dismappr

# Scanner (pending list): assignment sources, literal / this / new roots, well-known globals.
case_red lassign1 apps/web/app/lib/la1.ts modified "let x; const k = 'process'; const p = (x ??= globalThis)[k]" \
  "computed global member" "(x ??= globalThis)[k] -> refused"
case_red lassign2 apps/web/app/lib/la2.ts modified "let x; const k = 'process'; const p = (x = window)[k]" \
  "computed global member" "(x = window)[k] -> refused"
case_red lassign3 apps/web/app/lib/la3.ts modified "let x; x ||= self" "\`self\` passed as a value" \
  "x ||= self -> refused"
case_red litroot1 apps/web/app/lib/lr1.ts modified "const k = 'constructor'; const F = ({})[k][k]" \
  "non-literal computed key" "({})[k] -> refused"
case_red litroot2 apps/web/app/lib/lr2.ts modified "const k = 'constructor'; const F = ''[k][k]" \
  "non-literal computed key" "''[k] -> refused"
case_red litroot3 apps/web/app/lib/lr3.ts modified "class A { f(k: string) { return this[k] } }" \
  "non-literal computed key" "this[k] -> refused"
case_red litroot4 apps/web/app/lib/lr4.ts modified "const k = 'x'; const v = new Map()[k]" \
  "non-literal computed key" "new X()[k] -> refused"
# SR-M-3: a name bound to a literal / new / this / function is the literal itself.
case_red litname1 apps/web/app/lib/ln1.ts modified "const o = {}; const k = 'con' + 'structor'; o[k][k]('1')()" \
  "(non-literal computed key)" "const o = {}; o[k][k] -> refused (chain rule)"
case_red litname2 apps/web/app/lib/ln2.ts modified "const s = ''; const k = 'con' + 'structor'; s[k][k]('1')()" \
  "non-literal computed key" "const s = ''; s[k][k] -> refused"
case_red litname3 apps/web/app/lib/ln3.ts modified "const a = []; const b = a; const k = 'con' + 'structor'; b[k][k]('1')()" \
  "non-literal computed key" "an alias of a literal-bound name -> refused"
case_red litname4 apps/web/app/lib/ln4.ts modified "function f() {} const k = 'con' + 'structor'; f[k][k]('1')()" \
  "non-literal computed key" "a function declaration's name -> refused"
case_red litname5 apps/web/app/lib/ln5.ts modified "let o; o = new Map(); const k = 'x'; o[k]" \
  "non-literal computed key" "a name assigned new X() -> refused"
case_red litname6 apps/web/app/lib/ln6.ts modified "const { a } = { a: '' }; const k = 'x'; a[k]" \
  "non-literal computed key" "a destructured name from a literal -> refused"
case_red wkg1 apps/web/app/lib/wk1.ts modified "function f(Object: any) { return 1 }
const k = 'x'; const v = Object[k]" "non-literal computed key" \
  "Object declared somewhere in the file -> refused"
case_red wkg2 apps/web/app/lib/wk2.ts modified "const document = 1; const k = 'x'; const v = document[k]" \
  "non-literal computed key" "a browser global name (document) is never local -> refused"

# Decide (CR-M-2): unreadable pr.json, the awaiting-pm-review label.
printf '[{"filename":"apps/web/app/x.ts"}]\n' >"$DD/files.json"
printf 'not json\n' >"$DD/pr.json"
assert_green "Decide: pr.json unreadable -> go=false" --contains "go=false" --contains "pr.json unreadable" \
  -- decide approved 0 "$T/labels-clean"
rm -f "$DD/pr.json"
assert_green "Decide: pr.json missing -> go=false" --contains "go=false" -- decide approved 0 "$T/labels-clean"
printf '{"headSha":"%s"}\n' "$HEAD" >"$DD/pr.json"
printf 'ready\nawaiting-pm-review\n' >"$T/labels-pm"
assert_green "Decide: awaiting-pm-review label -> go=false" --contains "go=false" --contains "label is set" \
  -- decide approved 0 "$T/labels-pm"

# Wait (CR-M-2): skipped / neutral pass; bad HEAD_SHA and empty contexts refused.
{ run_json "CI" completed '"skipped"'; run_json "Owner Verdict" completed '"neutral"'; } >"$T/runs-skip"
assert_green "Wait: skipped / neutral conclusions count as pass" --contains "all required checks are green" \
  -- wait_checks "$T/runs-skip" 0
assert_red "Wait: a non-40-hex HEAD_SHA -> refused" --contains "not a 40-hex sha" \
  -- env REPO=acme/crm HEAD_SHA=abc1234 REQUIRED_CONTEXTS=CI GH_BIN="$STUB" bash "$WAIT"
assert_red "Wait: empty REQUIRED_CONTEXTS -> refused" --contains "REQUIRED_CONTEXTS is empty" \
  -- env REPO=acme/crm HEAD_SHA="$HEAD" REQUIRED_CONTEXTS=$'\n  \n' GH_BIN="$STUB" bash "$WAIT"

# Fetch (CR-M-2): a stub gh answering each endpoint; GraphQL pages must add up to totalCount.
FETCH="$GUARD_DIR/owner-verdict-fetch.sh"
FSTUB="$T/stub-fetch-gh"
cat >"$FSTUB" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *graphql*) cat "$FX/graphql" ;;
  *"/files?"*) printf '{"filename":"apps/web/app/x.ts","previous_filename":null,"status":"modified"}\n' ;;
  *"/contents/"*) if [ -f "$FX/content" ]; then cat "$FX/content"; else echo "HTTP 404" >&2; exit 1; fi ;;
  *) printf '{"headSha":"%s","author":"some-manager","counts":{"changedFiles":1}}\n' "$FX_HEAD" ;;
esac
STUB
chmod +x "$FSTUB"
FX="$T/fx"
mkdir -p "$FX"
fetch() { # <pr-number> [head]
  rm -rf "$T/fd"
  (cd "$REPO" && env REPO=acme/crm PR_NUMBER="$1" D="$T/fd" GH_BIN="$FSTUB" FX="$FX" FX_HEAD="${2:-$HEAD}" bash "$FETCH")
}
printf '{"total":1,"nodes":[{"author":"%s","state":"COMMENTED","body":"x","commit_id":"%s","edited":false}]}\n' \
  "$OWNER" "$HEAD" >"$FX/graphql"
printf 'export const a = 1\n' >"$FX/content"
assert_green "Fetch: reviews, files and contents land in D" --contains "reviews=1" --contains "fetched=1" \
  --contains "unavailable=0" -- fetch 7
assert_green "Fetch: the review carries the edited flag" --contains "false" -- jq -r '.reviews[0].edited' "$T/fd/pr.json"
rm -f "$FX/content"
assert_green "Fetch: a content fetch that fails is recorded as unavailable (fail closed)" \
  --contains "unavailable=1" -- fetch 7
assert_green "Fetch: ... and the scanner reads it as a trigger" --contains '"unavailable":true' -- jq -c . "$T/fd/contents.json"
printf '{"total":2,"nodes":[{"author":"x","state":"COMMENTED","body":"","commit_id":null,"edited":false}]}\n' >"$FX/graphql"
assert_red "Fetch: GraphQL pages short of totalCount -> refused" --contains "do not add up" -- fetch 7
assert_red "Fetch: a non-numeric PR_NUMBER -> refused" --contains "PR_NUMBER is not a number" -- fetch 7x
printf '{"total":0,"nodes":[]}\n' >"$FX/graphql"
assert_red "Fetch: a head sha that is not 40-hex -> refused" --contains "no head sha" -- fetch 7 abc

# Flow Gate reviews (SR-M-4): GraphQL, and an edited review is never positive evidence.
FGR="$GUARD_DIR/flow-gate-reviews.sh"
FG_MJS="$REPO/scripts/architect/flow-gate.mjs"
fgr_node() { # <author> <body> <edited> [submittedAt]
  node -e 'const [a, b, e, t] = process.argv.slice(1); console.log(JSON.stringify({ author: { login: a }, authorAssociation: "OWNER", state: "COMMENTED", body: b, submittedAt: t || "2026-11-28T00:00:00Z", commit: { oid: "'"$HEAD"'" }, lastEditedAt: e === "true" ? "2026-11-28T01:00:00Z" : null, includesCreatedEdit: false, userContentEdits: { totalCount: 0 } }))' "$1" "$2" "$3" "${4:-}"
}
cat >"$T/stub-fgr-gh" <<'STUB'
#!/usr/bin/env bash
# Applies the caller's own --jq filter to the fixture page, as gh does.
while [ $# -gt 0 ]; do [ "$1" = --jq ] && { jq -c "$2" "$FX/fgr"; exit; }; shift; done
exit 1
STUB
chmod +x "$T/stub-fgr-gh"
fgr_fixture() { # <totalCount> <node-json>...
  local total="$1"
  shift
  printf '{"data":{"repository":{"pullRequest":{"reviews":{"totalCount":%s,"nodes":[%s]}}}}}\n' \
    "$total" "$(IFS=,; echo "$*")" >"$FX/fgr"
}
fgr_run() { env REPO=acme/crm PR_NUMBER=7 GH_BIN="$T/stub-fgr-gh" FX="$FX" bash "$FGR"; }
fgr_marks() { # reviews.json on stdin -> "<review> <security> <spec> <copy>" per review
  # The module path goes in env: as argv[1] it would trip flow-gate.mjs's own main guard.
  FG_MJS="$FG_MJS" node --input-type=module -e '
    import { readFileSync } from "node:fs"
    const { parseMarker } = await import(process.env.FG_MJS)
    for (const r of JSON.parse(readFileSync(0, "utf8")))
      console.log(["review", "security", "spec", "copy"].map((k) => parseMarker(r.body, k) ?? "none").join(" "))'
}
fgr_pipe() { fgr_run | fgr_marks; }
fgr_fixture 3 "$(fgr_node rev1 $'Verdict: APPROVE\nSecurity Review: APPROVE\nSpec Review: PASS\nCopy Review: PASS' true)" \
  "$(fgr_node rev2 $'Verdict: BLOCK\nSpec Review: ISSUES' true)" \
  "$(fgr_node rev3 $'Verdict: APPROVE\nSecurity Review: APPROVE' false)"
assert_green "SR-M-4: the Flow Gate review fetch keeps the REST shape" \
  --contains '"association":"OWNER"' --contains '"at":"2026-11-28T00:00:00Z"' --contains "\"commit_id\":\"$HEAD\"" \
  --not-contains '"edited"' -- fgr_run
assert_green "SR-M-4 + SR-M-7: edited review counts as NEGATIVE for Verdict / Security / Spec, Copy kept; unedited untouched" \
  --contains $'neg neg neg pos\nneg neg neg none\npos pos none none' -- fgr_pipe
fgr_fixture 1 "$(fgr_node rev1 $'Copy Review: PASS\nnotes only' true)"
assert_green "SR-M-7: an edited review with no strict marker is negative for strict kinds" \
  --contains 'neg neg neg pos' -- fgr_pipe
fgr_standing() { # reviews.json on stdin -> the standing Security Review state
  FG_MJS="$FG_MJS" node --input-type=module -e '
    import { readFileSync } from "node:fs"
    const { standingVerdict } = await import(process.env.FG_MJS)
    console.log("standing=" + standingVerdict(JSON.parse(readFileSync(0, "utf8")), "security").state)'
}
fgr_standing_pipe() { fgr_run | fgr_standing; }
fgr_fixture 2 "$(fgr_node rev1 'Security Review: APPROVE' false 2026-11-28T10:00:00Z)" \
  "$(fgr_node rev1 'Security Review: APPROVE' true 2026-11-28T11:00:00Z)"
assert_green "SR-M-7: unedited APPROVE, then an edited BLOCK-to-APPROVE -> standing negative (the old APPROVE does not resurface)" \
  --contains 'standing=neg' -- fgr_standing_pipe
fgr_fixture 3 "$(fgr_node rev1 'Security Review: APPROVE' false 2026-11-28T10:00:00Z)" \
  "$(fgr_node rev1 'Security Review: APPROVE' true 2026-11-28T11:00:00Z)" \
  "$(fgr_node rev1 'Security Review: APPROVE' false 2026-11-28T12:00:00Z)"
assert_green "SR-M-7: later unedited APPROVE on the head restores positive" \
  --contains 'standing=pos' -- fgr_standing_pipe
fgr_fixture 2 "$(fgr_node rev1 'Verdict: APPROVE' false)"
assert_red "SR-M-4: GraphQL pages short of totalCount -> refused" --contains "do not add up" -- fgr_run
assert_green "SR-M-4: flow-gate.yml reads reviews through flow-gate-reviews.sh, not REST" \
  --contains "bash scripts/devops/flow-gate-reviews.sh" --not-contains "pulls/\$PR_NUMBER/reviews" \
  -- cat "$REPO/.github/workflows/flow-gate.yml"

# Evaluate (CR-M-1 + SR-M-2): the same script runs in Decide and again right before the merge.
EVAL_SH="$GUARD_DIR/owner-verdict-evaluate.sh"
ED="$T/eval"
evaluate() { # <fixture-name>
  rm -rf "$ED" && mkdir -p "$ED"
  cp "$T/$1.pr.json" "$ED/pr.json"
  cp "$T/$1.files.json" "$ED/files.json"
  cp "$T/$1.contents.json" "$ED/contents.json"
  env D="$ED" HEAD_SHA="$HEAD" REPO=acme/crm PR_NUMBER=7 OWNER="$OWNER" GH_BIN="$STUB" \
    STUB_OUT="$T/labels-clean" STUB_RC=0 GITHUB_OUTPUT= bash "$EVAL_SH"
}
assert_green "Evaluate: a fresh APPROVE -> go=true" --contains "verdict status: approved" --contains "go=true" \
  -- evaluate fresh
assert_green "SR-M-2: a BLOCK posted during the wait -> the re-evaluation says go=false" \
  --contains "verdict status: blocked" --contains "go=false" -- evaluate block
assert_green "SR-H-1: an edited verdict -> go=false" --contains "go=false" -- evaluate edited
cp "$T/fresh.pr.json" "$T/broken.pr.json"
cp "$T/fresh.files.json" "$T/broken.files.json"
printf 'not json\n' >"$T/broken.contents.json"
assert_green "CR-M-1: a scanner that prints nothing -> status error, go=false (not an empty status)" \
  --contains "verdict status: error" --contains "go=false" -- evaluate broken
MERGE_YML="$REPO/.github/workflows/owner-verdict-merge.yml"
RECHECK="$GUARD_DIR/owner-verdict-recheck.sh"
squash_order() {
  awk '/- name: Squash and merge/{s=1} s && /PRE_ATTEMPT=scripts\/devops\/owner-verdict-recheck.sh/{print "recheck"} s && /gh-merge-pr-with-retry.sh/{print "merge"; exit}' "$MERGE_YML" | tr '\n' ' '
}
assert_green "SR-M-2 + LOW: the Squash step merges with the recheck as PRE_ATTEMPT (before each attempt)" \
  --contains "recheck merge" -- squash_order
assert_green "SR-M-2: the recheck fetches, re-evaluates, then merges only on a go=true line" \
  --contains "owner-verdict-fetch.sh" --contains "owner-verdict-evaluate.sh" --contains "grep -qx 'go=true'" \
  -- cat "$RECHECK"
# Recheck end to end: a stub gh for fetch + the labels call of decide.
cat >"$T/stub-recheck-gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *graphql*) cat "$FX/graphql" ;;
  *"/files?"*) printf '{"filename":"apps/web/app/lib/x.ts","previous_filename":null,"status":"added"}\n' ;;
  *"/contents/"*) printf "import pg from 'pg'\n" ;;
  *labels*) echo ready ;;
  *) printf '{"headSha":"%s","author":"some-manager","counts":{"changedFiles":1}}\n' "$FX_HEAD" ;;
esac
STUB
chmod +x "$T/stub-recheck-gh"
recheck() { # <verdict word> [head the PR reports; the verdict names it too]
  local h="${2:-$HEAD}"
  rm -rf "$T/rd"
  printf '{"total":1,"nodes":[%s]}\n' "$(review "$OWNER" COMMENTED $'Owner Verdict: '"$1"$'\n\nCommit: '"$h" "$h")" \
    >"$FX/graphql"
  (cd "$REPO" && env REPO=acme/crm PR_NUMBER=7 HEAD_SHA="$HEAD" D="$T/rd" OWNER="$OWNER" \
    GH_BIN="$T/stub-recheck-gh" FX="$FX" FX_HEAD="$h" GITHUB_OUTPUT= bash "$RECHECK")
}
assert_green "Recheck: a fresh APPROVE on the head -> exit 0" --contains "go=true" -- recheck APPROVE
assert_red "Recheck: a BLOCK posted between attempts -> exit 1" --contains "not a go" -- recheck BLOCK
assert_red "Recheck: the head moved (even with a verdict on the new head) -> exit 1" --contains "the PR head moved past" \
  -- recheck APPROVE 0123456789abcdef0123456789abcdef01234567
assert_green "CR-M-3: the failure comment runs on always() and has one marker per kind" \
  --contains "if: always() && steps.decide.outputs.go == 'true'" --contains 'owner-verdict-merge:$HEAD_SHA:$kind' \
  --contains "will NOT merge automatically" -- cat "$MERGE_YML"

# SR-H-2: every repo script both gate workflows run, and everything those scripts source or call
# through SCRIPT_DIR, plus the tsconfig alias inputs, is inside a critical zone.
zone_cover() {
  node --input-type=module -e '
    import { readFileSync, existsSync, statSync } from "node:fs"
    import { posix } from "node:path"
    const [repo, subject, zonesPath, ...wfs] = process.argv.slice(1)
    const { compileZones, zoneHits } = await import(subject)
    const zones = compileZones(JSON.parse(readFileSync(zonesPath, "utf8")))
    const seen = new Set()
    const todo = []
    for (const wf of wfs) {
      const y = readFileSync(`${repo}/${wf}`, "utf8")
      for (const m of y.matchAll(/scripts\/[\w./-]+\.(?:json|mjs|sh|js)\b/g)) todo.push(m[0])
      for (const m of y.matchAll(/^\s*\/(tsconfig\.base\.json|apps\/\*\/tsconfig\.json)\s*$/gm))
        todo.push(m[1].replace("*", "web"))
    }
    while (todo.length) {
      const p = todo.pop()
      if (seen.has(p)) continue
      seen.add(p)
      if (!existsSync(`${repo}/${p}`)) { console.log(`missing file ${p}`); process.exit(1) }
      if (statSync(`${repo}/${p}`).isDirectory()) { seen.delete(p); continue }
      if (!p.endsWith(".sh")) continue
      for (const m of readFileSync(`${repo}/${p}`, "utf8").matchAll(/\$\{?SCRIPT_DIR\}?\/([\w./-]+)/g))
        todo.push(posix.normalize(posix.join(posix.dirname(p), m[1])))
    }
    const out = [...seen].filter((p) => zoneHits(zones, [{ filename: p }]).length === 0)
    console.log(`gate inputs=${seen.size} outside-zones=${out.length} ${out.join(" ")} | ${[...seen].sort().join(" ")}`)
    process.exit(out.length || seen.size < 8 ? 1 : 0)
  ' "$REPO" "$SUBJECT" "$ZONES" .github/workflows/owner-verdict-merge.yml .github/workflows/flow-gate.yml
}
assert_green "SR-H-2: every script / sourced file / tsconfig input of both gate workflows is in a zone" \
  --contains "outside-zones=0" --contains "scripts/devops/lib/run-with-timeout.sh" \
  --contains "scripts/devops/gh-merge-pr-with-retry.sh" --contains "tsconfig.base.json" -- zone_cover
zone_red zfetch scripts/devops/owner-verdict-fetch.sh pipeline
zone_red zlib scripts/devops/lib/run-with-timeout.sh pipeline
zone_red ztsb tsconfig.base.json pipeline
zone_red ztsw apps/web/tsconfig.json pipeline

# TypeScript pin (Low): the integrity in the installer equals the pnpm-lock.yaml entry; a tarball
# with another hash is refused before anything is unpacked.
TSI="$GUARD_DIR/install-owner-gate-ts.sh"
ts_pin() {
  local want lock
  want=$(sed -n "s/^TS_INTEGRITY='\(.*\)'$/\1/p" "$TSI")
  lock=$(awk '/^  \/typescript\/5\.9\.3:$/{getline; print; exit}' "$REPO/pnpm-lock.yaml" | sed -n 's/.*integrity: \(sha512-[^}]*\)}.*/\1/p')
  echo "installer=$want lock=$lock"
  [ -n "$want" ] && [ "$want" = "$lock" ]
}
assert_green "TS pin: installer integrity == pnpm-lock.yaml typescript@5.9.3 integrity" --contains "lock=sha512-" -- ts_pin
NSTUB="$T/stub-npm"
printf '%s\n' '#!/usr/bin/env bash' 'dest=${@: -1}; printf "evil" >"$dest/typescript-5.9.3.tgz"; echo typescript-5.9.3.tgz' >"$NSTUB"
chmod +x "$NSTUB"
assert_red "TS pin: a tarball with a different hash -> refused, nothing unpacked" --contains "integrity mismatch" \
  -- env TS_DIR="$T/tsx" NPM_BIN="$NSTUB" GITHUB_ENV= bash "$TSI"
assert_red "TS pin: ... and no package/ directory exists" -- test -d "$T/tsx/package"

guard_test_summary "test-check-owner-approval.sh"
