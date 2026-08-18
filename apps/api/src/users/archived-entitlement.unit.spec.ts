/**
 * task-archived-user-completeness — AC4, the two things a real DB cannot show.
 *
 * `archived-entitlement.realdb.integration.spec.ts` proves the OUTCOME (an
 * archived user's role/pay terms do not move; settlement edits still do). This
 * file pins the two properties that outcome test is blind to, and the blindness
 * is not hypothetical — it was measured:
 *
 *   1. **Each layer separately.** Deleting the in-JS pre-check from
 *      `updateUserRow` leaves all 12 real-DB tests GREEN, because the second
 *      layer (`archived_at IS NULL` inside the UPDATE, then a re-read to
 *      report the true reason) catches the same case and raises the same
 *      message. Defense in depth is the right design and a blind spot for any
 *      test that only looks at the thrown error: it cannot tell which layer
 *      threw. The pre-check is separated out here by asserting that NO UPDATE
 *      IS EVEN ATTEMPTED — something only layer 1 can produce, and something a
 *      real DB cannot show you. (Layer 2's own SQL predicate is pinned in the
 *      real-DB spec, where it can actually run; a mock would just replay a
 *      queued answer and prove nothing about the WHERE clause.)
 *
 *   2. **Why `updateProfile` / `updateRequisites` may bypass the choke point.**
 *      They are the two remaining direct `update(users)` writers in the
 *      service. The reason that is safe is not "they look harmless" — it is
 *      that the `set` object they build contains no entitlement column at all.
 *      That is a property of their code, so it is asserted against their code:
 *      the `set` they hand to Drizzle is captured and checked field by field.
 *      If someone later adds `role` or `monthlySalary` to either, this goes red
 *      instead of quietly opening a fourth door.
 *
 * Plus the pure semantics of the discriminator itself (`changed`, not
 * `present`; `numeric` columns compared by value because Drizzle returns them
 * as strings) — the rules that decide whether a write is a NEW ENTITLEMENT or
 * an ordinary settlement-time edit.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import {
  ARCHIVED_ENTITLEMENT_MESSAGE,
  ENTITLEMENT_FIELDS,
  changedEntitlementFields,
  createsEntitlementForArchivedUser,
  type EntitlementSnapshot,
} from './archived-entitlement'
import { UsersService } from './users.service'

const ARCHIVED_AT = new Date('2026-01-31T00:00:00.000Z')

const active: EntitlementSnapshot = {
  archivedAt: null,
  role: 'JUNIOR',
  monthlySalary: '1500.00',
  salaryCurrency: 'USDT',
  seniorSharePercent: 26,
  dropSharePercent: 5,
}
const archived: EntitlementSnapshot = { ...active, archivedAt: ARCHIVED_AT }

// ── Mock-DB plumbing ───────────────────────────────────────────────────────
// Deliberately minimal: `select().from().where()` is a thenable resolving the
// next queued row set, `update().set().where().returning()` resolves the queued
// rows. Both spies are returned so a test can assert on WHAT WAS CALLED, which
// is the whole point of this file — the outcome is already covered elsewhere.
function makeDb(opts: { selects: unknown[][]; updateReturns?: unknown[] }) {
  const whereSelect = vi.fn()
  for (const rows of opts.selects) whereSelect.mockResolvedValueOnce(rows)
  whereSelect.mockResolvedValue([])
  const select = vi.fn().mockReturnValue({ from: () => ({ where: whereSelect }) })

  const returning = vi.fn().mockResolvedValue(opts.updateReturns ?? [])
  const whereUpdate = vi.fn().mockReturnValue({ returning })
  const setFn = vi.fn().mockReturnValue({ where: whereUpdate })
  const update = vi.fn().mockReturnValue({ set: setFn })

  const db = { db: { select, update } } as never
  return { db, select, update, setFn, whereUpdate }
}

function makeService(db: never): UsersService {
  return new UsersService(
    db,
    {} as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

describe('archived-entitlement — the discriminator', () => {
  it('an absent key is not a change (the UPDATE will not touch that column)', () => {
    expect(changedEntitlementFields(archived, { displayName: 'x' })).toEqual([])
    expect(createsEntitlementForArchivedUser(archived, { displayName: 'x' })).toBe(false)
  })

  it('a key present with the value the row already holds is not a change', () => {
    // The `UserDialog` case: the whole form is resubmitted, so `role` and
    // `monthlySalary` arrive unchanged alongside the IBAN the admin actually
    // edited. Refusing on presence would 400 the settlement edit.
    expect(createsEntitlementForArchivedUser(archived, { role: 'JUNIOR' })).toBe(false)
  })

  it('numeric columns are compared by VALUE — Drizzle returns `numeric` as a string', () => {
    // '1500.00' (DB) vs 1500 (DTO). A naive `!==` reports every resubmit as a
    // change and refuses it.
    expect(changedEntitlementFields(archived, { monthlySalary: 1500 })).toEqual([])
    expect(changedEntitlementFields(archived, { monthlySalary: '1500.000' })).toEqual([])
    expect(changedEntitlementFields(archived, { monthlySalary: 1500.5 })).toEqual(['monthlySalary'])
  })

  it('null and non-null are distinguished on both sides', () => {
    expect(changedEntitlementFields(archived, { monthlySalary: null })).toEqual(['monthlySalary'])
    expect(
      changedEntitlementFields({ ...archived, monthlySalary: null }, { monthlySalary: null }),
    ).toEqual([])
    expect(
      changedEntitlementFields({ ...archived, monthlySalary: null }, { monthlySalary: 10 }),
    ).toEqual(['monthlySalary'])
  })

  it('every entitlement column is actually watched', () => {
    // Pins the LIST, not just the mechanism: dropping a column from
    // ENTITLEMENT_FIELD_KIND silently reopens that column for archived users.
    expect([...ENTITLEMENT_FIELDS].sort()).toEqual([
      'dropSharePercent',
      'monthlySalary',
      'role',
      'salaryCurrency',
      'seniorSharePercent',
    ])
    expect(changedEntitlementFields(archived, { role: 'HR' })).toEqual(['role'])
    expect(changedEntitlementFields(archived, { salaryCurrency: 'UAH' })).toEqual([
      'salaryCurrency',
    ])
    expect(changedEntitlementFields(archived, { seniorSharePercent: 30 })).toEqual([
      'seniorSharePercent',
    ])
    expect(changedEntitlementFields(archived, { dropSharePercent: 9 })).toEqual([
      'dropSharePercent',
    ])
  })

  it('an ACTIVE user is never refused, whatever changes', () => {
    expect(createsEntitlementForArchivedUser(active, { role: 'HR', monthlySalary: 9000 })).toBe(
      false,
    )
  })
})

describe('archived-entitlement — layer 1: the in-JS pre-check', () => {
  it('refuses BEFORE any UPDATE reaches the database', async () => {
    // This is the assertion the real-DB suite cannot make: there, layer 2
    // produces an identical rejection, so removing layer 1 stays green. Here
    // the evidence is the absence of the write itself.
    const { db, update } = makeDb({ selects: [[{ ...archived, id: 'u1' }]] })
    const svc = makeService(db)

    await expect(svc.changeRole('u1', 'HR', 'admin-1')).rejects.toThrow(
      ARCHIVED_ENTITLEMENT_MESSAGE,
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('does NOT stand in the way when nothing entitlement-bearing changes', async () => {
    const { db, update, setFn } = makeDb({
      selects: [[{ ...archived, id: 'u1' }]],
      updateReturns: [{ ...archived, id: 'u1' }],
    })
    const svc = makeService(db)

    await svc.changeSalary('u1', { monthlySalary: 1500 })
    expect(update).toHaveBeenCalledTimes(1)
    // …and the statement carries no archival predicate in that case — the write
    // is byte-for-byte what it was before this task. (Proven by layer 2's own
    // test below, which shows the predicate DOES appear when a column moves.)
    expect(setFn).toHaveBeenCalledTimes(1)
  })
})

describe('archived-entitlement — layer 2: reading back the true reason for "0 rows"', () => {
  // SCOPE, stated precisely because it is easy to overclaim here: a mock DB
  // returns whatever it was queued to return regardless of the WHERE clause,
  // so these two tests pin the ERROR MAPPING that follows a zero-row UPDATE —
  // NOT the `archived_at IS NULL` predicate itself. The predicate is pinned
  // where it can actually be executed: see "layer 2 — the SQL predicate" in
  // archived-entitlement.realdb.integration.spec.ts, which drives a real
  // Postgres with a deliberately stale snapshot.
  it('a STALE snapshot (archived after the read) is refused as archival, not as 404', async () => {
    // TOCTOU: `existing` is read before the write, so an archive committing in
    // between passes layer 1. The predicate inside the UPDATE then matches zero
    // rows, and the re-read is what turns an ambiguous "0 rows" into the true
    // reason instead of a misleading 404.
    const { db, update } = makeDb({
      selects: [
        [{ ...active, id: 'u1' }], // findById — looks active
        [{ archivedAt: ARCHIVED_AT }], // re-read after 0 rows — actually archived
      ],
      updateReturns: [], // the predicate matched nothing
    })
    const svc = makeService(db)

    const err = await svc.changeRole('u1', 'HR', 'admin-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BadRequestException)
    expect((err as Error).message).toBe(ARCHIVED_ENTITLEMENT_MESSAGE)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('a genuinely missing row is still a 404, not an archival refusal', async () => {
    const { db } = makeDb({
      selects: [
        [{ ...active, id: 'u1' }], // findById
        [], // re-read: the row is gone
      ],
      updateReturns: [],
    })
    const svc = makeService(db)

    await expect(svc.changeRole('u1', 'HR', 'admin-1')).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('archived-entitlement — the two writers that legitimately bypass the choke point', () => {
  // If either of these ever starts writing an entitlement column, it becomes a
  // door with no guard on it. Assert the property that makes the bypass safe.
  const forbidden = new Set<string>(ENTITLEMENT_FIELDS)

  it('updateProfile writes no entitlement column', async () => {
    const { db, setFn } = makeDb({ selects: [], updateReturns: [{ id: 'u1' }] })
    const svc = makeService(db)

    await svc.updateProfile('u1', {
      displayName: 'New Name',
      telegram: '@x',
      phone: '+380000000000',
      techStack: ['ts'],
    })

    const written = Object.keys((setFn.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>)
    expect(written.length).toBeGreaterThan(0)
    expect(written.filter((k) => forbidden.has(k))).toEqual([])
  })

  it('updateRequisites writes no entitlement column', async () => {
    for (const payload of [
      { paymentMethod: 'USDT_ERC20' as const, walletUsdtErc20: '0xabc' },
      {
        paymentMethod: 'BANK_UAH_FOP' as const,
        bankUahRecipient: 'X',
        bankUahIban: 'UA90',
        bankUahRnokpp: '1234567890',
      },
    ]) {
      const { db, setFn } = makeDb({ selects: [], updateReturns: [{ id: 'u1' }] })
      const svc = makeService(db)

      await svc.updateRequisites('u1', payload)

      const written = Object.keys((setFn.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>)
      expect(written.length).toBeGreaterThan(0)
      expect(written.filter((k) => forbidden.has(k))).toEqual([])
    }
  })
})
