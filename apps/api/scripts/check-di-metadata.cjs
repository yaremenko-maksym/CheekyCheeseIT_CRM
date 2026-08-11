#!/usr/bin/env node
/**
 * Fail the build when a Nest provider asks the injector for a type that does
 * not exist at runtime.
 *
 * ==========================================================================
 * WHY THIS IS A BUILD STEP AND NOT A TEST
 * ==========================================================================
 * On 2026-08-10 `ResumeTypstService` shipped with a constructor parameter typed
 * by a callable interface:
 *
 *     constructor(private readonly runner: TypstRunner = spawnTypst) {}
 *
 * An interface is erased, so `tsc` emitted `design:paramtypes = [Function]`,
 * Nest looked for a provider registered under the token `Function`, found none,
 * and threw `UnknownDependenciesException` while building the module graph —
 * taking the ENTIRE API down at startup, every endpoint, before the first
 * request and before the database was contacted.
 *
 * The whole test suite was green. Not by luck, and not because the tests were
 * careless: VITEST TRANSFORMS TYPESCRIPT WITH ESBUILD, WHICH DOES NOT IMPLEMENT
 * `emitDecoratorMetadata`. Under test there is no `design:paramtypes` at all,
 * so Nest constructs the class with no arguments and the parameter default
 * quietly applies. The same source therefore passes every spec and fails every
 * boot, and NO test run by vitest — however much of the module graph it
 * compiles — can ever observe the difference.
 *
 * So the check reads the artefact that actually ships, and runs as `postbuild`
 * so that every path which produces that artefact (a developer's `pnpm build`,
 * CI, the Docker image) runs it without anyone having to remember.
 *
 * WHAT IT LOOKS FOR: a CLASS-level `design:paramtypes` entry that is a bare
 * `Function` or `Object` — the shape an erased interface or type alias leaves —
 * at an index with no explicit `@Inject(...)`. That is precisely the set of
 * parameters the injector cannot satisfy.
 *
 * Method-level metadata is skipped: `@Get()` handlers legitimately carry
 * `Object`/`String` parameter types and are not injected.
 */
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const DIST = join(__dirname, '..', 'dist')

/** Split a JS array literal's top-level elements, respecting nesting/strings. */
function splitTopLevel(source) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      current += ch
      if (ch === '\\') {
        current += source[i + 1] ?? ''
        i += 1
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/** Every `__decorate([...], Tail);` block in a compiled file. */
function decorateBlocks(code) {
  const blocks = []
  const marker = '__decorate(['
  let from = 0
  for (;;) {
    const start = code.indexOf(marker, from)
    if (start < 0) break
    let depth = 0
    let end = -1
    for (let i = start + marker.length - 1; i < code.length; i += 1) {
      const ch = code[i]
      if (ch === '[') depth += 1
      else if (ch === ']') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) break
    const tailEnd = code.indexOf(';', end)
    blocks.push({
      decorators: code.slice(start + marker.length, end),
      tail: code.slice(end + 1, tailEnd < 0 ? end + 200 : tailEnd),
      index: start,
    })
    from = end
  }
  return blocks
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (entry.endsWith('.js')) files.push(full)
  }
  return files
}

/** Erased token, no `@Optional()` — the injector throws, nothing boots. */
const offenders = []
/** Erased token WITH `@Optional()` — no crash, but silently always `undefined`. */
const suspects = []
let classesChecked = 0

let files
try {
  files = walk(DIST)
} catch {
  console.error(
    `[check-di-metadata] ${DIST} does not exist. This check runs on compiled output — run \`pnpm --filter @crm/api build\` first.`,
  )
  process.exit(1)
}

for (const file of files) {
  const code = readFileSync(file, 'utf8')
  for (const block of decorateBlocks(code)) {
    // Method/property decorators, not constructor injection.
    if (block.tail.includes('.prototype')) continue

    const meta = /__metadata\("design:paramtypes", \[/.exec(block.decorators)
    if (!meta) continue

    const arrayStart = meta.index + meta[0].length
    let depth = 1
    let arrayEnd = arrayStart
    while (arrayEnd < block.decorators.length && depth > 0) {
      const ch = block.decorators[arrayEnd]
      if (ch === '[') depth += 1
      else if (ch === ']') depth -= 1
      if (depth > 0) arrayEnd += 1
    }
    const paramTypes = splitTopLevel(block.decorators.slice(arrayStart, arrayEnd))
    if (paramTypes.length === 0) continue
    classesChecked += 1

    // Indices carrying an explicit token — those never consult design:paramtypes.
    const injected = new Set()
    for (const m of block.decorators.matchAll(/__param\((\d+),\s*\(0,\s*[\w$]+\.Inject\)/g)) {
      injected.add(Number(m[1]))
    }
    // Indices marked @Optional() — the injector passes `undefined` instead of
    // throwing, so these do not stop a boot. They are still wrong (see below).
    const optional = new Set()
    for (const m of block.decorators.matchAll(/__param\((\d+),\s*\(0,\s*[\w$]+\.Optional\)/g)) {
      optional.add(Number(m[1]))
    }

    const className =
      (/,\s*([A-Za-z0-9_$.]+)\s*$/.exec(block.tail.trim()) ?? [])[1] ??
      (/class\s+([A-Za-z0-9_$]+)/.exec(block.tail) ?? [])[1] ??
      '<unknown>'

    paramTypes.forEach((type, index) => {
      if (type !== 'Function' && type !== 'Object') return
      if (injected.has(index)) return
      const entry = { file: relative(join(__dirname, '..'), file), className, index, type }
      // WITHOUT @Optional the injector THROWS and nothing starts -> fatal.
      // WITH @Optional it silently passes `undefined` forever -> the dependency
      // never arrives, which is a live defect but not a boot failure, so it is
      // reported without failing someone else's build.
      if (optional.has(index)) suspects.push(entry)
      else offenders.push(entry)
    })
  }
}

if (offenders.length > 0) {
  console.error('\n[check-di-metadata] Nest cannot inject these constructor parameters:\n')
  for (const o of offenders) {
    console.error(`  ${o.file}  ${o.className}  parameter [${o.index}] resolves to \`${o.type}\``)
  }
  console.error(
    [
      '',
      'A parameter typed by an interface, a type alias or a function type is ERASED at',
      'runtime, so the emitted metadata is a bare `Function`/`Object` and the injector',
      'searches for a provider under that token. It will not find one, and the module',
      'graph fails to build — which takes the whole API down at startup, not just the',
      'feature that owns the class.',
      '',
      'A default value does NOT help: defaults fill `undefined` arguments, and the',
      'injector never reaches the point of passing one.',
      '',
      'Fix: give the parameter an explicit token, e.g.',
      '',
      '    export const MY_DEP = Symbol(\'MY_DEP\')',
      '    constructor(@Optional() @Inject(MY_DEP) dep?: MyInterface) {',
      '      this.dep = dep ?? defaultImplementation',
      '    }',
      '',
      'Note the tests will NOT catch this: vitest transforms with esbuild, which does',
      'not emit decorator metadata, so under test the class is constructed with no',
      'arguments and the default applies. That is why this check reads dist/.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

if (suspects.length > 0) {
  console.warn(
    '\n[check-di-metadata] WARNING — erased token behind @Optional(): injected as `undefined`, always:\n',
  )
  for (const s of suspects) {
    console.warn(`  ${s.file}  ${s.className}  parameter [${s.index}] resolves to \`${s.type}\``)
  }
  console.warn(
    [
      '',
      '`@Optional()` stops the injector throwing, so the application boots — and the',
      'dependency then never arrives, in production exactly as in tests. A union like',
      '`Foo | undefined` erases to `Object` and does this silently.',
      '',
      'Not fatal, so the build continues; fix by adding an explicit @Inject token, or',
      'by dropping `| undefined` from the type if the dependency is in fact required.',
      '',
    ].join('\n'),
  )
}

console.log(
  `[check-di-metadata] OK — ${classesChecked} injectable constructor(s) across ${files.length} compiled files, ${suspects.length} warning(s).`,
)
