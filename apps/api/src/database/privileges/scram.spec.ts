/**
 * The SCRAM-SHA-256 verifier builder.
 *
 * Why this exists in the repository at all: ADR §4 forbids sending a plain password to the
 * server, because a FAILING `ALTER ROLE … PASSWORD 'plain'` is written to the server log in
 * clear text (`log_min_error_statement` defaults to `error`). The deploy therefore computes
 * the verifier from the secret and sends only that — which means something has to compute
 * it, outside the server, without the password touching argv.
 *
 * What this spec can and cannot prove: it pins the FORMAT and the determinism. The real
 * oracle is PostgreSQL itself, and it lives in `db-privileges.integration.spec.ts`, which
 * has the server hash the same password, reads back its salt and iteration count, re-derives
 * with those, and requires the two verifier strings to be byte-identical — an independent
 * implementation of the same KDF checking this one. A format assertion alone would pass on
 * a verifier no server accepts.
 */
import { describe, expect, it } from 'vitest'
import { SCRAM_VERIFIER_PATTERN, scramSha256Verifier } from './scram'

const SALT = Buffer.from('0123456789abcdef', 'utf8')

describe('scramSha256Verifier', () => {
  it('produces a verifier in the shape PostgreSQL stores', () => {
    const verifier = scramSha256Verifier('correct horse battery staple', { salt: SALT })
    expect(verifier).toMatch(SCRAM_VERIFIER_PATTERN)
    expect(verifier.startsWith('SCRAM-SHA-256$4096:')).toBe(true)
  })

  it('is deterministic for a given salt and iteration count', () => {
    const a = scramSha256Verifier('hunter2', { salt: SALT })
    const b = scramSha256Verifier('hunter2', { salt: SALT })
    expect(a).toBe(b)
  })

  it('depends on the password', () => {
    expect(scramSha256Verifier('hunter2', { salt: SALT })).not.toBe(
      scramSha256Verifier('hunter3', { salt: SALT }),
    )
  })

  it('depends on the salt', () => {
    expect(scramSha256Verifier('hunter2', { salt: SALT })).not.toBe(
      scramSha256Verifier('hunter2', { salt: Buffer.from('fedcba9876543210', 'utf8') }),
    )
  })

  it('encodes the iteration count it used', () => {
    expect(scramSha256Verifier('hunter2', { salt: SALT, iterations: 8192 })).toMatch(
      /^SCRAM-SHA-256\$8192:/,
    )
  })

  it('generates a fresh salt when none is given', () => {
    expect(scramSha256Verifier('hunter2')).not.toBe(scramSha256Verifier('hunter2'))
  })

  it('refuses an empty password rather than producing a usable verifier', () => {
    // An empty secret is the shape a missing CI secret takes, and a verifier for it would
    // be a working credential for "".
    expect(() => scramSha256Verifier('')).toThrow(/empty/i)
  })

  it('refuses a non-ASCII password instead of guessing at SASLprep', () => {
    // PostgreSQL applies SASLprep (RFC 4013) to non-ASCII passwords before hashing. This
    // does not implement it, so a non-ASCII secret would silently produce a verifier the
    // server rejects at login — the failure would surface as "wrong password" on a deploy.
    // Refusing names the cause instead.
    expect(() => scramSha256Verifier('пароль')).toThrow(/ASCII/)
  })

  it('refuses an iteration count below the PostgreSQL default', () => {
    expect(() => scramSha256Verifier('hunter2', { salt: SALT, iterations: 1000 })).toThrow(/4096/)
  })
})
