import { describe, expect, it } from 'vitest'
import { tgDisplay, tgUrl } from './tg-url'

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
