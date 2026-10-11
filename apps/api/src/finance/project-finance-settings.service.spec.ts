/**
 * Unit coverage for ProjectFinanceSettingsService (moved verbatim out of
 * TransactionsService): role gate, upsert writes (insert vs update, the
 * projects mirror of the senior-share override) and the read-back.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { getTableName } from 'drizzle-orm'
import { ProjectFinanceSettingsService } from './project-finance-settings.service'

function user(role: SessionUser['role']): SessionUser {
  return {
    id: `${role}-1`,
    role,
    displayName: role,
    email: `${role}@test.spec`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

function makeDb(opts: {
  project?: { status: string } | undefined
  existing?: unknown
  readBack?: unknown
}) {
  const projectsFindFirst = vi.fn(async () => opts.project)
  const readBackFindFirst = vi.fn(async () => opts.readBack ?? null)
  const txFindFirst = vi.fn(async () => opts.existing)
  const setCalls: Array<{ table: string; values: unknown }> = []
  const insertCalls: Array<{ table: string; values: unknown }> = []
  const whereCalls: unknown[] = []
  const tx = {
    query: { projectFinanceSettings: { findFirst: txFindFirst } },
    update: (table: never) => ({
      set: (values: unknown) => {
        setCalls.push({ table: getTableName(table), values })
        return {
          where: async (w: unknown) => {
            whereCalls.push(w)
          },
        }
      },
    }),
    insert: (table: never) => ({
      values: async (values: unknown) => {
        insertCalls.push({ table: getTableName(table), values })
      },
    }),
  }
  const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx))
  const db = {
    db: {
      query: {
        projects: { findFirst: projectsFindFirst },
        projectFinanceSettings: { findFirst: readBackFindFirst },
      },
      transaction,
    },
  }
  return { db, setCalls, insertCalls, transaction, readBackFindFirst, txFindFirst }
}

describe('ProjectFinanceSettingsService role gate', () => {
  for (const role of ['SENIOR', 'JUNIOR', 'HR', 'DROP'] as const) {
    it(`${role} is forbidden to read and write; no db access`, async () => {
      const { db, transaction, readBackFindFirst } = makeDb({ project: { status: 'ACTIVE' } })
      const svc = new ProjectFinanceSettingsService(db as never)
      await expect(svc.getProjectFinanceSettings('p1', user(role))).rejects.toMatchObject({
        status: 403,
      })
      await expect(
        svc.upsertProjectFinanceSettings('p1', { seniorSharePercentOverride: 10 }, user(role)),
      ).rejects.toMatchObject({ status: 403 })
      expect(transaction).not.toHaveBeenCalled()
      expect(readBackFindFirst).not.toHaveBeenCalled()
    })
  }

  it('upsert on a missing project is 404 PROJECT_NOT_FOUND for ADMIN', async () => {
    const { db, transaction } = makeDb({ project: undefined })
    const svc = new ProjectFinanceSettingsService(db as never)
    await expect(
      svc.upsertProjectFinanceSettings('p1', { seniorSharePercentOverride: 10 }, user('ADMIN')),
    ).rejects.toMatchObject({ status: 404, response: { code: 'PROJECT_NOT_FOUND' } })
    expect(transaction).not.toHaveBeenCalled()
  })
})

describe('ProjectFinanceSettingsService.upsertProjectFinanceSettings writes', () => {
  it('inserts when no row exists; stringifies junior salary, mirrors senior share into projects, returns read-back', async () => {
    const readBack = { projectId: 'p1', seniorSharePercentOverride: 30 }
    const { db, insertCalls, setCalls, readBackFindFirst } = makeDb({
      project: { status: 'ACTIVE' },
      existing: undefined,
      readBack,
    })
    const svc = new ProjectFinanceSettingsService(db as never)
    const res = await svc.upsertProjectFinanceSettings(
      'p1',
      { seniorSharePercentOverride: 30, juniorSalaryOverride: 500 },
      user('ADMIN'),
    )
    expect(res).toBe(readBack)
    expect(readBackFindFirst).toHaveBeenCalledTimes(1)
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]!.table).toBe('project_finance_settings')
    expect(insertCalls[0]!.values).toMatchObject({
      projectId: 'p1',
      seniorSharePercentOverride: 30,
      juniorSalaryOverride: '500',
      updatedBy: 'ADMIN-1',
    })
    expect((insertCalls[0]!.values as { updatedAt: unknown }).updatedAt).toBeInstanceOf(Date)
    expect(setCalls).toEqual([{ table: 'projects', values: { seniorSharePercentOverride: 30 } }])
  })

  it('updates (no insert) when a row exists; junior salary 0 is stringified, not nulled', async () => {
    const { db, insertCalls, setCalls } = makeDb({
      project: { status: 'ACTIVE' },
      existing: { projectId: 'p1' },
    })
    const svc = new ProjectFinanceSettingsService(db as never)
    await svc.upsertProjectFinanceSettings(
      'p1',
      { seniorSharePercentOverride: 20, juniorSalaryOverride: 0 },
      user('ACCOUNTANT'),
    )
    expect(insertCalls).toHaveLength(0)
    expect(setCalls).toHaveLength(2)
    expect(setCalls[0]!.table).toBe('project_finance_settings')
    expect(setCalls[0]!.values).toMatchObject({
      seniorSharePercentOverride: 20,
      juniorSalaryOverride: '0',
      updatedBy: 'ACCOUNTANT-1',
    })
    expect(setCalls[1]).toEqual({ table: 'projects', values: { seniorSharePercentOverride: 20 } })
  })

  it('omitted fields null the settings columns and skip the projects mirror', async () => {
    const { db, setCalls, insertCalls } = makeDb({
      project: { status: 'ACTIVE' },
      existing: undefined,
    })
    const svc = new ProjectFinanceSettingsService(db as never)
    await svc.upsertProjectFinanceSettings('p1', {}, user('ADMIN'))
    expect(insertCalls[0]!.values).toMatchObject({
      seniorSharePercentOverride: null,
      juniorSalaryOverride: null,
    })
    expect(setCalls).toHaveLength(0)
  })

  it('explicit null clears the override and IS mirrored into projects as null', async () => {
    const { db, setCalls } = makeDb({
      project: { status: 'ACTIVE' },
      existing: { projectId: 'p1' },
    })
    const svc = new ProjectFinanceSettingsService(db as never)
    await svc.upsertProjectFinanceSettings(
      'p1',
      { seniorSharePercentOverride: null, juniorSalaryOverride: null },
      user('ADMIN'),
    )
    expect(setCalls[0]!.values).toMatchObject({
      seniorSharePercentOverride: null,
      juniorSalaryOverride: null,
    })
    expect(setCalls[1]).toEqual({ table: 'projects', values: { seniorSharePercentOverride: null } })
  })
})
