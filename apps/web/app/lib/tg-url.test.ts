import { describe, expect, it } from 'vitest'
import { safeTelegramHref, tgDisplay, tgUrl } from './tg-url'

describe('tgUrl', () => {
  it('prepends https://t.me/ to a bare handle', () => {
    expect(tgUrl('team_kovalenko')).toBe('https://t.me/team_kovalenko')
  })

  it('strips leading @ before building the URL', () => {
    expect(tgUrl('@maksym_yaremenko')).toBe('https://t.me/maksym_yaremenko')
  })

  it('passes through an already-valid https URL unchanged', () => {
    expect(tgUrl('https://t.me/some_channel')).toBe('https://t.me/some_channel')
  })

  it('does not double-strip @ when handle has no @', () => {
    expect(tgUrl('nopre')).toBe('https://t.me/nopre')
  })
})

describe('tgDisplay', () => {
  it('returns @handle for bare handle', () => {
    expect(tgDisplay('username')).toBe('@username')
  })

  it('returns @handle unchanged when already prefixed', () => {
    expect(tgDisplay('@username')).toBe('@username')
  })

  it('extracts handle from full https://t.me/ URL', () => {
    expect(tgDisplay('https://t.me/chat')).toBe('@chat')
  })
})

// task-candidate-card-resume §3 / code-review round 2 — the stricter,
// validating sibling used for untrusted-ish input (anonymous public form,
// but also reused for CRM-internal telegram rendering — see the doc comment
// on safeTelegramHref for why both).
describe('safeTelegramHref', () => {
  it('accepts a handle with a leading @ and strips it in the URL', () => {
    expect(safeTelegramHref('@armghyan')).toBe('https://t.me/armghyan')
  })

  it('accepts a bare handle without @', () => {
    expect(safeTelegramHref('armghyan')).toBe('https://t.me/armghyan')
  })

  it('accepts digits/underscores after the first letter', () => {
    expect(safeTelegramHref('@john_doe_2')).toBe('https://t.me/john_doe_2')
  })

  it('accepts the minimum length (5 chars)', () => {
    expect(safeTelegramHref('@abcde')).toBe('https://t.me/abcde')
  })

  it('accepts the maximum length (32 chars)', () => {
    const handle = 'a' + '1'.repeat(31)
    expect(handle).toHaveLength(32)
    expect(safeTelegramHref(`@${handle}`)).toBe(`https://t.me/${handle}`)
  })

  it('rejects a handle one char below the minimum (4 chars)', () => {
    expect(safeTelegramHref('@abcd')).toBeUndefined()
  })

  it('rejects a handle one char above the maximum (33 chars)', () => {
    const handle = 'a' + '1'.repeat(32)
    expect(handle).toHaveLength(33)
    expect(safeTelegramHref(`@${handle}`)).toBeUndefined()
  })

  it('rejects a handle starting with a digit', () => {
    expect(safeTelegramHref('@1ivan')).toBeUndefined()
  })

  it('rejects a handle starting with an underscore', () => {
    expect(safeTelegramHref('@_ivan')).toBeUndefined()
  })

  it('rejects a handle with spaces', () => {
    expect(safeTelegramHref('@ivan petrov')).toBeUndefined()
  })

  it('rejects a full URL pasted into the field (not a bare handle)', () => {
    expect(safeTelegramHref('https://t.me/ivan')).toBeUndefined()
  })

  it('rejects arbitrary free text (anonymous public form, untrusted input)', () => {
    expect(safeTelegramHref('связаться со мной в телеге')).toBeUndefined()
  })

  it('rejects a javascript: scheme (schema-injection)', () => {
    expect(safeTelegramHref('javascript:alert(1)')).toBeUndefined()
  })

  it('rejects a data: scheme (schema-injection)', () => {
    expect(safeTelegramHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
  })

  it('rejects a protocol-relative URL (schema-injection)', () => {
    expect(safeTelegramHref('//evil.com')).toBeUndefined()
  })

  it('rejects an empty string', () => {
    expect(safeTelegramHref('')).toBeUndefined()
  })
})
