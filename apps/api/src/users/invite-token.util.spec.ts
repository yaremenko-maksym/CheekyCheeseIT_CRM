/**
 * invite-token.util.spec.ts — task-user-emails-invite.
 *
 * Zero prior coverage (mutation gate, `--changed` on the new file: 7
 * survived mutants — the TTL arithmetic and the hash function body both
 * had NOTHING checking their actual output, only call sites that mock
 * this module away entirely). Expected values below are computed
 * INDEPENDENTLY of the functions under test (a literal millisecond count,
 * a sha256 hex digest computed once via a bare `node -e` one-liner and
 * pasted as a fixture — see the comment on it) — not derived from the same
 * formula/call the implementation uses, which would pass by construction
 * and catch nothing (the exact class of gap the mutation gate exists to
 * find).
 */
import { describe, expect, it } from 'vitest'
import { generateInviteToken, hashInviteToken, INVITE_TOKEN_TTL_MS } from './invite-token.util'

describe('INVITE_TOKEN_TTL_MS', () => {
  it('is exactly 7 days in milliseconds (604800000 — independent literal, not the same formula)', () => {
    expect(INVITE_TOKEN_TTL_MS).toBe(604_800_000)
  })
})

describe('generateInviteToken', () => {
  it('returns a 64-character lowercase hex string (256 bits, hex-encoded)', () => {
    const token = generateInviteToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns a DIFFERENT value on every call (real randomness, not a fixed string)', () => {
    const a = generateInviteToken()
    const b = generateInviteToken()
    expect(a).not.toBe(b)
  })
})

describe('hashInviteToken', () => {
  // Computed independently via `node -e "require('crypto').createHash('sha256')
  // .update('test-token-fixture-abc123','utf8').digest('hex')"` — a fixed
  // reference vector, not a call to hashInviteToken itself or to
  // createHash('sha256') a second time inside this test file.
  const KNOWN_INPUT = 'test-token-fixture-abc123'
  const KNOWN_SHA256_HEX = '3b5d6931d00410868bb9464d02dd155fefae94977b5af7d7161d75840dc3463c'

  it('matches the independently-computed sha256 hex digest for a known input', () => {
    expect(hashInviteToken(KNOWN_INPUT)).toBe(KNOWN_SHA256_HEX)
  })

  it('is deterministic — the same input always hashes to the same output', () => {
    expect(hashInviteToken('same-input')).toBe(hashInviteToken('same-input'))
  })

  it('is sensitive to every character — a one-character change produces a completely different hash', () => {
    expect(hashInviteToken('token-a')).not.toBe(hashInviteToken('token-b'))
  })

  it('returns a 64-character lowercase hex string (sha256, hex-encoded)', () => {
    expect(hashInviteToken('anything')).toMatch(/^[0-9a-f]{64}$/)
  })
})
