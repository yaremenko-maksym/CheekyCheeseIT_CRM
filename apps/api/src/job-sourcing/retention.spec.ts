import { describe, expect, it } from 'vitest'
import { NEW_STORE_CLEANUP_DISABLED, type ObservationContext, shouldKeepPosting } from './retention'

const cutoff = new Date('2026-07-06T00:00:00Z')
const old = new Date('2026-06-01T00:00:00Z')
const fresh = new Date('2026-09-01T00:00:00Z')

describe('shouldKeepPosting', () => {
  it('drops an old NEW posting nobody decided on', () =>
    expect(
      shouldKeepPosting({ collectedAt: old, queueStatus: 'NEW', decidedBySenior: false }, cutoff),
    ).toBe(false))
  it('keeps anything newer than the cutoff', () =>
    expect(
      shouldKeepPosting({ collectedAt: fresh, queueStatus: 'NEW', decidedBySenior: false }, cutoff),
    ).toBe(true))
  it('keeps a posting collected exactly at the cutoff', () =>
    expect(
      shouldKeepPosting(
        { collectedAt: cutoff, queueStatus: 'NEW', decidedBySenior: false },
        cutoff,
      ),
    ).toBe(true))
  it('keeps old IN_PROGRESS and DISMISSED — a dismissed ad must not come back as new', () => {
    expect(
      shouldKeepPosting(
        { collectedAt: old, queueStatus: 'IN_PROGRESS', decidedBySenior: false },
        cutoff,
      ),
    ).toBe(true)
    expect(
      shouldKeepPosting(
        { collectedAt: old, queueStatus: 'DISMISSED', decidedBySenior: false },
        cutoff,
      ),
    ).toBe(true)
  })
  it('keeps old postings a senior already answered (existing AC4 rule)', () =>
    expect(
      shouldKeepPosting({ collectedAt: old, queueStatus: 'NEW', decidedBySenior: true }, cutoff),
    ).toBe(true))
})

/**
 * r5 §1.4 — the new-store context. A legacy posting carries no `observation` at
 * all, which is why the five cases above still pass unchanged: with the field
 * absent the function reduces EXACTLY to the three-clause SQL predicate in
 * `purgeStalePostings`. The cases below cover the branches that exist only once a
 * record is bridged into the new store (observation / bridge / policy).
 *
 * Each case names the operand it kills, because a clean mutation score proves each
 * mutated CONSTRUCT is pinned, not each predicate OPERAND — the lesson this epic
 * already paid for. Hand-deleting the named conjunct must turn the named case red.
 */
describe('shouldKeepPosting — new-store context (r5 §1.4)', () => {
  const observed = (over: Partial<ObservationContext> = {}): ObservationContext => ({
    lastObservedAt: null,
    hasLoggedActions: false,
    unverifiedBackfillInput: false,
    ...over,
  })
  const legacyDroppable = { collectedAt: old, queueStatus: 'NEW' as const, decidedBySenior: false }
  const cleanupOn = { newStoreCleanupEnabled: true }

  it('new-store cleanup is DISABLED by default (AC5 — the seam ships off)', () =>
    expect(NEW_STORE_CLEANUP_DISABLED.newStoreCleanupEnabled).toBe(false))

  it('keeps a stale record that is still actively observed — insertion age alone never deletes', () =>
    // Kills: `obs.lastObservedAt >= cutoff`.
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed({ lastObservedAt: fresh }) },
        cutoff,
        cleanupOn,
      ),
    ).toBe(true))

  it('drops a record whose last observation is itself older than the cutoff', () =>
    // Kills: inverting that same comparison — `<` or `<=` would keep this row.
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed({ lastObservedAt: old }) },
        cutoff,
        cleanupOn,
      ),
    ).toBe(false))

  it('a null lastObservedAt is NOT a date — a never-observed record is not kept by that clause', () => {
    // Kills: collapsing the null guard to `true` (ConditionalExpression). Deleting an
    // operand is one mutation; collapsing a guard is another, and the hand-deletion
    // pass of round 1 could not see the second — this case is the gap closed.
    // `null` coerces to 0 in a date comparison, so without the guard a record that has
    // never been observed compares as though it had been observed at the epoch. The
    // only thing keeping this row is the disabled-cleanup clause further down, so with
    // cleanup ON it must be droppable.
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed({ lastObservedAt: null }) },
        cutoff,
        cleanupOn,
      ),
    ).toBe(false)
    // And the same row with a real, fresh observation IS kept — so the assertion above
    // is about the null, not about the clause being unreachable.
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed({ lastObservedAt: fresh }) },
        cutoff,
        cleanupOn,
      ),
    ).toBe(true)
  })

  it('keeps a record observed EXACTLY at the cutoff (the boundary is inclusive)', () =>
    // Kills: `>=` narrowed to `>` (EqualityOperator) — ONE case closing both CR-H-1's
    // third mutant and SPEC-M-2, which are the same finding reached from two axes.
    // The same boundary the SQL side is proven on from the outside at 729 days versus
    // two years and a day — and the clause likeliest to drift from the SQL later, so
    // it is pinned on the pure twin too.
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed({ lastObservedAt: cutoff }) },
        cutoff,
        cleanupOn,
      ),
    ).toBe(true))

  it('keeps a record whose bridged opportunity carries logged actions (FK RESTRICT, 23503)', () =>
    // Kills: `obs.hasLoggedActions`. A DELETE here is refused by the database by
    // design; the legal deletion of such a row is a tombstone UPDATE.
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed({ hasLoggedActions: true }) },
        cutoff,
        cleanupOn,
      ),
    ).toBe(true))

  it('keeps an unverified backfill input', () =>
    // Kills: `obs.unverifiedBackfillInput`.
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed({ unverifiedBackfillInput: true }) },
        cutoff,
        cleanupOn,
      ),
    ).toBe(true))

  it('keeps every new-store record while cleanup is disabled, even a stale unobserved one', () =>
    // Kills: the `!policy.newStoreCleanupEnabled` operand. This is the AC5 proof
    // that the seam is OFF: the same row becomes droppable only once the owner
    // freezes the durations and the flag is turned on (the case below).
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, observation: observed() },
        cutoff,
        NEW_STORE_CLEANUP_DISABLED,
      ),
    ).toBe(true))

  it('drops that same stale unobserved record once cleanup is enabled', () =>
    expect(
      shouldKeepPosting({ ...legacyDroppable, observation: observed() }, cutoff, cleanupOn),
    ).toBe(false))

  it('the legacy clauses still win over the new-store context', () => {
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, decidedBySenior: true, observation: observed() },
        cutoff,
        cleanupOn,
      ),
    ).toBe(true)
    expect(
      shouldKeepPosting(
        { ...legacyDroppable, queueStatus: 'DISMISSED', observation: observed() },
        cutoff,
        cleanupOn,
      ),
    ).toBe(true)
  })

  it('the default policy argument is the disabled one (a caller cannot forget the switch)', () =>
    expect(shouldKeepPosting({ ...legacyDroppable, observation: observed() }, cutoff)).toBe(true))
})
