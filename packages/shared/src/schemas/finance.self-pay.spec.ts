/**
 * finance.self-pay.spec.ts — unit tests for the sender/receiver invariant
 * (task-sender-receiver-invariant, backlog A-2): the shared `selfPayError`
 * pure function, which mirrors the DB-level `ck_transactions_sender_ne_receiver`
 * CHECK on `transactions` (`sender_id <> receiver_id`).
 *
 * The four cases below are the exact truth table verified BY HAND against a
 * real scratch Postgres before writing the CHECK constraint — see the doc
 * comment on `ck_transactions_sender_ne_receiver` in
 * apps/api/src/database/schema.ts and the task file for the SQL proof this
 * function is a pure mirror of. In particular: `senderId === receiverId ===
 * null/undefined` (both empty) is a PASS, not a rejection — that is the
 * three-valued-logic trap `IS DISTINCT FROM` falls into and `<>` avoids.
 *
 * security-review round 2 (MED-2): case-insensitivity is a SEPARATE truth
 * table dimension, added below. Verified by hand against a real scratch
 * Postgres: `'AAAA…'::uuid = 'aaaa…'::uuid` is TRUE (uuid normalises on
 * comparison) and the DB CHECK DOES reject a case-different-but-equal
 * self-pay row — so `selfPayError` MUST also treat them as equal, or a
 * client sending an upper-case id (Zod's `.uuid()` is format-only, not
 * case-normalising) sails past this guard and hits the DB's opaque 500.
 */
import { describe, expect, it } from 'vitest'
import { selfPayError } from './finance'

const A = 'a0000000-0000-4000-8000-000000000001'
const B = 'a0000000-0000-4000-8000-000000000002'

describe('selfPayError — mirrors ck_transactions_sender_ne_receiver (sender_id <> receiver_id)', () => {
  it('both sides set and DIFFERENT → null (passes, matches DB CHECK)', () => {
    expect(selfPayError(A, B)).toBeNull()
  })

  it('both sides set and EQUAL → error (rejected, matches DB CHECK)', () => {
    expect(selfPayError(A, A)).not.toBeNull()
    expect(typeof selfPayError(A, A)).toBe('string')
  })

  it('sender set, receiver null → null (passes — one side empty)', () => {
    expect(selfPayError(A, null)).toBeNull()
  })

  it('sender null, receiver set → null (passes — one side empty)', () => {
    expect(selfPayError(null, A)).toBeNull()
  })

  it('BOTH sides null → null (the trap: passes, NOT rejected — many legitimate rows have neither side set)', () => {
    expect(selfPayError(null, null)).toBeNull()
  })

  it('BOTH sides undefined → null (same trap, undefined arrives from optional DTO fields)', () => {
    expect(selfPayError(undefined, undefined)).toBeNull()
  })

  it('sender undefined, receiver set → null', () => {
    expect(selfPayError(undefined, A)).toBeNull()
  })

  it('uses the default Russian message when none is supplied', () => {
    expect(selfPayError(A, A)).toBe('Отправитель и получатель не могут совпадать')
  })

  it('uses a caller-supplied custom message when provided', () => {
    expect(selfPayError(A, A, 'Cannot transfer to yourself')).toBe('Cannot transfer to yourself')
  })

  // ── security-review round 2 (MED-2): case-insensitive comparison ─────────

  it('same UUID, different case (upper vs lower) → error (matches Postgres uuid semantics)', () => {
    const upper = A.toUpperCase()
    expect(selfPayError(upper, A)).not.toBeNull()
  })

  it('same UUID, different case, args reversed → error (symmetry)', () => {
    const upper = A.toUpperCase()
    expect(selfPayError(A, upper)).not.toBeNull()
  })

  it('same UUID, MIXED case on both sides → error', () => {
    // 'a0000000-...0001' mixed differently on each side, same underlying id.
    const mixed1 = 'A0000000-0000-4000-8000-000000000001'
    const mixed2 = 'a0000000-0000-4000-8000-000000000001'
    expect(selfPayError(mixed1, mixed2)).not.toBeNull()
  })

  it('DIFFERENT UUIDs that merely share a case style → still null (case-folding must not over-match)', () => {
    // Sanity guard against a naive fix that folds too aggressively (e.g.
    // stripping non-hex chars) — B is a genuinely different id, uppercased.
    expect(selfPayError(A, B.toUpperCase())).toBeNull()
  })

  /**
   * RED-PROOF (MED-2): demonstrates the case-sensitivity bug going red.
   * Before the fix, `selfPayError` compared with plain `===`, so this exact
   * call returned `null` (silently passed) — the same-id row would then hit
   * the DB CHECK as a raw, unhandled `ERROR: new row ... violates check
   * constraint` (Postgres SQLSTATE 23514) instead of a clean 400. Reverting
   * `selfPayError` to plain `===` turns this test red immediately.
   */
  it('RED-PROOF: case-different self-pay is NEVER silently allowed', () => {
    const result = selfPayError(A.toUpperCase(), A)
    expect(result).not.toBeNull()
  })

  /**
   * RED-PROOF (AC5): this test demonstrates the check going red if the
   * self-pay guard were ever removed/broken — flip the assertion below to
   * `.toBeNull()` (simulating a guard that always passes) and this test
   * fails, proving the suite actually exercises the equality branch instead
   * of vacuously passing. Kept as a permanent regression anchor, not a
   * throwaway proof: a future refactor that accidentally short-circuits
   * `selfPayError` to always return `null` breaks this test immediately.
   */
  it('RED-PROOF: a same-id self-pay is NEVER silently allowed', () => {
    const result = selfPayError(A, A)
    expect(result).not.toBeNull()
    expect(result).not.toBe('')
  })
})
