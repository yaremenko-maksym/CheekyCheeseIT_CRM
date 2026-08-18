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
import { compileWhere } from '../finance/__test-helpers__/drizzle-where-introspection'

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

  it('an ARCHIVED user with a real change IS refused (the positive case)', () => {
    expect(createsEntitlementForArchivedUser(archived, { role: 'HR' })).toBe(true)
    expect(createsEntitlementForArchivedUser(archived, { monthlySalary: 9000 })).toBe(true)
  })

  it('null is not "zero" — clearing a salary, or setting one from null, is a change', () => {
    // `?? null` normalisation runs BEFORE the numeric fast path for a reason:
    // `Number(null)` is 0, so a numeric comparison would call `null → 0` "no
    // change" and let an archived user's salary be zeroed (or lifted off null)
    // without the guard noticing.
    expect(
      changedEntitlementFields({ ...archived, monthlySalary: null }, { monthlySalary: 0 }),
    ).toEqual(['monthlySalary'])
    expect(
      changedEntitlementFields({ ...archived, monthlySalary: '0' }, { monthlySalary: null }),
    ).toEqual(['monthlySalary'])
  })

  it('a malformed numeric falls back to a textual comparison instead of NaN ≠ NaN', () => {
    // Number('abc') is NaN and NaN !== NaN, so a pure numeric comparison would
    // report an unchanged garbage value as a change and 400 a legitimate
    // whole-form resubmit.
    expect(
      changedEntitlementFields({ ...archived, monthlySalary: 'abc' }, { monthlySalary: 'abc' }),
    ).toEqual([])
    expect(
      changedEntitlementFields({ ...archived, monthlySalary: 'abc' }, { monthlySalary: 5 }),
    ).toEqual(['monthlySalary'])
  })

  it('TEXT columns are compared textually — never coerced through Number', () => {
    // `role` and `salaryCurrency` hold enum values today, so numeric coercion
    // happens to be harmless for them RIGHT NOW. That is an accident of the
    // current enums, not a property of the function, and the day a text-kind
    // column holds a numeric-looking value ('1.0' vs '1.00') a numeric
    // comparison would silently call two different values equal.
    expect(
      changedEntitlementFields(
        { ...archived, salaryCurrency: '1.0' as never },
        { salaryCurrency: '1.00' },
      ),
    ).toEqual(['salaryCurrency'])
  })

  it('the refusal text names the state AND the way out', () => {
    // Asserted against literal fragments, NOT against the exported constant —
    // comparing the constant with itself is the "assertion that cannot fail"
    // this repo's mutation gate exists to catch.
    expect(ARCHIVED_ENTITLEMENT_MESSAGE).toContain('архивирован')
    expect(ARCHIVED_ENTITLEMENT_MESSAGE).toContain('разархивируйте')
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

    const err = await svc.changeRole('u1', 'HR', 'admin-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundException)
    // The TEXT matters: this is the message an operator reads to tell "gone"
    // apart from "frozen".
    expect((err as Error).message).toBe('User not found')
  })

  it('the re-read asks for `archivedAt` — an empty projection could only ever answer "not archived"', async () => {
    const { db, select } = makeDb({
      selects: [[{ ...active, id: 'u1' }], [{ archivedAt: ARCHIVED_AT }]],
      updateReturns: [],
    })
    const svc = makeService(db)

    await expect(svc.changeRole('u1', 'HR', 'admin-1')).rejects.toThrow(
      ARCHIVED_ENTITLEMENT_MESSAGE,
    )
    const projection = select.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
    expect(projection).toBeDefined()
    expect(Object.keys(projection!)).toContain('archivedAt')
  })

  it('does NOT re-read when nothing entitlement-bearing changed — 0 rows then means "gone"', async () => {
    // No archival predicate was attached, so zero rows is unambiguous. Firing
    // the re-read anyway would report a row that IS archived as an archival
    // refusal for a write that never touched an entitlement column.
    const { db, select } = makeDb({
      selects: [
        [{ ...active, id: 'u1' }], // findById — active, nothing changes
        [{ archivedAt: ARCHIVED_AT }], // would be consumed only by a stray re-read
      ],
      updateReturns: [],
    })
    const svc = makeService(db)

    await expect(svc.changeSalary('u1', { monthlySalary: 1500 })).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(select).toHaveBeenCalledTimes(1) // findById only
  })

  it('changeSalary 404s on a missing user before it can write anything', async () => {
    // `changeSalary` used to write blind; the read added for this task is what
    // `updateUserRow` compares against, so losing it would hand `undefined`
    // down as the snapshot.
    const { db, update } = makeDb({ selects: [[]] })
    const svc = makeService(db)

    await expect(svc.changeSalary('nope', { monthlySalary: 10 })).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(update).not.toHaveBeenCalled()
  })
})

describe('archived-entitlement — layer 2: the predicate actually inside the statement', () => {
  // The mock executor ignores the WHERE clause, but the clause it is HANDED is
  // a real Drizzle SQL fragment (only the executor is stubbed, not the query
  // builder). Compiling it is the only way a unit test can see the predicate —
  // see drizzle-where-introspection.ts, added for exactly this blind spot.
  async function whereSqlFor(
    existingRow: Record<string, unknown>,
    call: (svc: UsersService) => Promise<unknown>,
  ): Promise<string> {
    const { db, whereUpdate } = makeDb({
      selects: [[{ ...existingRow, id: 'u1' }]],
      updateReturns: [{ ...existingRow, id: 'u1' }],
    })
    await call(makeService(db))
    return compileWhere(whereUpdate.mock.calls[0]?.[0]).sql
  }

  it('adds `archived_at is null` when an entitlement column actually moves', async () => {
    const sql = await whereSqlFor(active, (svc) => svc.changeRole('u1', 'HR', 'admin-1'))
    expect(sql).toContain('"archived_at" is null')
  })

  it('leaves the statement untouched when nothing entitlement-bearing moves', async () => {
    // Settlement-time edits must produce byte-for-byte the statement they
    // produced before this task — an unconditional predicate here would make
    // every archived user's row unwritable, including their payout requisites.
    const sql = await whereSqlFor(active, (svc) => svc.changeSalary('u1', { monthlySalary: 1500 }))
    expect(sql).not.toContain('archived_at')
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
