import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/**
 * E-mail addresses anywhere under `__fixtures__/`, raw captures and scripts included.
 *
 * WHY THIS IS DIRECTORY-WIDE: the first version of the e-mail check (in `fixture-provenance.spec.ts`)
 * read only the trimmed fixtures it listed, so three raw Hacker News captures holding 462 other
 * people's e-mail addresses were committed to a public repository without any check seeing them
 * (PR #1120). A scan whose scope is a list of known files cannot find the file nobody listed, so
 * this one walks the whole tree, decompresses `.gz`, and reads every file.
 *
 * The allow-list is per FILE and per ADDRESS: the published role mailboxes of third-party legal
 * pages that are committed as evidence of a terms verdict, and the redaction placeholder. A new
 * address in an allow-listed file fails, as does any address in any other file.
 */

const ROOT = join(__dirname, '__fixtures__')
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PLACEHOLDER = 'redacted@example.invalid'

/** Corporate contact addresses printed on public terms pages (role mailboxes, not people). */
const PUBLISHED_CONTACTS: Record<string, string[]> = {
  'raw-captures-3.2/wn-terms.html': ['hello@workingnomads.com', 'report@workingnomads.com'],
  'workingnomads/terms.html': ['hello@workingnomads.com', 'report@workingnomads.com'],
  'raw-captures-3.2/yc-legal.html.gz': [
    'accounts@ycombinator.com',
    'apply@ycombinator.com',
    'hn@ycombinator.com',
    'privacy@ycombinator.com',
    'workatastartup@ycombinator.com',
    'yclegal@ycombinator.com',
  ],
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function addressesIn(path: string): string[] {
  const raw = readFileSync(path)
  const text = (path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')
  return [...new Set(text.match(EMAIL) ?? [])].sort()
}

const files = walk(ROOT)

describe('no personal e-mail address anywhere under __fixtures__', () => {
  it('scans the whole tree: every provider directory, the raw captures and the scripts', () => {
    const rel = files.map((f) => relative(ROOT, f))
    // A scanner that only saw a subset would pass these too, so the scope itself is asserted.
    expect(rel.length).toBeGreaterThan(100)
    for (const dir of [
      'remoteok',
      'remotive',
      'himalayas',
      'jobicy',
      'arbeitnow',
      'jobgether',
      'hn-hiring',
      'workingnomads',
      'raw-captures-3.2',
    ]) {
      expect(rel.some((f) => f.startsWith(`${dir}/`))).toBe(true)
    }
    expect(rel).toContain('trim-captures-3.2.mjs')
    expect(rel).toContain('raw-captures-3.2/yc-legal.html.gz')
    expect(rel.some((f) => f.endsWith('.gz'))).toBe(true)
  })

  it('finds no address except the placeholder and the allow-listed published contacts', () => {
    const offenders = files.flatMap((file) => {
      const rel = relative(ROOT, file)
      const allowed = new Set([PLACEHOLDER, ...(PUBLISHED_CONTACTS[rel] ?? [])])
      return addressesIn(file)
        .filter((a) => !allowed.has(a))
        .map((a) => `${rel}: ${a}`)
    })
    expect(offenders).toEqual([])
  })

  it('every allow-listed file exists and still carries exactly the addresses listed for it', () => {
    for (const [rel, expected] of Object.entries(PUBLISHED_CONTACTS)) {
      expect(files.map((f) => relative(ROOT, f))).toContain(rel)
      expect(addressesIn(join(ROOT, rel))).toEqual([...expected].sort())
    }
  })

  it("the raw Hacker News thread captures are not committed (they hold commenters' addresses)", () => {
    const rel = files.map((f) => relative(ROOT, f))
    expect(rel.filter((f) => /^raw-captures-3\.2\/hn-(item-|headers)/.test(f))).toEqual([])
  })
})
