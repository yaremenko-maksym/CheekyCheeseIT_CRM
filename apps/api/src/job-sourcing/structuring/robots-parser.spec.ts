import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isPathAllowed,
  MAX_ROBOTS_BYTES,
  parseRobots,
  resolveRobots,
  type ResolvedRobots,
} from './robots-parser'

const CAPTURES = new URL('../providers/sources/__raw-captures__/3.2/', import.meta.url)
const capture = (name: string) => readFileSync(new URL(name, CAPTURES), 'utf8')

const TOKEN = 'cheekybot'
const resolve = (text: string, token = TOKEN): ResolvedRobots =>
  resolveRobots(parseRobots(text), token)
const allowed = (text: string, path: string, token = TOKEN) =>
  isPathAllowed(resolve(text, token), path)

describe('group selection (RFC 9309 2.2.1)', () => {
  it('uses the most specific group and ignores `*` when a named group exists', () => {
    const t = 'User-agent: *\nDisallow: /\n\nUser-agent: CheekyBot\nAllow: /\n'
    expect(allowed(t, '/x')).toBe(true)
    expect(allowed(t, '/x', 'otherbot')).toBe(false)
  })

  it('matches the product token case-insensitively', () => {
    expect(allowed('user-AGENT: CHEEKYBOT\nDisallow: /a', '/a')).toBe(false)
  })

  it('does not prefix-match a longer or shorter product token', () => {
    const t = 'User-agent: cheekybot-extra\nDisallow: /\n'
    expect(allowed(t, '/x')).toBe(true)
    expect(allowed('User-agent: cheeky\nDisallow: /', '/x')).toBe(true)
  })

  it('merges several groups naming the same agent, in any position', () => {
    const t =
      'User-agent: cheekybot\nDisallow: /a\n\nUser-agent: other\nDisallow: /b\n\nUser-agent: cheekybot\nDisallow: /c\n'
    expect(allowed(t, '/a')).toBe(false)
    expect(allowed(t, '/c')).toBe(false)
    expect(allowed(t, '/b')).toBe(true)
  })

  it('merges several `*` groups', () => {
    const t =
      'User-agent: *\nDisallow: /a\nUser-agent: x\nDisallow: /z\nUser-agent: *\nDisallow: /c\n'
    expect(allowed(t, '/a')).toBe(false)
    expect(allowed(t, '/c')).toBe(false)
  })

  it('lets consecutive User-agent lines share one group', () => {
    const t = 'User-agent: other\nUser-agent: cheekybot\nDisallow: /shared\n'
    expect(allowed(t, '/shared')).toBe(false)
  })

  it('starts a new group at a User-agent line that follows a rule', () => {
    const t = 'User-agent: other\nDisallow: /o\nUser-agent: cheekybot\nDisallow: /c\n'
    expect(allowed(t, '/o')).toBe(true)
    expect(allowed(t, '/c')).toBe(false)
  })

  it('ignores rules that precede any User-agent line', () => {
    expect(allowed('Disallow: /\nUser-agent: other\nDisallow: /x', '/y')).toBe(true)
  })

  it('does not let a Sitemap or unknown line split a group', () => {
    const t = 'User-agent: cheekybot\nSitemap: https://a.test/s.xml\nHost: a.test\nDisallow: /a\n'
    expect(allowed(t, '/a')).toBe(false)
  })

  it('allows everything when no group applies', () => {
    expect(allowed('User-agent: other\nDisallow: /', '/x')).toBe(true)
    expect(allowed('', '/x')).toBe(true)
  })
})

describe('rule matching (RFC 9309 2.2.2)', () => {
  it('matches by prefix', () => {
    const t = 'User-agent: *\nDisallow: /private'
    expect(allowed(t, '/private')).toBe(false)
    expect(allowed(t, '/private/deep')).toBe(false)
    expect(allowed(t, '/privat')).toBe(true)
    expect(allowed(t, '/x/private')).toBe(true)
  })

  it('is case-sensitive on the path', () => {
    expect(allowed('User-agent: *\nDisallow: /Private', '/private')).toBe(true)
  })

  it('treats an empty Disallow or Allow as no rule', () => {
    expect(allowed('User-agent: *\nDisallow:', '/anything')).toBe(true)
    expect(allowed('User-agent: *\nDisallow: /\nAllow:', '/x')).toBe(false)
  })

  it('lets the longest match win', () => {
    const t = 'User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /a/b/c\n'
    expect(allowed(t, '/a/x')).toBe(false)
    expect(allowed(t, '/a/b/x')).toBe(true)
    expect(allowed(t, '/a/b/c/x')).toBe(false)
  })

  it('does not depend on rule order', () => {
    expect(allowed('User-agent: *\nAllow: /a/b\nDisallow: /a', '/a/b/x')).toBe(true)
    expect(allowed('User-agent: *\nDisallow: /a/b\nAllow: /a', '/a/b/x')).toBe(false)
  })

  it('lets Allow win a tie, in either order', () => {
    expect(allowed('User-agent: *\nDisallow: /p\nAllow: /p', '/p')).toBe(true)
    expect(allowed('User-agent: *\nAllow: /p\nDisallow: /p', '/p')).toBe(true)
  })

  it('counts the wildcard and the anchor in the specificity length', () => {
    // '/a*' (3) beats '/a' (2)
    expect(allowed('User-agent: *\nDisallow: /a*\nAllow: /a', '/ab')).toBe(false)
    // '/a$' (3) beats '/a' (2) on the exact path only
    expect(allowed('User-agent: *\nDisallow: /a$\nAllow: /a', '/a')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a$\nAllow: /a', '/ab')).toBe(true)
  })

  it('supports `*` anywhere, matching any run including none', () => {
    const t = 'User-agent: *\nDisallow: /a*c'
    expect(allowed(t, '/ac')).toBe(false)
    expect(allowed(t, '/abbbc')).toBe(false)
    expect(allowed(t, '/ab')).toBe(true)
    expect(allowed('User-agent: *\nDisallow: /*.pdf', '/x/y.pdf')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /*/z', '/q/z')).toBe(false)
  })

  it('backtracks across repeated fragments', () => {
    const t = 'User-agent: *\nDisallow: /*ab*ab'
    expect(allowed(t, '/xabyabz')).toBe(false)
    expect(allowed(t, '/xab')).toBe(true)
    expect(allowed(t, '/ab')).toBe(true)
  })

  it('anchors `$` at the end of the path', () => {
    const t = 'User-agent: *\nDisallow: /*.json$'
    expect(allowed(t, '/a.json')).toBe(false)
    expect(allowed(t, '/a.json?x=1')).toBe(true)
    expect(allowed(t, '/a.jsonx')).toBe(true)
    expect(allowed('User-agent: *\nDisallow: /exact$', '/exact/more')).toBe(true)
  })

  it('does not let an end anchor reuse bytes the leading fragments consumed', () => {
    expect(allowed('User-agent: *\nDisallow: /ab*b$', '/ab')).toBe(true)
    expect(allowed('User-agent: *\nDisallow: /ab*b$', '/abb')).toBe(false)
  })

  it('treats `$` in the middle as a literal', () => {
    expect(allowed('User-agent: *\nDisallow: /a$b', '/a$b')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a$b', '/a')).toBe(true)
  })

  it('treats `*$` as match-all-from-prefix', () => {
    expect(allowed('User-agent: *\nDisallow: /a*$', '/anything')).toBe(false)
  })

  it('matches the query string as part of the path', () => {
    const t = 'User-agent: *\nDisallow: /*?*'
    expect(allowed(t, '/jobs?x=1')).toBe(false)
    expect(allowed(t, '/jobs')).toBe(true)
  })

  it('treats regex metacharacters in a pattern literally', () => {
    expect(allowed('User-agent: *\nDisallow: /a.b(c)+', '/a.b(c)+')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a.b', '/axb')).toBe(true)
  })

  it('survives a pathological pattern without catastrophic backtracking', () => {
    const t = `User-agent: *\nDisallow: /${'*a'.repeat(200)}b`
    const started = process.hrtime.bigint()
    expect(allowed(t, `/${'a'.repeat(5000)}`)).toBe(true)
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1000)
  })
})

describe('percent-encoding (RFC 9309 2.2.2)', () => {
  it('compares an encoded rule with a raw path and the reverse', () => {
    expect(allowed('User-agent: *\nDisallow: /a b', '/a%20b')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a%20b', '/a b')).toBe(false)
  })

  it('folds the hex case of an escape', () => {
    expect(allowed('User-agent: *\nDisallow: /a%7bb', '/a%7Bb')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a%7Bb', '/a%7bb')).toBe(false)
  })

  it('decodes an escaped unreserved character', () => {
    expect(allowed('User-agent: *\nDisallow: /%7Euser', '/~user')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /~user', '/%7euser')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /%61bc', '/abc')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a%2Dz', '/a-z')).toBe(false)
  })

  it('keeps an escaped reserved character distinct from the literal one', () => {
    expect(allowed('User-agent: *\nDisallow: /a%2Fb', '/a/b')).toBe(true)
    expect(allowed('User-agent: *\nDisallow: /a/b', '/a%2Fb')).toBe(true)
    expect(allowed('User-agent: *\nDisallow: /a%2Fb', '/a%2fb')).toBe(false)
  })

  it('encodes non-ASCII characters as UTF-8 before comparing', () => {
    expect(allowed('User-agent: *\nDisallow: /é', '/%C3%A9')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /%C3%A9', '/é')).toBe(false)
  })

  it('leaves a malformed escape literal', () => {
    expect(allowed('User-agent: *\nDisallow: /a%zz', '/a%zz')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a%', '/a%')).toBe(false)
    expect(allowed('User-agent: *\nDisallow: /a%1', '/a%1')).toBe(false)
  })

  it('does not decode an escaped wildcard into a wildcard', () => {
    expect(allowed('User-agent: *\nDisallow: /a%2Ab', '/axb')).toBe(true)
  })

  it('does not treat an escaped control byte as a literal one', () => {
    expect(allowed('User-agent: *\nDisallow: /a%00b', '/a%00b')).toBe(false)
  })
})

describe('line syntax', () => {
  it('strips comments, whitespace, BOM and any line ending', () => {
    const t = '﻿  User-agent :  *  # all\r\n\tDisallow:\t/a # why\rDisallow: /b\n#Disallow: /c\n'
    expect(allowed(t, '/a')).toBe(false)
    expect(allowed(t, '/b')).toBe(false)
    expect(allowed(t, '/c')).toBe(true)
  })

  it('matches directive names case-insensitively', () => {
    expect(allowed('USER-AGENT: *\nDISALLOW: /a', '/a')).toBe(false)
  })

  it('keeps a colon that sits inside the value', () => {
    expect(allowed('User-agent: *\nDisallow: /a:b', '/a:b')).toBe(false)
  })

  it('ignores a line without a colon', () => {
    expect(allowed('User-agent: *\nDisallow /a', '/a')).toBe(true)
  })

  it('ignores an unrecognised directive', () => {
    expect(allowed('User-agent: *\nNoindex: /a', '/a')).toBe(true)
  })

  it('counts a line without a colon as meaningful but never as a directive', () => {
    const p = parseRobots('User-agent: *\nDisallowx\nsitemap\n  \n\t\n# c\n   # c\n')
    expect([p.meaningfulLines, p.recognisedLines]).toEqual([3, 1])
  })

  it('counts what it recognised, for the unparseable check', () => {
    expect(parseRobots('# only a comment\n\n').meaningfulLines).toBe(0)
    const html = parseRobots('<html><body>Not found</body></html>')
    expect(html.meaningfulLines).toBe(1)
    expect(html.recognisedLines).toBe(0)
    const ok = parseRobots('User-agent: *\nSitemap: https://a.test/s\nFoo: bar\n')
    expect(ok.meaningfulLines).toBe(3)
    expect(ok.recognisedLines).toBe(2)
  })
})

describe('size cap (RFC 9309 2.5)', () => {
  it('exposes the 500 KiB limit', () => {
    expect(MAX_ROBOTS_BYTES).toBe(512000)
  })

  it('ignores everything past the cap and reports the truncation', () => {
    const head = 'User-agent: *\nDisallow: /early\n'
    const filler = '#'.repeat(MAX_ROBOTS_BYTES - head.length - 1) + '\n'
    const parsed = parseRobots(`${head}${filler}Disallow: /late\n`)
    expect(parsed.truncated).toBe(true)
    const r = resolveRobots(parsed, TOKEN)
    expect(isPathAllowed(r, '/early')).toBe(false)
    expect(isPathAllowed(r, '/late')).toBe(true)
  })

  it('does not truncate a body of exactly the cap', () => {
    const head = 'User-agent: *\nDisallow: /x\n'
    const body = head + '#'.repeat(MAX_ROBOTS_BYTES - head.length)
    expect(Buffer.byteLength(body)).toBe(MAX_ROBOTS_BYTES)
    expect(parseRobots(body).truncated).toBe(false)
  })

  it('counts bytes, not characters', () => {
    const body = 'User-agent: *\nDisallow: /x\n' + 'é'.repeat(MAX_ROBOTS_BYTES / 2)
    expect(parseRobots(body).truncated).toBe(true)
  })

  // Builds a body whose last kept line ends exactly at the cap, followed by `after`.
  const capped = (lastLine: string, after: string, eol = '\n') => {
    const first = 'User-agent: *'
    const fixed = `${first}${eol}`.length + `${eol}Disallow: /keep${eol}`.length + lastLine.length
    const pad = '#'.repeat(MAX_ROBOTS_BYTES - fixed)
    return `${first}${eol}${pad}${eol}Disallow: /keep${eol}${lastLine}${after}`
  }

  it.each(['\n', '\r'])('drops the line the cut lands in, so a half rule never applies', (eol) => {
    const parsed = parseRobots(capped('Allow: /secr', `et/deeper${eol}`, eol))
    expect(parsed.truncated).toBe(true)
    // exactly the complete line before the cut survives, unchanged
    expect(resolveRobots(parsed, TOKEN).rules).toEqual([{ allow: false, pattern: '/keep' }])
  })

  it.each(['\n', '\r', '\r\n'])('keeps a line that ends exactly at the cap (%j follows)', (eol) => {
    const parsed = parseRobots(capped('Disallow: /last', `${eol}Disallow: /after${eol}`, eol))
    expect(parsed.truncated).toBe(true)
    const patterns = resolveRobots(parsed, TOKEN).rules.map((r) => r.pattern)
    expect(patterns).toEqual(['/keep', '/last'])
  })

  it('keeps a line when the cap falls right after its line break', () => {
    const parsed = parseRobots(capped('Disallow: /last\n', 'Disallow: /after\n'))
    expect(resolveRobots(parsed, TOKEN).rules.map((r) => r.pattern)).toEqual(['/keep', '/last'])
  })

  it('keeps nothing of a single oversize line', () => {
    const parsed = parseRobots('x'.repeat(MAX_ROBOTS_BYTES + 10))
    expect(parsed.truncated).toBe(true)
    expect(parsed.meaningfulLines).toBe(0)
  })
})

describe('pattern normalisation, as stored', () => {
  const patterns = (value: string) =>
    resolve(`User-agent: *\nDisallow: ${value}`).rules.map((r) => r.pattern)

  it.each([
    ['/plain/path?x=1', '/plain/path?x=1'],
    ['/a b', '/a%20b'],
    ['/a%7bb', '/a%7Bb'],
    ['/%7Euser', '/~user'],
    ['/%61%2D%2e%5f%7e%30%39%5A', '/a-._~09Z'],
    ['/é', '/%C3%A9'],
    ['/😀', '/%F0%9F%98%80'],
    ['/a\u0001b', '/a%01b'],
    ['/a%zz', '/a%zz'],
    ['/a%', '/a%'],
    ['/a%1', '/a%1'],
    ['/%%41', '/%A'],
    ['/a%2Ab', '/a%2Ab'],
    ['/*$', '/*$'],
    ['/{id}', '/%7Bid%7D'],
  ])('%s -> %s', (value, expected) => {
    expect(patterns(value)).toEqual([expected])
  })

  it('removes only a leading byte-order mark', () => {
    expect(resolve('﻿User-agent: *\nDisallow: /a').rules).toHaveLength(1)
    expect(patterns('/a﻿b')).toEqual(['/a%EF%BB%BFb'])
  })
})

describe('group and directive corner cases', () => {
  it('gives every agent of a shared group the same rules', () => {
    const t = 'User-agent: first\nUser-agent: second\nDisallow: /shared\n'
    expect(allowed(t, '/shared', 'first')).toBe(false)
    expect(allowed(t, '/shared', 'second')).toBe(false)
  })

  it('keeps agents of one group together across a Sitemap line, and reads no signal from it', () => {
    const t =
      'User-agent: first\nSitemap: https://a.test/s?search=yes\nUser-agent: second\nDisallow: /shared\n'
    expect(allowed(t, '/shared', 'first')).toBe(false)
    expect(allowed(t, '/shared', 'second')).toBe(false)
    expect(resolve(`User-agent: *\nSitemap: https://a.test/?search=yes`).signals.search).toBe(
      'unspecified',
    )
  })

  it('does not read a delay from a preamble line that is not Crawl-delay', () => {
    expect(resolve('Disallow: 5\nAllow: 3\nUser-agent: *').crawlDelaySeconds).toBeNull()
  })

  it('reads a two-digit fraction as a delay', () => {
    expect(resolve('User-agent: *\nCrawl-delay: 1.25').crawlDelaySeconds).toBe(1.25)
  })

  it('ignores a pair with no equals sign instead of reading a key out of it', () => {
    expect(resolve('User-agent: *\nContent-Signal: ai-input=yes, ai-inputx').signals.aiInput).toBe(
      'yes',
    )
  })
})

describe('Crawl-delay', () => {
  it('reads the delay of the selected group', () => {
    expect(resolve('User-agent: *\nCrawl-delay: 2').crawlDelaySeconds).toBe(2)
    expect(resolve('User-agent: *\nCrawl-delay: 1.5').crawlDelaySeconds).toBe(1.5)
    expect(resolve('User-agent: *\nCrawl-delay: 0').crawlDelaySeconds).toBe(0)
  })

  it('is null when absent or when another group carries it', () => {
    expect(resolve('User-agent: *\nDisallow: /').crawlDelaySeconds).toBeNull()
    expect(resolve('User-agent: other\nCrawl-delay: 9').crawlDelaySeconds).toBeNull()
  })

  it('takes the most conservative of several values', () => {
    expect(
      resolve('User-agent: *\nCrawl-delay: 3\nCrawl-delay: 7\nCrawl-delay: 5').crawlDelaySeconds,
    ).toBe(7)
    expect(resolve('User-agent: *\nCrawl-delay: 7\nCrawl-delay: 3').crawlDelaySeconds).toBe(7)
  })

  it('ignores a malformed value', () => {
    for (const bad of ['abc', '-1', '', '1e3', 'Infinity', '2 s', '1.2.3', '+4']) {
      expect(resolve(`User-agent: *\nCrawl-delay: ${bad}`).crawlDelaySeconds).toBeNull()
    }
    expect(resolve('User-agent: *\nCrawl-delay: x\nCrawl-delay: 4').crawlDelaySeconds).toBe(4)
  })

  it('honours a delay that precedes every group, and keeps the larger one', () => {
    expect(resolve('Crawl-delay: 2\nUser-agent: *\nDisallow: /x').crawlDelaySeconds).toBe(2)
    expect(resolve('Crawl-delay: 2\nUser-agent: *\nCrawl-delay: 5').crawlDelaySeconds).toBe(5)
    expect(resolve('Crawl-delay: 9\nUser-agent: *\nCrawl-delay: 5').crawlDelaySeconds).toBe(9)
    expect(resolve('Crawl-delay: bad\nUser-agent: *\nDisallow: /x').crawlDelaySeconds).toBeNull()
    expect(
      resolve('Sitemap: https://a.test/s\nCrawl-delay: 4\nUser-agent: *').crawlDelaySeconds,
    ).toBe(4)
  })

  it('uses the named group over `*`', () => {
    const t = 'User-agent: *\nCrawl-delay: 30\nUser-agent: cheekybot\nCrawl-delay: 2'
    expect(resolve(t).crawlDelaySeconds).toBe(2)
  })
})

describe('Content-Signal', () => {
  const sig = (line: string) => resolve(`User-agent: *\n${line}`).signals

  it('parses the three keys', () => {
    expect(sig('Content-Signal: search=yes, ai-input=no, ai-train=no')).toEqual({
      search: 'yes',
      aiInput: 'no',
      aiTrain: 'no',
    })
  })

  it('defaults every key to unspecified', () => {
    const none = { search: 'unspecified', aiInput: 'unspecified', aiTrain: 'unspecified' }
    expect(sig('Disallow: /')).toEqual(none)
    expect(sig('Content-Signal: search=yes')).toEqual({ ...none, search: 'yes' })
    expect(sig('Content-Signal: ai-input=yes')).toEqual({ ...none, aiInput: 'yes' })
    expect(sig('Content-Signal: ai-train=yes')).toEqual({ ...none, aiTrain: 'yes' })
  })

  it('folds case and whitespace', () => {
    expect(sig('Content-Signal:  AI-Input = YES ,Search=No').aiInput).toBe('yes')
    expect(sig('Content-Signal:  AI-Input = YES ,Search=No').search).toBe('no')
  })

  it('reads a malformed value as unspecified, never yes', () => {
    for (const bad of ['maybe', 'yess', 'y', '', 'true', '1', 'ye s', 'yes=yes']) {
      expect(sig(`Content-Signal: ai-input=${bad}`).aiInput).toBe('unspecified')
    }
  })

  it('ignores a malformed pair without losing its neighbours', () => {
    const s = sig('Content-Signal: ai-input, search=yes, =no, ai-train=no=yes, bogus=yes')
    expect(s).toEqual({ search: 'yes', aiInput: 'unspecified', aiTrain: 'unspecified' })
  })

  it('reads a duplicated key as unspecified, even when the copies agree', () => {
    expect(sig('Content-Signal: ai-input=yes, ai-input=no').aiInput).toBe('unspecified')
    expect(sig('Content-Signal: ai-input=yes, ai-input=yes').aiInput).toBe('unspecified')
    expect(sig('Content-Signal: ai-input=yes\nContent-Signal: ai-input=yes').aiInput).toBe(
      'unspecified',
    )
    expect(sig('Content-Signal: ai-input=no\nContent-Signal: search=yes').search).toBe('yes')
  })

  it('counts a malformed copy as a duplicate too', () => {
    expect(sig('Content-Signal: ai-input=maybe, ai-input=yes').aiInput).toBe('unspecified')
    expect(sig('Content-Signal: ai-input=yes, ai-input=').aiInput).toBe('unspecified')
  })

  it('does not let a duplicate poison a different key', () => {
    const s = sig('Content-Signal: ai-input=yes, ai-input=no, search=yes')
    expect(s.search).toBe('yes')
  })

  it('applies the signal of the selected group only', () => {
    const t =
      'User-agent: other\nContent-Signal: ai-input=yes\nUser-agent: *\nContent-Signal: ai-input=no'
    expect(resolve(t).signals.aiInput).toBe('no')
    expect(resolve('User-agent: other\nContent-Signal: ai-input=yes').signals.aiInput).toBe(
      'unspecified',
    )
  })
})

describe('captured real robots.txt files', () => {
  it('jobgether: permits postings, denies parameterised and offer-template routes', () => {
    const r = resolve(capture('robots-jobgether.txt'))
    expect(isPathAllowed(r, '/offer/6a1b2c3d-some-slug')).toBe(true)
    expect(isPathAllowed(r, '/')).toBe(true)
    expect(isPathAllowed(r, '/astroapi/ai/jobs.json')).toBe(true)
    expect(isPathAllowed(r, '/astroapi/ai/jobs.json?page=2')).toBe(true)
    expect(isPathAllowed(r, '/search?q=rust')).toBe(false)
    expect(isPathAllowed(r, '/offer/{id}')).toBe(false)
    expect(isPathAllowed(r, '/offer/%7Bid%7D')).toBe(false)
    expect(isPathAllowed(r, '/proxy/x?y=1')).toBe(false)
    expect(isPathAllowed(r, '/cdn-cgi/trace')).toBe(false)
    expect(isPathAllowed(r, '/_server-islands/a')).toBe(false)
    expect(isPathAllowed(r, '/active-offers')).toBe(false)
    expect(r.crawlDelaySeconds).toBe(2)
    expect(r.signals).toEqual({ search: 'yes', aiInput: 'yes', aiTrain: 'no' })
  })

  it('arbeitnow: allows the API, denies tracking parameters', () => {
    const r = resolve(capture('robots-arbeitnow.txt'))
    expect(isPathAllowed(r, '/api/job-board-api')).toBe(true)
    expect(isPathAllowed(r, '/jobs/x?__hstc=1')).toBe(false)
    expect(r.crawlDelaySeconds).toBeNull()
  })

  it('news.ycombinator: a crawl delay and per-route denials', () => {
    const r = resolve(capture('robots-news-ycombinator.txt'))
    expect(r.crawlDelaySeconds).toBe(30)
    expect(isPathAllowed(r, '/login')).toBe(false)
    expect(isPathAllowed(r, '/vote?id=1')).toBe(false)
    expect(isPathAllowed(r, '/item?id=1')).toBe(true)
  })

  it('workingnomads: an empty Disallow allows everything', () => {
    const r = resolve(capture('robots-workingnomads.txt'))
    expect(isPathAllowed(r, '/jobs?x=1')).toBe(true)
  })
})
