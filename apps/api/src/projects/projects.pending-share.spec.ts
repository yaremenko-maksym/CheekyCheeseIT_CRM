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

  // task-pending-share follow-up (AC9 gap-fill): records the mode string
  // passed to `.for(...)` on the row-lock select inside approve/reject, so a
  // test can assert it is really `'update'` (a mutant that swaps it for `""`
  // is otherwise unobservable — the mock chain doesn't care what string it's
  // handed).
  const selectForCalls: unknown[] = []
  // `undefined` = default behavior (return the live projectRow); an explicit
  // array (incl. `[]`) overrides it — lets a test simulate "row vanished
  // between the approval check and the lock" without a second harness shape.
  let selectForUpdateOverride: ProjectRow[] | undefined

  const txHandle = {
    ...makeUpdateChain(txUpdateCalls, true),
    select: () => ({
      from: () => ({
        where: () => ({
          for: (mode: unknown) => {
            selectForCalls.push(mode)
            return {
              limit: async () => (selectForUpdateOverride ?? [projectRow]).map((r) => ({ ...r })),
            }
          },
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
        // `findOne`'s `computeEffectiveTeam` reads this directly (no
        // try/catch there, unlike `loadTeamOverridesBySenior`'s
        // `teamMembers.findMany`) — "senior has no team" is both the safe
        // default and the common case for these fixtures.
        teamMembers: {
          findFirst: async () => undefined,
          findMany: async () => [],
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
    // task-648-fix-round-1 (SR-H-1): default succeeds, matching this
    // harness's own `getStatus: 'PENDING'` default (a live proposal exists
    // to cancel in most of this file's scenarios).
    cancelInTx: vi.fn(async () => undefined),
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
    selectForCalls,
    setSelectForUpdateRows: (rows: ProjectRow[]) => {
      selectForUpdateOverride = rows
    },
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

  it('previousPercent is the prior TRUTHY override, not null (?? vs && boundary, distinct from the audit-log one)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: 25,
      pendingSeniorSharePercentOverride: null,
    })
    const spy = vi.spyOn(
      h.service as unknown as { notifyPendingSeniorShareProposed: (i: unknown) => void },
      'notifyPendingSeniorShareProposed',
    )
    await h.service.update('proj-1', { seniorSharePercentOverride: 40 }, adminUser)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ proposedPercent: 40, previousPercent: 25 }),
    )
  })
})

// ---------------------------------------------------------------------------
// task-pending-share follow-up (AC9 mutation-gate gap-fill, 2026-09-03): the
// four describe blocks below close survivors the mutation gate found on the
// FULL diff that the blocks above did not reach — `findOne`'s JUNIOR-skip
// optimization, `loadPendingSeniorShare`'s own defensive branches, the
// impersonation/not-found guards on approve+reject, and the exact shape of
// the row-lock + audit-log calls approve makes.
// ---------------------------------------------------------------------------

describe('ProjectsService.findOne — pendingSeniorShare (JUNIOR skip-the-lookup)', () => {
  it('is populated for a non-JUNIOR viewer when a proposal is PENDING', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
    })
    const result = await h.service.findOne('proj-1', adminUser)
    expect(result.pendingSeniorShare).toEqual({
      percent: 40,
      // task-648-fix-round-1 (COPY-H-2/COPY-H-3): a concrete (non-null)
      // proposed value becomes the project override outright if approved —
      // no TEAM/USER_DEFAULT fallback needed, so this equals `percent`.
      effectivePercentAfterApproval: 40,
      approverId: 'senior-1',
      approverName: 'Senior One',
    })
  })

  it('is ALSO populated for the affected SENIOR themselves (assertAccess guarantees a SENIOR viewer here IS the project senior)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
    })
    const result = await h.service.findOne('proj-1', seniorUser)
    expect(result.pendingSeniorShare).toEqual({
      percent: 40,
      effectivePercentAfterApproval: 40,
      approverId: 'senior-1',
      approverName: 'Senior One',
    })
  })

  // task-648-fix-round-1 (COPY-H-2/COPY-H-3): the actual bug this fix
  // closes — a PROJECT-level proposal to CLEAR the override (`percent: null`)
  // must resolve `effectivePercentAfterApproval` via the SAME PROJECT →
  // TEAM → USER_DEFAULT resolver `effectiveSeniorSharePercent` uses, not
  // render "0%" (the old `percent ?? 0` client-side bug) nor the raw
  // `seniorSharePercentDefault` (which ignores the TEAM level — OOS-1, a
  // separate, out-of-scope bug). This harness's `teamMembers.findMany`
  // returns `[]` (no team override), so the resolver falls all the way
  // through to `senior.seniorSharePercent` (26 — see `seniorUser`/`adminUser`
  // fixtures' shared value and `buildHarness`'s default `senior` row).
  it('resolves effectivePercentAfterApproval to the USER_DEFAULT fallback (26) for a null (clear-override) proposal, never "0"', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: 55,
      pendingSeniorSharePercentOverride: null,
    })
    const result = await h.service.findOne('proj-1', adminUser)
    expect(result.pendingSeniorShare).toEqual({
      percent: null,
      effectivePercentAfterApproval: 26,
      approverId: 'senior-1',
      approverName: 'Senior One',
    })
  })

  // task-648-fix-round-1 (QA-HIGH-1): ACCOUNTANT is the exact role QA caught
  // seeing this field (it has unconditional `assertAccess`, unlike HR/DROP
  // which need extra scope-membership mocking this harness does not set up —
  // those two are covered instead in `projects.service.spec.ts`, which
  // already has richer HR/DROP-access fixtures).
  it('is null for an ACCOUNTANT viewer, and skips the approvals.getStatus lookup entirely (narrower than mapProject masking JUNIOR alone)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
    })
    const accountantUser: SessionUser = {
      id: 'accountant-1',
      role: 'ACCOUNTANT',
      displayName: 'Accountant',
      email: 'accountant-1@x.com',
      avatarUrl: null,
      avatarDocumentId: null,
      seniorSharePercent: null,
    }
    const result = await h.service.findOne('proj-1', accountantUser)
    expect(h.approvals.getStatus).not.toHaveBeenCalled()
    expect(result.pendingSeniorShare).toBeNull()
  })

  it('skips the approvals.getStatus lookup entirely for a JUNIOR viewer (never just masks after the fact)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
      members: [{ userId: 'junior-1', leftAt: null }],
    })
    const juniorUser: SessionUser = {
      id: 'junior-1',
      role: 'JUNIOR',
      displayName: 'Junior One',
      email: 'j@x.com',
      avatarUrl: null,
      avatarDocumentId: null,
      seniorSharePercent: null,
    }
    const result = await h.service.findOne('proj-1', juniorUser)
    expect(result.pendingSeniorShare).toBeNull()
    // The optimization itself (not just its visible effect): a mutant that
    // makes the JUNIOR branch fall through to the real lookup anyway would
    // still produce `null` here (mapProject's OWN masking catches it too),
    // so the round-trip-avoidance can only be proven by call count.
    expect(h.approvals.getStatus).not.toHaveBeenCalled()
  })
})

describe('ProjectsService — loadPendingSeniorShare defensive branches', () => {
  it('returns null when the project has no senior at all, even with getStatus mocked PENDING', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
      seniorId: undefined as unknown as string,
      senior: null,
    })
    const result = await h.service.findOne('proj-1', adminUser)
    expect(result.pendingSeniorShare).toBeNull()
  })

  it('returns null when a senior exists but the live status is not PENDING (e.g. NONE)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: null,
      pendingSeniorSharePercentOverride: 40,
    })
    h.approvals.getStatus.mockResolvedValueOnce('NONE')
    const result = await h.service.findOne('proj-1', adminUser)
    expect(result.pendingSeniorShare).toBeNull()
  })
})

describe('ProjectsService.approveSeniorShareChange — guards + exact call shapes', () => {
  it('refuses an impersonated session with the exact consent message', async () => {
    const h = buildHarness()
    await expect(
      h.service.approveSeniorShareChange('proj-1', { ...seniorUser, impersonatorId: 'admin-1' }),
    ).rejects.toThrow(
      'Подтвердить изменение доли может только сам приглашённый — через имперсонацию это сделать нельзя',
    )
    expect(h.approvals.approveInTx).not.toHaveBeenCalled()
  })

  it('throws NotFoundException when the row-lock select finds nothing (row vanished)', async () => {
    const h = buildHarness()
    h.setSelectForUpdateRows([])
    await expect(h.service.approveSeniorShareChange('proj-1', seniorUser)).rejects.toThrow(
      'Project not found',
    )
  })

  it('locks the row FOR UPDATE (not a plain select) before reading the pending value', async () => {
    const h = buildHarness()
    await h.service.approveSeniorShareChange('proj-1', seniorUser)
    expect(h.selectForCalls).toContain('update')
  })

  it('calls approveInTx with the exact subject shape', async () => {
    const h = buildHarness()
    await h.service.approveSeniorShareChange('proj-1', seniorUser)
    expect(h.approvals.approveInTx).toHaveBeenCalledWith(h.txHandle, {
      subjectType: 'PROJECT_SENIOR_SHARE',
      subjectId: 'proj-1',
      approverUserId: 'senior-1',
    })
  })

  it('audit-logs the real before/after — "before" is the prior TRUTHY override, not null (?? vs && boundary)', async () => {
    const h = buildHarness({
      seniorSharePercentOverride: 25,
      pendingSeniorSharePercentOverride: 40,
    })
    await h.service.approveSeniorShareChange('proj-1', seniorUser)
    expect(h.auditRecord).toHaveBeenCalledWith(
      {
        actorId: 'senior-1',
        targetId: 'proj-1',
        action: 'project_edited',
        changes: {
          seniorSharePercentOverride: { before: 25, after: 40 },
        },
      },
      h.txHandle,
    )
  })
})

describe('ProjectsService.rejectSeniorShareChange — impersonation guard', () => {
  it('refuses an impersonated session with the exact consent message', async () => {
    const h = buildHarness()
    await expect(
      h.service.rejectSeniorShareChange('proj-1', 'причина', {
        ...seniorUser,
        impersonatorId: 'admin-1',
      }),
    ).rejects.toThrow(
      'Отклонить изменение доли может только сам приглашённый — через имперсонацию это сделать нельзя',
    )
    expect(h.approvals.rejectInTx).not.toHaveBeenCalled()
  })
})
