/**
 * task-archive-pending-modal — AC1.
 *
 * THE RULE: a NEW `status='PENDING'` accrual row (a right to money not yet
 * earned) must never be minted for an archived person. Owner's framing:
 * salary, senior-income-with-unpaid-share, drop-income-with-unpaid-share —
 * three categories, `AC1` demands each one be provably restricted to active
 * employees.
 *
 * WHAT WAS ALREADY TRUE (verified by reading, not assumed):
 *   - `createMonthlySalaries` (the cron) — both branches already filter on
 *     `archivedAt` (HR/ACCOUNTANT via the query, JUNIOR via the loop) — pinned
 *     by `salary-archived-receiver.unit.spec.ts`.
 *   - `createSalary` (manual ADMIN/ACCOUNTANT-initiated) — already refuses an
 *     archived receiver inline — also pinned by that same file.
 *
 * WHAT WAS MISSING (fixed by this task): `createSeniorIncome` /
 * `createDropIncome` had NO archival check of their own — they relied
 * entirely on `JwtAuthGuard` rejecting an archived session. That guard's
 * role/archived cache has a 60s TTL (jwt.guard.ts), so a request already
 * in flight when an archive commits can still reach the write within that
 * window. Both methods now check the row they already load (`senior` /
 * `dropUser`) before doing anything else.
 *
 * TWO PARTS BELOW:
 *   1. An ENUMERATING completeness scan (same technique as
 *      `archived-entitlement.unit.spec.ts`'s `collectUsersWriters`) — proves
 *      the FULL SET of `status='PENDING'` accrual sites in
 *      transactions.service.ts is exactly the 5 this task audited, so a new
 *      unguarded 6th site fails this test by name instead of silently
 *      shipping.
 *   2. Behavioural red/green specs for the two methods this task actually
 *      changed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const SRC_FILE = path.resolve(import.meta.dirname, 'transactions.service.ts')

// ── Part 1: enumerating completeness ────────────────────────────────────────

/**
 * Every method in transactions.service.ts that inserts a `transactions` row
 * with a literal `status: 'PENDING'`, and why it is (or is not) an accrual
 * this task's rule applies to. Adding a row here is a deliberate act.
 */
const KNOWN_PENDING_ACCRUAL_SITES: Record<string, string> = {
  // Fixed by this task (AC1) — see file docblock.
  createSeniorIncome: 'SENIOR_INCOME — now refuses an archived senior',
  createDropIncome: 'DROP_INCOME — now refuses an archived drop',
  // Already correct before this task — pinned by salary-archived-receiver.unit.spec.ts.
  createSalary: 'SALARY (manual) — already refuses archived receiver.role check',
  // Same method name appears TWICE — once per branch (HR/ACCOUNTANT query
  // filter, JUNIOR loop check). Both already correct; see that file too.
  createMonthlySalaries:
    'SALARY (cron) — HR/ACCOUNTANT + JUNIOR branches, both already archived-gated',
}

/**
 * Scans the file for `status: 'PENDING'` (or `'PENDING' as const`) literals
 * that belong to a `transactions` row insert — distinguished from the
 * `pending_obligations` table's OWN `status: 'PENDING'` literal (Phase 4-A
 * `SENIOR_PENDING_PAYOUT`/`DROP_PENDING_PAYOUT` booking) by requiring a
 * `type: '<TRANSACTION_TYPE>'` literal within the same values object —
 * `pending_obligations` rows have `creditorUserId`/`debtorType`, never `type`.
 *
 * Tracks the enclosing method the same way `archived-entitlement.unit.spec.ts`
 * does: 2-space class-member indentation, skip comments.
 */
function scanPendingAccrualSites(): Array<{ method: string; line: number }> {
  const METHOD =
    /^ {2}(?:private |public |protected |readonly |static )*(?:async )?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/
  const STATUS_PENDING = /^\s*status:\s*'PENDING'(\s+as const)?,\s*$/
  const TYPE_LITERAL = /^\s*type:\s*'([A-Z_]+)'(\s+as const)?,\s*$/

  const lines = readFileSync(SRC_FILE, 'utf8').split('\n')
  const out: Array<{ method: string; line: number }> = []
  let method: string | null = null
  let inBlockComment = false

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      return
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true
      return
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return

    const methodMatch = METHOD.exec(line)
    if (methodMatch?.[1]) method = methodMatch[1]

    if (STATUS_PENDING.test(line)) {
      // Look backward (within the same values-object — 20 lines is generous
      // for every site actually in this file) for a sibling `type:` literal.
      // Its ABSENCE means this is a `pending_obligations` row, not a
      // `transactions` row, and is deliberately not counted.
      const hasTypeLiteral = lines
        .slice(Math.max(0, index - 20), index)
        .some((l) => TYPE_LITERAL.test(l))
      if (hasTypeLiteral) {
        out.push({ method: method ?? '<top-level>', line: index + 1 })
      }
    }
  })
  return out
}

describe('transactions.service.ts — every PENDING-accrual site is accounted for (AC1)', () => {
  it('the discovered set of methods matches the inventory exactly', () => {
    const sites = scanPendingAccrualSites()
    const methodsFound = new Set(sites.map((s) => s.method))

    // Fails in both directions: an unlisted method is a new, unaudited
    // accrual site; a listed one that vanished means the inventory describes
    // code that is gone.
    expect([...methodsFound].sort()).toEqual(Object.keys(KNOWN_PENDING_ACCRUAL_SITES).sort())
  })

  it('createMonthlySalaries appears exactly twice (HR/ACCOUNTANT branch + JUNIOR branch)', () => {
    const sites = scanPendingAccrualSites()
    expect(sites.filter((s) => s.method === 'createMonthlySalaries')).toHaveLength(2)
  })

  it('the scan is not vacuous — it really finds createSeniorIncome', () => {
    const sites = scanPendingAccrualSites()
    expect(sites.some((s) => s.method === 'createSeniorIncome')).toBe(true)
    // Sanity on total count: 2 (income) + 1 (manual salary) + 2 (cron) = 5.
    expect(sites).toHaveLength(5)
  })
})

// ── Part 2: behavioural red/green for the two methods this task fixed ──────

const ACTIVE_SENIOR = {
  id: 'senior-1',
  role: 'SENIOR' as const,
  archivedAt: null as Date | null,
  seniorSharePercent: 26,
}
const ARCHIVED_SENIOR = {
  ...ACTIVE_SENIOR,
  archivedAt: new Date('2026-02-28T00:00:00.000Z'),
}

const ACTIVE_DROP = {
  id: 'drop-1',
  role: 'DROP' as const,
  archivedAt: null as Date | null,
  dropSharePercent: 5,
}
const ARCHIVED_DROP = {
  ...ACTIVE_DROP,
  archivedAt: new Date('2026-02-28T00:00:00.000Z'),
}

const SENIOR_PROJECT = {
  id: 'proj-1',
  seniorId: ACTIVE_SENIOR.id,
  dropId: null,
  paymentType: 'FOP' as const,
  companyName: 'Acme',
  seniorSharePercentOverride: null,
  financeSettings: null,
}

const DROP_PROJECT = {
  id: 'proj-2',
  seniorId: null,
  dropId: ACTIVE_DROP.id,
  paymentType: 'FOP' as const,
  companyName: 'Acme',
  dropSharePercentOverride: null,
}

const CURRENT_SENIOR_SESSION = {
  id: ACTIVE_SENIOR.id,
  role: 'SENIOR' as const,
  displayName: 'Senior One',
  email: 'senior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const CURRENT_DROP_SESSION = {
  id: ACTIVE_DROP.id,
  role: 'DROP' as const,
  displayName: 'Drop One',
  email: 'drop@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 0,
}

describe('createSeniorIncome — AC1: an archived senior is refused before any INSERT', () => {
  function makeService(project: unknown, senior: unknown, onInsert?: () => never) {
    const db = {
      db: {
        query: {
          projects: { findFirst: vi.fn().mockResolvedValue(project) },
          users: { findFirst: vi.fn().mockResolvedValue(senior) },
          teamMembers: { findMany: vi.fn().mockRejectedValue(new Error('unstubbed')) },
        },
        insert:
          onInsert ??
          vi.fn(() => {
            throw new Error('INSERT REACHED')
          }),
      },
    } as never
    return makeTransactionsService({ db })
  }

  const payload = {
    projectId: SENIOR_PROJECT.id,
    amount: 1000,
    currency: 'USD',
    receiptExternalUrl: 'https://drive.google.com/file/d/1abc/view',
  }

  it('refuses with the archived-receiver message; does not reach the INSERT', async () => {
    const svc = makeService(SENIOR_PROJECT, ARCHIVED_SENIOR)

    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toThrow(
      'Пользователь архивирован — доход не декларируется',
    )
    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('lets an ACTIVE senior through the gate (reaches the INSERT)', async () => {
    const svc = makeService(SENIOR_PROJECT, ACTIVE_SENIOR)

    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )
  })
})

describe('createDropIncome — AC1: an archived drop is refused before any INSERT', () => {
  function makeService(project: unknown, dropUser: unknown, onInsert?: () => never) {
    const db = {
      db: {
        query: {
          projects: { findFirst: vi.fn().mockResolvedValue(project) },
          users: { findFirst: vi.fn().mockResolvedValue(dropUser) },
        },
        insert:
          onInsert ??
          vi.fn(() => {
            throw new Error('INSERT REACHED')
          }),
      },
    } as never
    return makeTransactionsService({ db })
  }

  const payload = {
    projectId: DROP_PROJECT.id,
    amount: 500,
    currency: 'USD',
    receiptExternalUrl: 'https://drive.google.com/file/d/2def/view',
  }

  it('refuses with the archived-receiver message; does not reach the INSERT', async () => {
    const svc = makeService(DROP_PROJECT, ARCHIVED_DROP)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toThrow(
      'Пользователь архивирован — доход не декларируется',
    )
    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('lets an ACTIVE drop through the gate (reaches the INSERT)', async () => {
    const svc = makeService(DROP_PROJECT, ACTIVE_DROP)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )
  })

  it('does not fire when the drop user row failed to resolve (undefined, not archived)', async () => {
    // `dropUser` is looked up with no NotFoundException guard in the source —
    // `dropUser?.archivedAt` must not throw or false-positive on `undefined`.
    const svc = makeService(DROP_PROJECT, undefined)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )
  })
})
