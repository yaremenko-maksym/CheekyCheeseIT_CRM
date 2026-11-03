import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The guards sit on the path of text leaving the host: they may not reach the network, the
 * environment, the database or the inference package, directly or by importing a module that does.
 */
const MODULES = [
  'contact-strip.ts',
  'ai-input-gate.ts',
  'prompt-envelope.ts',
  'extraction-result-guard.ts',
  'html-structurer.port.ts',
  'model-budget.port.ts',
]
const ALLOWED_IMPORTS = new Set([
  'zod',
  '@crm/shared',
  'node:crypto',
  './contact-strip',
  './ai-input-gate',
  './extraction-result-guard',
])
/** The adapter composes the guards around the port: it may name the port's TYPES, nothing else of it. */
const ADAPTER = 'model-structurer.ts'
const ADAPTER_IMPORTS = new Set([
  ...ALLOWED_IMPORTS,
  './html-structurer.port',
  './model-budget.port',
  './prompt-envelope',
])
const FORBIDDEN_TOKENS = [
  /\bfetch\s*\(/,
  /\bprocess\.env\b/,
  /\bprocess\b/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /@crm\/inference/,
]

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8')
}

describe('structuring guards — import boundary', () => {
  it.each(MODULES)('%s imports only from the allow-list', (file) => {
    const text = source(file)
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1])
    // A bare `import 'x'` (side effect) has no `from`; none is allowed.
    expect(text).not.toMatch(/^\s*import\s+['"]/m)
    for (const specifier of specifiers) {
      expect(ALLOWED_IMPORTS, `${file} imports ${specifier}`).toContain(specifier)
    }
  })

  it.each(MODULES)('%s has no network, env, dynamic-import or inference reference', (file) => {
    const text = source(file)
    for (const token of FORBIDDEN_TOKENS) {
      expect(text, `${file} matches ${token}`).not.toMatch(token)
    }
  })

  it(`${ADAPTER} reaches @crm/inference by a type-only import, and no network or env`, () => {
    const text = source(ADAPTER)
    const imports = [...text.matchAll(/^import\b([^'"]*?)from\s+['"]([^'"]+)['"]/gm)]
    expect(text).not.toMatch(/^\s*import\s+['"]/m)
    const inference = imports.filter((m) => m[2] === '@crm/inference')
    expect(inference).toHaveLength(1)
    expect(inference[0]?.[1]?.trimStart(), 'must be `import type`').toMatch(/^type\s/)
    const others = imports.filter((m) => m[2] !== '@crm/inference').map((m) => m[2])
    expect(others.length).toBeGreaterThan(3)
    for (const specifier of others) {
      expect(ADAPTER_IMPORTS, `${ADAPTER} imports ${specifier}`).toContain(specifier)
    }
    for (const token of FORBIDDEN_TOKENS.filter((t) => t.source !== '@crm\\/inference')) {
      expect(text, `${ADAPTER} matches ${token}`).not.toMatch(token)
    }
  })

  it('the check reads real files (non-empty, with at least one import overall)', () => {
    const all = MODULES.map(source).join('\n')
    expect(all.length).toBeGreaterThan(1_000)
    expect(all).toMatch(/from 'zod'/)
  })
})
