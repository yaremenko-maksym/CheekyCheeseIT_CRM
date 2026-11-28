import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyButtonHrefs, employerAtsUrl, NEXTLEVELJOBS_SITE } from './nextleveljobs.provider'

/**
 * H-3 (task sources-16): the "Apply here" button scan is linear. The regex it replaced spent 5.3 s
 * on a 200 KB page (`[^>]*` lookahead, quadratic); it is kept here only as the oracle.
 */
const OLD_APPLY_BUTTON =
  /<a(?=\s)(?=[^>]*\sclass="(?:[^"]*\s)?bg-lime-500[\s"])[^>]*\shref="(https:\/\/[^"\s]{1,2000})"[^>]*>\s*Apply here\s*<\/a>/g
const oracle = (html: string): string[] => [...html.matchAll(OLD_APPLY_BUTTON)].map((m) => m[1]!)
const hasButton = NEXTLEVELJOBS_SITE.hasApplyButton!

const BUTTON = (href: string, cls = 'btn bg-lime-500 px-4') =>
  `<a class="${cls}" href="${href}">Apply here</a>`

describe('applyButtonHrefs reads what the old regex read', () => {
  const ATS = 'https://jobs.ashbyhq.com/acme/1'
  const cases = [
    '',
    BUTTON(ATS),
    BUTTON(ATS, 'bg-lime-500'),
    BUTTON(ATS, 'x bg-lime-500'),
    BUTTON(ATS, 'bg-lime-500 x'),
    BUTTON(ATS, 'bg-lime-5000'),
    BUTTON(ATS, 'xbg-lime-500'),
    BUTTON(ATS, 'bg-lime-500\tx'),
    BUTTON(ATS, 'x bg-lime-500'),
    `<a href="${ATS}" class="bg-lime-500">Apply here</a>`,
    `<a  class="bg-lime-500"\nhref="${ATS}" >\n Apply here \n</a>`,
    `<a class="bg-lime-500" data-href="${ATS}">Apply here</a>`,
    `<a class="bg-lime-500" href="http://insecure.example/1">Apply here</a>`,
    `<a class="bg-lime-500" href="https://">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a b">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1" href="https://b.example/2">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1" href="https://b">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1">Apply now</a>`,
    `<a class="bg-lime-500" href="https://a.example/1">Apply here</b>`,
    `<A class="bg-lime-500" href="https://a.example/1">Apply here</a>`,
    `<abbr class="bg-lime-500" href="https://a.example/1">Apply here</a>`,
    `<a\tclass="bg-lime-500" href="https://a.example/1">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1"`,
    `<a class="bg-lime-500" <a href="https://a.example/1">Apply here</a>`,
    `<a <a class="bg-lime-500" href="https://a.example/1">Apply here</a>`,
    `<a class="x>y bg-lime-500" href="https://a.example/1">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1>x">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1>x"> Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1">y" >Apply here</a>`,
    `<a class="bg-lime-500 href="https://a.example/1">Apply here</a>`,
    `<a class="bg-lime-500" href="https://${'a'.repeat(1992)}">Apply here</a>`,
    `<a class="bg-lime-500" href="https://${'a'.repeat(1993)}">Apply here</a>`,
    `${BUTTON('https://a.example/1')}${BUTTON('https://b.example/2')}`,
    `${BUTTON('https://a.example/1&amp;x=1')}<a class="y">Apply here</a>`,
    `<a class="bg-lime-500">x</a><a href="https://a.example/1">Apply here</a>`,
    // Mutation-found edges: a class value left open to the end of the page, with the tag's `>`
    // and text inside it, ending on whitespace or on the token itself.
    `<a href="https://a.example/1" class="x>Apply here</a> bg-lime-500 `,
    `<a href="https://a.example/1" class="x>Apply here</a> bg-lime-500`,
    `<a class="x" class="bg-lime-500" href="https://a.example/1">Apply here</a>`,
    `bg-lime-500 <a href="https://a.example/1">Apply here</a>`,
    // The {1,2000} bound counts what follows `https://`.
    `<a class="bg-lime-500" href="https://a">Apply here</a>`,
    `<a class="bg-lime-500" href="https://${'a'.repeat(2000)}">Apply here</a>`,
    `<a class="bg-lime-500" href="https://${'a'.repeat(2001)}">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1">Apply_here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1">xApply here</a>`,
    // An href value that runs past the first `>`.
    `<a class="bg-lime-500" href="https://a>">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a.example/1>x>">Apply here</a>`,
    `<a class="bg-lime-500" href="https://a>b"xApply here</a>`,
    `<a class="bg-lime-500" href="https://a>b" <a class="bg-lime-500" href="https://c">Apply here</a>`,
    `Apply here</a><a class="bg-lime-500" href="https://a>b"`,
  ]
  it.each(cases)('%s', (html) => {
    expect(applyButtonHrefs(html)).toEqual(oracle(html))
    expect(hasButton(html)).toBe(html.search(OLD_APPLY_BUTTON) !== -1)
  })

  it('agrees with the old regex on every captured Next Level Jobs page, and they have a button', () => {
    const root = join(__dirname, '__fixtures__', 'nextleveljobs')
    const files = readdirSync(root).filter((f) => f.endsWith('.html.txt'))
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const file of files) {
      const html = readFileSync(join(root, file), 'utf8')
      expect(applyButtonHrefs(html), file).toEqual(oracle(html))
      expect(oracle(html).length, file).toBeGreaterThan(0)
      expect(hasButton(html), file).toBe(true)
    }
  })

  it('agrees on every captured HTML page of every source (mostly no button at all)', () => {
    const root = join(__dirname, '__fixtures__')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.html.txt'),
    )
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const html = readFileSync(join(root, file), 'utf8')
      expect(applyButtonHrefs(html), file).toEqual(oracle(html))
    }
  })

  it('agrees on 4 000 pages generated from the tokens the patterns turn on (seeded)', () => {
    const TOKENS = [
      '<a',
      '<a ',
      ' ',
      '\n',
      ' ',
      'class="',
      ' class="',
      'bg-lime-500',
      'bg-lime-5000',
      'x',
      '"',
      '>',
      ' href="',
      'href="',
      'https://',
      'a.example/j',
      'data-href="',
      'Apply here',
      ' Apply here ',
      '</a>',
      '&amp;',
      // Whole and partial buttons, so the soup reaches real matches and not only near misses.
      '<a class="bg-lime-500" href="https://a.example/1">Apply here</a>',
      '<a class="x bg-lime-500" ',
      ' href="https://b.example/2"',
      '>Apply here</a>',
      '> Apply here\n</a>',
    ]
    // mulberry32: a fixed seed, so a failure reproduces.
    let seed = 0x5eed16
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    let withButton = 0
    for (let n = 0; n < 4000; n += 1) {
      const length = 1 + Math.floor(random() * 40)
      const html = Array.from({ length }, () => TOKENS[Math.floor(random() * TOKENS.length)]).join(
        '',
      )
      expect(applyButtonHrefs(html), JSON.stringify(html)).toEqual(oracle(html))
      if (oracle(html).length > 0) withButton += 1
    }
    // The generator does reach real buttons, not only near misses.
    expect(withButton).toBeGreaterThan(20)
  })

  it('employerAtsUrl still decodes &amp; and names the one ATS-hosted job', () => {
    const url = 'https://jobs.ashbyhq.com/acme/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7?src=a&amp;b=1'
    expect(employerAtsUrl(BUTTON(url))).toBe(
      'https://jobs.ashbyhq.com/acme/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7?src=a&b=1',
    )
    expect(employerAtsUrl('<p>no button</p>')).toBeNull()
  })
})

/** The time budget. Under Stryker it is unbounded: instrumenting every expression stretches the
 * clock with no change to the scan, and a mutant that makes it super-linear is still caught there
 * by Stryker's own timeout. Every other run (unit, pre-push, CI) holds the 100 ms. */
const BUDGET_MS =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? 100 : Number.POSITIVE_INFINITY

describe('applyButtonHrefs is linear on hostile pages', () => {
  const MIB2 = 2 * 1024 * 1024
  const repeat = (unit: string, tail = '') =>
    unit.repeat(Math.floor((MIB2 - tail.length) / unit.length)) + tail
  const timed = (html: string) => {
    const started = performance.now()
    const result = applyButtonHrefs(html)
    return { result, ms: performance.now() - started }
  }

  it.each([
    ['unclosed `<a `', repeat('<a ')],
    ['unclosed `<a ` closed once at the end', repeat('<a ', '>')],
    ['button classes, unclosed', repeat('<a class="bg-lime-500" ')],
    ['button classes closed once at the end', repeat('<a class="bg-lime-500" ', '>')],
    [
      'one tag of many hrefs, closed once',
      `<a class="bg-lime-500"${repeat(' href="https://a"', '>')}`,
    ],
    [
      'many hrefs, then a long run of spaces',
      `<a class="bg-lime-500"${repeat(' href="https://a"', `>${' '.repeat(100_000)}`)}`,
    ],
    ['buttons without their text', repeat('<a class="bg-lime-500" href="https://a.example/1">')],
    ['class attributes without the token', repeat('<a class="x" ')],
    ['open class values', repeat(' class="bg-lime-500 ')],
  ])('2 MiB of %s finishes in under 100 ms', (_name, html) => {
    const { ms } = timed(html)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it('a button after 2 MiB of near misses is still found', () => {
    const { result, ms } = timed(repeat('<a class="bg-lime-500" >', BUTTON('https://a.example/1')))
    expect(result).toEqual(['https://a.example/1'])
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})
