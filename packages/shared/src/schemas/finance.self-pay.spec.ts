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
