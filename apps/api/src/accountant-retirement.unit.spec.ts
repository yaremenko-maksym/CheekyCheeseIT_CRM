/**
 * ACCOUNTANT retirement (design §13.3, PR 1b). The role stays in `roleSchema` / the Postgres
 * enum until PR 1d, so a legacy ACCOUNTANT row or session can still exist. This spec is the
 * one place that names the role: it proves that the API grants such a row or session nothing.
 *
 * - AC 5: team reconcile never touches the `team_members` row of a former accountant.
 * - Master addendum: `TransactionsService.findAll` is an allowlist — an ACCOUNTANT session
 *   gets `[]`, while ADMIN over the same data gets the row (so the empty result is not vacuous).
 * - AC 3: the deleted document read-all branches (SCAN / RECEIPT / INVOICE) and the RESUME/SCAN
 *   upload refusal — an ACCOUNTANT session sees only its own AVATAR / INVOICE rows and cannot upload.
 */
import { describe, expect, it, vi } from 'vitest'
import { HttpException } from '@nestjs/common'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { DocumentCategory, Role, SessionUser } from '@crm/shared'
import type { DatabaseService } from './database/database.service'
import type { HrAccessService } from './common/hr-access.service'
import { TeamReconcileService } from './users/team-reconcile.service'
import { makeTransactionsService } from './finance/__test-helpers__/make-transactions-service'
import { buildVisibilityClause } from './documents/document-visibility.util'
import { assertCanUpload } from './documents/document-upload-rbac.util'
import { assertCanAddMember } from './projects/project-members.util'
import { buildEffectiveTeam } from './projects/project-team.util'
import type { ProjectWithRelations } from './projects/project-map.util'

const dialect = new PgDialect()
const LEGACY: Role = 'ACCOUNTANT'

describe('AC 3 — documents: no read-all, no upload', () => {
  const CAT = '"documents"."category"'
  const OWN = '"documents"."owner_id"'
  const vis = async (category: DocumentCategory) => {
    const r = await buildVisibilityClause(
      { db: {} } as unknown as DatabaseService,
      {} as unknown as HrAccessService,
      { id: 'u-1', role: LEGACY } as unknown as SessionUser,
      { category },
    )
    if (r === null || r === 'NONE') return r
    const { sql, params } = dialect.sqlToQuery(r)
    return { sql, params }
  }

  it('SCAN / RECEIPT / RESUME / CONTRACT / LOGO -> NONE; AVATAR / INVOICE -> own rows only', async () => {
    for (const c of ['SCAN', 'RECEIPT', 'RESUME', 'CONTRACT', 'LOGO'] as const) {
      expect(await vis(c)).toBe('NONE')
    }
    for (const c of ['AVATAR', 'INVOICE'] as const) {
      expect(await vis(c)).toEqual({ sql: `(${CAT} = $1 and ${OWN} = $2)`, params: [c, 'u-1'] })
    }
  })

  it.each(['RESUME', 'SCAN', 'LOGO', 'RECEIPT', 'CONTRACT'] as const)(
    'upload of %s for self -> 403',
    (category) => {
      let status: number | undefined
      try {
        assertCanUpload(LEGACY, 'u-1', category, 'u-1')
      } catch (e) {
        status = (e as HttpException).getStatus()
      }
      expect(status).toBe(403)
    },
  )
})

describe('AC 5 — reconcile leaves a former accountant team_members row untouched', () => {
  function makeTx(selects: unknown[][]) {
    const queue = [...selects]
    const updates: Array<{ table: string; set: Record<string, unknown>; params: unknown[] }> = []
    const tx = {
      select: vi.fn(() => {
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: () => {
            const rows = queue.shift()
            if (rows === undefined) throw new Error('unexpected extra tx.select()')
            const p = Promise.resolve(rows)
            return { then: p.then.bind(p) }
          },
        }
        return chain
      }),
      update: vi.fn((t: never) => ({
        set: (set: Record<string, unknown>) => ({
          where: async (cond: SQL) => {
            updates.push({ table: getTableName(t), set, params: dialect.sqlToQuery(cond).params })
          },
        }),
      })),
      insert: vi.fn(),
    }
    return { tx, updates }
  }

  it('clearing every HR removes the HR only; the ACCOUNTANT row gets no leftAt and no audit', async () => {
    const { tx, updates } = makeTx([
      [{ teamId: 'team-1' }],
      [
        { userId: 'hr-1', id: 'tm-1', role: 'HR' },
        { userId: 'acc-legacy', id: 'tm-2', role: 'ACCOUNTANT' },
      ],
    ])
    const record = vi.fn(async () => undefined)
    const service = new TeamReconcileService({ record } as never)
    const reconcile = (
      service as unknown as {
        reconcileSeniorTeamTx: (
          tx: unknown,
          seniorId: string,
          data: { hrIds?: string[] },
          actorId: string | null,
        ) => Promise<void>
      }
    ).reconcileSeniorTeamTx.bind(service)

    await reconcile(tx, 'sn-1', { hrIds: [] }, 'admin-1')

    expect(updates).toEqual([
      { table: 'team_members', set: { leftAt: expect.any(Date) }, params: ['team-1', 'hr-1'] },
    ])
    expect(record).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(record.mock.calls)).not.toContain('acc-legacy')
    expect(tx.insert).not.toHaveBeenCalled()
  })
})

describe('Master addendum — TransactionsService.findAll is an allowlist', () => {
  const VIEWER_ID = '11111111-1111-4111-8111-111111111111'
  // The viewer is both parties, so any party-based branch would let the row through.
  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    type: 'SALARY',
    status: 'PAID',
    amount: '100.000000',
    currency: 'USDT',
    settledAmount: null,
    settledCurrency: null,
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    senderId: VIEWER_ID,
    senderLabel: null,
    receiverId: VIEWER_ID,
    receiverLabel: null,
    projectId: null,
    payoutRequestId: null,
    dropCascadeOrigin: null,
    seniorSharePercent: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    fundingSource: null,
    createdBy: VIEWER_ID,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    sender: { displayName: 'Viewer', role: 'ADMIN' },
    receiver: { displayName: 'Viewer', role: 'ADMIN' },
    project: null,
    payoutRequest: null,
  }
  const svc = makeTransactionsService({
    db: { db: { query: { transactions: { findMany: async () => [row] } } } } as never,
  })
  const session = (role: string): SessionUser =>
    ({
      id: VIEWER_ID,
      email: 'v@example.com',
      displayName: 'V',
      avatarUrl: null,
      role,
    }) as SessionUser

  it('ADMIN over the same data gets the row', async () => {
    expect(await svc.findAll(session('ADMIN'))).toHaveLength(1)
  })

  it.each(['ACCOUNTANT', 'UNKNOWN_ROLE'])('a %s session gets []', async (role) => {
    expect(await svc.findAll(session(role))).toEqual([])
  })
})

describe('AC 3 — projects: no seat, no team slot', () => {
  it('a legacy ACCOUNTANT cannot be added to a project', () => {
    expect(() => assertCanAddMember({ archivedAt: null, role: LEGACY })).toThrow(HttpException)
  })

  it('a legacy ACCOUNTANT team row fills neither hrs nor accountants', () => {
    const project = { senior: null, drop: null, members: [] } as unknown as ProjectWithRelations
    const legacyRow = {
      id: 'tm-acc',
      userId: 'acc-legacy',
      displayName: 'Legacy',
      email: 'acc@x.test',
      avatarUrl: null,
      avatarDocumentId: null,
      role: LEGACY,
    }
    const team = buildEffectiveTeam(project, 'ADMIN', [legacyRow])
    expect(team.hrs).toEqual([])
    expect(team.accountants).toEqual([])
  })
})
