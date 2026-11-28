import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalUrlOf } from './sitemap-jsonld'

/**
 * The canonical-link scan is linear (SR2-M-1, PR #1445): a No Fluff Jobs detail page (up to 2 MiB,
 * untrusted) reaches it through `selectByCanonical`. The regex it replaced, kept here as the oracle.
 */
const OLD_CANONICAL_LINK = /<link\b[^>]*\brel="canonical"[^>]*>/
const OLD_HREF = /\bhref="([^"]{1,2000})"/
const oracle = (html: string): string | null => {
  const tag = OLD_CANONICAL_LINK.exec(html)?.[0]
  return tag === undefined ? null : (OLD_HREF.exec(tag)?.[1] ?? null)
}

const MIB2 = 2 * 1024 * 1024
const repeat = (unit: string, tail = '') =>
  unit.repeat(Math.floor((MIB2 - tail.length) / unit.length)) + tail
const timed = (html: string) => {
  const started = performance.now()
  const result = canonicalUrlOf(html)
  return { result, ms: performance.now() - started }
}

describe('canonicalUrlOf is linear on hostile pages', () => {
  it('2 MiB of unclosed `<link ` finishes fast and finds nothing', () => {
    const { result, ms } = timed(repeat('<link '))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(100)
  })

  it('2 MiB of closed non-canonical links finishes fast and finds nothing', () => {
    const { result, ms } = timed(repeat('<link rel="x">'))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(100)
  })

  it('2 MiB of unclosed `<link ` closed once at the end finishes fast', () => {
    const { result, ms } = timed(repeat('<link ', '>'))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(100)
  })

  it('a canonical link after 2 MiB of non-canonical links is still found', () => {
    const tail = '<link rel="canonical" href="https://x.example/job/1">'
    const { result, ms } = timed(repeat('<link rel="x">', tail))
    expect(result).toBe('https://x.example/job/1')
    expect(ms).toBeLessThan(100)
  })
})

describe('canonicalUrlOf reads what the old regex read', () => {
  const cases = [
    '',
    '<link rel="canonical" href="https://a.example/1"/>',
    '<link data-x="1" rel="canonical" href="https://a.example/2">',
    '<link rel="alternate" href="https://a.example/3"/>',
    '<link rel="canonical"/>',
    '<link rel="canonical" href="https://a.example/4"',
    '<LINK rel="canonical" href="https://a.example/5">',
    '<linkx rel="canonical" href="https://a.example/6">',
    '<linkx <link rel="canonical" href="https://a.example/7">',
    '<link a <link rel="canonical" href="https://a.example/8">',
    '<link href="https://a.example/9" rel="canonical">',
    '<link rel="canonical"><link rel="canonical" href="https://a.example/10">',
    '<link rel="x"><link rel="canonical" href="https://a.example/11"><link rel="canonical" href="https://a.example/12">',
    '<link\nrel="canonical"\nhref="https://a.example/13">',
    '<link-x rel="canonical" href="https://a.example/14">',
    '<link rel="canonicalx" href="https://a.example/15">',
    '<link xrel="canonical" href="https://a.example/16">',
  ]
  it.each(cases)('%s', (html) => {
    expect(canonicalUrlOf(html)).toBe(oracle(html))
  })

  it('agrees with the old regex on every captured HTML fixture', () => {
    const root = join(__dirname, '__fixtures__')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.html.txt'),
    )
    let found = 0
    for (const file of files) {
      const html = readFileSync(join(root, file), 'utf8')
      expect(canonicalUrlOf(html), file).toBe(oracle(html))
      if (oracle(html) !== null) found += 1
    }
    // The comparison read real pages, and some of them name a canonical link.
    expect(files.length).toBeGreaterThan(5)
    expect(found).toBeGreaterThan(0)
  })
})
