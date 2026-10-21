import { isIP } from 'node:net'
import { describe, expect, it } from 'vitest'
import { MAX_LINK_CHARS, checkStoredLink } from './url-policy'

const reasonOf = (raw: string | null | undefined) => {
  const r = checkStoredLink(raw)
  return r.ok ? 'ACCEPTED' : r.reason
}

describe('checkStoredLink: rejections (each has a nearby accepted control)', () => {
  it('rejects userinfo, accepts the same URL without it', () => {
    expect(reasonOf('https://user:pw@jobs.example/j/1')).toBe('USERINFO')
    expect(reasonOf('https://user@jobs.example/j/1')).toBe('USERINFO')
    expect(reasonOf('https://jobs.example/j/1')).toBe('ACCEPTED')
  })

  it('rejects non-https schemes, accepts https', () => {
    for (const bad of [
      'http://jobs.example/j',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'ftp://jobs.example/j',
    ]) {
      expect(reasonOf(bad), bad).toBe('UNSAFE_SCHEME')
    }
    expect(reasonOf('https://jobs.example/j')).toBe('ACCEPTED')
  })

  it('rejects non-default ports; an explicit :443 is the default and is accepted', () => {
    expect(reasonOf('https://jobs.example:8443/j')).toBe('UNSAFE_PORT')
    expect(reasonOf('https://jobs.example:22/j')).toBe('UNSAFE_PORT')
    expect(reasonOf('https://jobs.example:443/j')).toBe('ACCEPTED')
  })

  it('rejects IP literals in every spelling the URL parser folds to an address', () => {
    for (const bad of [
      'https://127.0.0.1/j',
      'https://8.8.8.8/j',
      'https://2130706433/j', // decimal form of 127.0.0.1
      'https://0x7f.0.0.1/j', // hex octet
      'https://[::1]/j',
      'https://[::ffff:7f00:1]/j', // v4-mapped v6
    ]) {
      expect(reasonOf(bad), bad).toBe('IP_LITERAL')
    }
    // A hostname that merely starts with digits is a name, not an address.
    expect(reasonOf('https://123abc.example/j')).toBe('ACCEPTED')
  })

  it('regression: repeated trailing dots must not smuggle an address past the check', () => {
    // The parser keeps `127.0.0.1...` as a NAME (not an address), so a pre-normalization check
    // passes it, and trailing-dot stripping then yields the bare loopback literal. These were
    // ACCEPTED by the first implementation; `127.0.0.1.` (one dot) never was.
    for (const bad of [
      'https://127.0.0.1../x',
      'https://127.0.0.1.../x',
      'https://169.254.169.254.../latest/meta-data',
    ]) {
      expect(reasonOf(bad), bad).toBe('IP_LITERAL')
    }
    expect(reasonOf('https://127.0.0.1./x')).toBe('IP_LITERAL')
  })

  it('pin: non-dotted IPv4 spellings are refused (today by the URL parser folding them, not by our regex)', () => {
    // These pass on the first run: the protection comes from `new URL`. The test exists so a refactor
    // that stops routing through `new URL`, or checks before normalizing, fails here instead of
    // silently reopening loopback/metadata access.
    for (const bad of [
      'https://0x7f.1/x',
      'https://2130706433/x',
      'https://0177.0.0.1/x',
      'https://127.1/x',
      'https://0x7f.1./x',
    ]) {
      expect(reasonOf(bad), bad).toBe('IP_LITERAL')
    }
    expect(reasonOf('https://evil.example/x')).toBe('ACCEPTED')
  })

  it('an address-shaped string that is not an address cannot be a stored link at all', () => {
    expect(reasonOf('https://999.999.999.999/j')).toBe('UNPARSEABLE')
  })

  it('does not treat a name that merely contains digits as an address', () => {
    expect(reasonOf('https://123abc.example/j')).toBe('ACCEPTED')
  })

  it('rejects unparseable, empty, nullish and oversized input', () => {
    expect(reasonOf('not a url')).toBe('UNPARSEABLE')
    expect(reasonOf('')).toBe('UNPARSEABLE')
    expect(reasonOf(null)).toBe('UNPARSEABLE')
    expect(reasonOf(undefined)).toBe('UNPARSEABLE')
    expect(reasonOf(`https://jobs.example/${'a'.repeat(2040)}`)).toBe('TOO_LONG')
    expect(reasonOf(`https://jobs.example/${'a'.repeat(2000)}`)).toBe('ACCEPTED')
  })
})

describe('checkStoredLink: host normalization', () => {
  const hostOf = (raw: string) => {
    const r = checkStoredLink(raw)
    return r.ok ? r.url.hostname : null
  }

  it('maps a Unicode IDN, its punycode form, case variants and a trailing dot to ONE host', () => {
    const forms = [
      'https://bücher.example/j',
      'https://xn--bcher-kva.example/j',
      'https://BÜCHER.Example/j',
      'https://bücher.example/j', // decomposed u + combining diaeresis
      'https://xn--bcher-kva.example./j',
    ]
    expect(new Set(forms.map(hostOf))).toEqual(new Set(['xn--bcher-kva.example']))
  })

  it('keeps genuinely different hosts different', () => {
    expect(hostOf('https://bücher.example/j')).not.toBe(hostOf('https://bucher.example/j'))
  })
})

describe('checkStoredLink: boundaries and malformed hosts', () => {
  it('trims surrounding whitespace before parsing; whitespace-only is empty', () => {
    expect(reasonOf('  https://jobs.example/j \n')).toBe('ACCEPTED')
    expect(reasonOf('   \t ')).toBe('UNPARSEABLE')
  })

  it('the length cap is inclusive: exactly MAX_LINK_CHARS is accepted, one more is TOO_LONG', () => {
    const prefix = 'https://jobs.example/'
    expect(reasonOf(prefix + 'a'.repeat(MAX_LINK_CHARS - prefix.length))).toBe('ACCEPTED')
    expect(reasonOf(prefix + 'a'.repeat(MAX_LINK_CHARS - prefix.length + 1))).toBe('TOO_LONG')
  })

  it('measures the length cap on the trimmed text (the URL parser would trim anyway, so only the cap sees it)', () => {
    const prefix = 'https://jobs.example/'
    const atCap = prefix + 'a'.repeat(MAX_LINK_CHARS - prefix.length)
    expect(reasonOf(`${' '.repeat(50)}${atCap}${' '.repeat(50)}`)).toBe('ACCEPTED')
  })

  it('the cap also applies to the received text: a URL whose href shrinks under the cap is still TOO_LONG', () => {
    // The explicit default port is dropped by the parser, so this text is over the cap while the
    // href it serialises to is under it. Only the text check can refuse it.
    const prefix = 'https://jobs.example:443/'
    const raw = prefix + 'a'.repeat(MAX_LINK_CHARS - prefix.length + 1)
    expect(raw).toHaveLength(MAX_LINK_CHARS + 1)
    expect(new URL(raw).href.length).toBeLessThanOrEqual(MAX_LINK_CHARS)
    expect(reasonOf(raw)).toBe('TOO_LONG')
  })

  it('a password with no username is still userinfo', () => {
    expect(reasonOf('https://:pw@jobs.example/j')).toBe('USERINFO')
  })

  it('refuses an empty host left by stripping dots, and an empty label inside the name', () => {
    // The parser keeps all of these as names; only our check stands in the way.
    expect(reasonOf('https://./x')).toBe('UNPARSEABLE')
    expect(reasonOf('https://..../x')).toBe('UNPARSEABLE')
    expect(reasonOf('https://a..b/x')).toBe('UNPARSEABLE')
    expect(reasonOf('https://a..b../x')).toBe('UNPARSEABLE')
    expect(reasonOf('https://a.b/x')).toBe('ACCEPTED')
  })

  it('strips trailing dots from the stored host so one host has one spelling', () => {
    const r = checkStoredLink('https://jobs.example./j')
    expect(r.ok && r.url.href).toBe('https://jobs.example/j')
  })
})

describe('checkStoredLink: the stored host is the host that was validated (SR-H-1)', () => {
  it('regression: a NON-dotted address spelling behind repeated trailing dots is refused', () => {
    // These are the inputs the earlier trailing-dot regression could not catch: it used dotted
    // quads only, which `net.isIP` already recognised BEFORE the hostname assignment. A decimal,
    // hex or shorthand spelling is invisible to `isIP` and is folded into an address by the
    // ASSIGNMENT, so each of these was ACCEPTED and stored as the address named beside it.
    for (const [bad, becomes] of [
      ['https://2852039166../x', 'instance metadata 169.254.169.254'],
      ['https://0xa9fea9fe../x', 'instance metadata 169.254.169.254'],
      ['https://127.1../x', 'loopback 127.0.0.1'],
      ['https://10.1../x', 'private 10.0.0.1'],
      ['https://0../x', '0.0.0.0'],
      ['https://0x7f.1../x', 'loopback 127.0.0.1'],
      ['https://2130706433../x', 'loopback 127.0.0.1'],
    ] as const) {
      expect(reasonOf(bad), `${bad} is stored as ${becomes}`).toBe('IP_LITERAL')
    }
  })

  it('control: registrable names behind the same repeated trailing dots still pass', () => {
    // The fix must be the differential (an address is an address after folding), not a ban on the
    // input family: these hosts are names before AND after the assignment.
    expect(reasonOf('https://a.com../x')).toBe('ACCEPTED')
    expect(reasonOf('https://jobs.example.../j/1')).toBe('ACCEPTED')
    expect(reasonOf('https://рф../x')).toBe('ACCEPTED')
    expect(reasonOf('https://123abc.example../j')).toBe('ACCEPTED')
  })

  it('no accepted link can hold an address in the host it finally stores', () => {
    // States the invariant over the accepted set rather than over one input family: the stored
    // hostname of everything accepted, asserted in one shot so a rejection is visible as `null`.
    const stored = [
      'https://2852039166../x',
      'https://0xa9fea9fe../x',
      'https://127.1../x',
      'https://a.com../x',
      'https://jobs.example./j',
      'https://рф../x',
    ].map((raw) => {
      const r = checkStoredLink(raw)
      return [raw, r.ok ? isIP(r.url.hostname) : null] as const
    })
    expect(stored).toEqual([
      ['https://2852039166../x', null],
      ['https://0xa9fea9fe../x', null],
      ['https://127.1../x', null],
      ['https://a.com../x', 0],
      ['https://jobs.example./j', 0],
      ['https://рф../x', 0],
    ])
  })
})

describe('checkStoredLink: the length cap measures the STORED href (SR-M-1)', () => {
  it('regression: a non-ASCII URL under the cap as text but over it as href is TOO_LONG', () => {
    // Measured: 2000 Cyrillic path characters serialise to 12014 characters of percent-encoded
    // `href`. The raw text passed the cap, so this was stored far past the declared limit.
    const raw = `https://jobs.example/${'й'.repeat(2000)}`
    expect(raw.length).toBeLessThan(MAX_LINK_CHARS)
    expect(new URL(raw).href.length).toBeGreaterThan(MAX_LINK_CHARS)
    expect(reasonOf(raw)).toBe('TOO_LONG')
  })

  it('every accepted link serialises within the cap', () => {
    // `null` marks a rejection; every number present must be within the cap, so one assertion
    // covers both "nothing over-long was accepted" and "short links were not over-rejected".
    const lengths = [
      `https://jobs.example/${'й'.repeat(2000)}`,
      `https://jobs.example/${'й'.repeat(300)}`,
      `https://jobs.example/${'a'.repeat(2000)}`,
      'https://jobs.example/j/1',
    ].map((raw) => {
      const r = checkStoredLink(raw)
      return r.ok ? r.url.href.length : null
    })
    expect(lengths.filter((n) => n !== null)).toHaveLength(3)
    expect(lengths.filter((n) => n !== null && n > MAX_LINK_CHARS)).toEqual([])
  })

  it('control: a non-ASCII URL whose encoded form fits is still accepted', () => {
    // The cap must not become a ban on non-ASCII paths.
    const r = checkStoredLink('https://jobs.example/вакансія/1')
    expect(r.ok && r.url.href).toBe(
      'https://jobs.example/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D1%96%D1%8F/1',
    )
  })
})
