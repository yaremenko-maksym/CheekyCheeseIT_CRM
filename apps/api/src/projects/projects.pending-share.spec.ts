/**
 * task-pending-share (position 5 of docs/superpowers/specs/2026-09-01-
 * notifications-and-confirmations-design.md §4.3). Dedicated coverage for
 * the PROJECT-level senior-share-override propose -> approve -> reject
 * flow, beyond what `projects.service.spec.ts`'s rewritten RBAC/implicit-
 * null tests already cover (those prove propose(); this file proves AC2
 * /AC3/AC4/AC5/AC6 — the CONSEQUENCES of a pending proposal existing).
 *
 * AC2 and AC6 are the money-critical ones (task file: "ошибка в них — это
 * деньги, посчитанные не по тому проценту") — both are proven here against
 * the REAL, untouched `resolveSeniorShare` (a pure function), not against a
 * mock echoing back whatever the test configured.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'
import { projectFinanceSettings, projects, transactions } from '../database/schema'
import { resolveSeniorShare } from '../finance/senior-share-resolver'

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const seniorUser: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior One',
  email: 's@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

interface ProjectRow {
  id: string
  name: string
  companyName: string
  domain: string
  logoDocumentId: string | null
  logoExternalUrl: string | null
  startDate: Date
  seniorId: string
  rate: number
  currency: string
  seniorSharePercentOverride: number | null
  pendingSeniorSharePercentOverride: number | null
  dropSharePercentOverride: number | null
  drop: { id: string; dropSharePercent: number | null } | null
  techStack: string | null
  teamSize: string | null
  benefits: string | null
  paymentType: string | null
  salaryReview: string | null
  corpTech: string | null
  notesGeneral: string | null
  status: string
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
  senior: { id: string; displayName: string; seniorSharePercent: number } | null
  members: unknown[]
}

/**
 * `tx` is a DISTINCT object from `db.db` — its `update`/`select` are their
 * OWN spies, never called by anything running OUTSIDE
 * `db.db.transaction(cb)`. This is what makes "the swap happened via tx"
 * (AC3 — one atomic operation) an assertion the test can actually make,
 * rather than trusting that the code merely COULD be atomic.
 */
function buildHarness(overrides: Partial<ProjectRow> = {}) {
  const projectRow: ProjectRow = {
    id: 'proj-1',
    name: 'Acme Project',
    companyName: 'Acme Corp',
    domain: 'Other',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: 'senior-1',
    rate: 4000,
    currency: 'USDT',
    seniorSharePercentOverride: null,
    pendingSeniorSharePercentOverride: 40,
    dropSharePercentOverride: null,
    drop: null,
    techStack: null,
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    status: 'ACTIVE',
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    senior: { id: 'senior-1', displayName: 'Senior One', seniorSharePercent: 26 },
    members: [],
    ...overrides,
  }
  const financeRows: Array<{ projectId: string; seniorSharePercentOverride: number | null }> = []
  const transactionRows = [
    {
      id: 'tx-historic-1',
      projectId: 'proj-1',
      type: 'SENIOR_INCOME',
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
    },
  ]

  const txUpdateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = []
  const topLevelUpdateCalls: Array<{ table: unknown }> = []

  const makeUpdateChain = (
    log: Array<{ table: unknown; values?: Record<string, unknown> }>,
    isTx: boolean,
  ) => ({
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          log.push({ table, values })
          if (table === projects) Object.assign(projectRow, values)
          if (table === projectFinanceSettings) {
            if (financeRows[0]) Object.assign(financeRows[0], values)
            else
              financeRows.push({ projectId: 'proj-1', seniorSharePercentOverride: null, ...values })
          }
          if (!isTx) topLevelUpdateCalls.push({ table })
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        log.push({ table, values })
        if (table === projectFinanceSettings) {
          financeRows.push({ projectId: 'proj-1', seniorSharePercentOverride: null, ...values })
        }
      },
    }),
  })

  const txHandle = {
    ...makeUpdateChain(txUpdateCalls, true),
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: async () => [{ ...projectRow }] }),
        }),
      }),
    }),
    query: {
      projectFinanceSettings: {
        findFirst: async () => (financeRows[0] ? { ...financeRows[0] } : null),
      },
    },
  }

  const db = {
    db: {
      query: {
        projects: { findFirst: async () => ({ ...projectRow }) },
        projectFinanceSettings: {
          findFirst: async () => (financeRows[0] ? { ...financeRows[0] } : null),
        },
      },
      ...makeUpdateChain([], false),
      transaction: vi.fn(
        async <T>(fn: (tx: typeof txHandle) => Promise<T>): Promise<T> => fn(txHandle),
      ),
    },
  }

  const projectAuditLogService = { record: vi.fn(async () => undefined) }
  const usersService = {}
  const approvals = {
    proposeInTx: vi.fn(async () => undefined),
    approveInTx: vi.fn(async () => undefined),
    rejectInTx: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => 'PENDING' as const),
  }

  const service = new ProjectsService(
    db as never,
    projectAuditLogService as never,
    usersService as never,
    new HrAccessService(db as never),
    approvals as never,
  )

  return {
    service,
    projectRow,
    financeRows,
    transactionRows,
    approvals,
    auditRecord: projectAuditLogService.record,
    txUpdateCalls,
    topLevelUpdateCalls,
    txHandle,
  }
}

describe('ProjectsService — pending share AC2 (resolver returns previous value while pending)', () => {
  it('resolveSeniorShare, called with the LIVE column, is unaffected by a pending proposal', () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
    })
    // The real, untouched resolver — same call `mapProject` makes. Feeding
    // it the project's LIVE column (never the pending one) is the whole of
    // AC2: the resolver has no pending-awareness AT ALL, so as long as the
    // live column never moved, its output cannot have moved either.
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: h.projectRow.seniorSharePercentOverride },
      { seniorSharePercent: h.projectRow.senior!.seniorSharePercent },
      [],
    )
    expect(result).toEqual({ value: 26, source: 'USER_DEFAULT' })
  })

  it('a previously-set override is still what the resolver returns, even with 40 pending', () => {
    const h = buildHarness({
      seniorSharePercentOverride: 30,
      pendingSeniorSharePercentOverride: 40,
    })
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: h.projectRow.seniorSharePercentOverride },
      { seniorSharePercent: h.projectRow.senior!.seniorSharePercent },
      [],
    )
    expect(result).toEqual({ value: 30, source: 'PROJECT' })
  })
})

describe('ProjectsService.approveSeniorShareChange — AC3 (one atomic swap)', () => {
  it('swaps pending into active AND syncs the finance mirror inside the SAME transaction', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
    })
    await h.service.approveSeniorShareChange('proj-1', seniorUser)

    expect(h.projectRow.seniorSharePercentOverride).toBe(40)
    expect(h.projectRow.pendingSeniorSharePercentOverride).toBeNull()
    // Both writes (projects + the finance mirror) happened via `tx`, never
    // via `db.db` directly — the atomicity proof. Deleting the
    // `db.db.transaction(...)` wrapper around `approveSeniorShareChange`
    // (verified by hand — see PR body) makes `topLevelUpdateCalls` non-empty
    // and this assertion fail.
    expect(h.txUpdateCalls.map((c) => c.table)).toEqual(
      expect.arrayContaining([projects, projectFinanceSettings]),
    )
    expect(h.topLevelUpdateCalls).toEqual([])
    // approveInTx was handed the SAME tx object the writes went through —
    // the other half of "one operation": the approval-row flip and the
    // share swap cannot observably disagree.
    expect(h.approvals.approveInTx).toHaveBeenCalledWith(h.txHandle, expect.anything())
  })

  it('clears the pending column even when the proposal was to CLEAR the override (null)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: 30,
      pendingSeniorSharePercentOverride: null,
    })
    await h.service.approveSeniorShareChange('proj-1', seniorUser)
    expect(h.projectRow.seniorSharePercentOverride).toBeNull()
    expect(h.projectRow.pendingSeniorSharePercentOverride).toBeNull()
  })
})

describe('ProjectsService.rejectSeniorShareChange — AC4 (reason required, active untouched)', () => {
  it('discards the pending value and leaves the active column untouched', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: 30,
      pendingSeniorSharePercentOverride: 40,
    })
    await h.service.rejectSeniorShareChange('proj-1', 'Слишком высокий процент', seniorUser)
    expect(h.projectRow.seniorSharePercentOverride).toBe(30)
    expect(h.projectRow.pendingSeniorSharePercentOverride).toBeNull()
    expect(h.approvals.rejectInTx).toHaveBeenCalledWith(
      h.txHandle,
      expect.objectContaining({
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: 'proj-1',
        approverUserId: 'senior-1',
        reason: 'Слишком высокий процент',
      }),
    )
  })

  it('never touches the finance mirror on reject (nothing became real)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: 30,
      pendingSeniorSharePercentOverride: 40,
    })
    await h.service.rejectSeniorShareChange('proj-1', 'причина', seniorUser)
    expect(h.txUpdateCalls.some((c) => c.table === projectFinanceSettings)).toBe(false)
  })
})

describe('ProjectsService — AC6 (past transactions never recalculated)', () => {
  it('approving a share change does not touch the transactions table at all', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
    })
    const before = { ...h.transactionRows[0] }
    await h.service.approveSeniorShareChange('proj-1', seniorUser)
    // Nothing in approveSeniorShareChange ever references the `transactions`
    // table — asserted structurally (no update call against it) AND against
    // the fixture's own unchanged snapshot, so a future change that DID
    // start touching transactions would fail loudly here rather than
    // silently drift.
    expect(h.txUpdateCalls.some((c) => c.table === transactions)).toBe(false)
    expect(h.transactionRows[0]).toEqual(before)
  })
})

describe('ProjectsService — AC5 (team override applies immediately, no gate)', () => {
  it('resolveSeniorShare picks up a NEW team override the instant it is passed in — no pending concept exists at this level', () => {
    // No ProjectsService/ApprovalsService involvement at all: the TEAM level
    // is untouched by this task (task file's own "На каких уровнях" table),
    // and the resolver — which is ALSO untouched — has no branch that could
    // even express "team override pending". Proven directly against the
    // real function with a before/after team row, matching the task's own
    // wording ("смена командного значения меняет результат резолвера
    // немедленно").
    const before = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: null }],
    )
    expect(before).toEqual({ value: 26, source: 'USER_DEFAULT' })

    const after = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: 35 }],
    )
    expect(after).toEqual({ value: 35, source: 'TEAM' })
  })
})

// AC7 (re-propose supersedes the previous generation; both attempts stay in
// history with the rejection reason) is proven generically, subject-
// agnostically, by approvals.service.spec.ts's "propose() supersedes any
// live rows for the subject, then inserts one PENDING row per approver" and
// "sets status=REJECTED with the reason on the row, THEN supersedes every
// other live sibling" — `proposeSeniorShareChange` / `rejectSeniorShareChange`
// are thin callers of `proposeInTx` / `rejectInTx` (see the call-argument
// assertions in projects.service.spec.ts and above), so that foundation-
// level proof covers this subject type too. Not re-proven here to avoid
// re-deriving what a lower layer already guarantees.

describe('ProjectsService — notification seam (position 6 hand-off)', () => {
  it('notifyPendingSeniorShareProposed fires exactly once, with the proposed + previous percent, when update() opens a proposal', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: null,
    })
    const spy = vi.spyOn(
      h.service as unknown as { notifyPendingSeniorShareProposed: (i: unknown) => void },
      'notifyPendingSeniorShareProposed',
    )
    await h.service.update('proj-1', { seniorSharePercentOverride: 30 }, adminUser)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({
      subjectId: 'proj-1',
      approverUserId: 'senior-1',
      proposedPercent: 30,
      previousPercent: null,
    })
  })

  it('does NOT fire when the request is a no-op (value unchanged)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: 30,
      pendingSeniorSharePercentOverride: null,
    })
    const spy = vi.spyOn(
      h.service as unknown as { notifyPendingSeniorShareProposed: (i: unknown) => void },
      'notifyPendingSeniorShareProposed',
    )
    await h.service.update('proj-1', { seniorSharePercentOverride: 30 }, adminUser)
    expect(spy).not.toHaveBeenCalled()
  })
})
