import { ForbiddenException } from '@nestjs/common'
import { jobSourceListSchema, type SessionUser } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { JobSourceRegistry } from './registry/job-source-registry'
import { JobSourcingService } from './job-sourcing.service'

/**
 * r5 Task 6.5 — `listSources`' additive operational fields, on doubles (the mutation gate never
 * runs the integration specs; job-matching.integration.spec.ts runs the real query). The old
 * fields keep their shape, so an old client's DTO and `SourceBudgetPanel` keep parsing.
 */

const ADMIN = { id: 'a', role: 'ADMIN' } as SessionUser
const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const dialect = new PgDialect()

const at = (iso: string) => new Date(iso)

const ROW = {
  id: ID,
  type: 'REMOTIVE_API',
  enabled: false,
  triggerMode: 'SCHEDULED',
  lastCollectedAt: null,
  disabledReason: null,
  budgetLimit: null,
  budgetWindow: null,
  budgetUsed: 0,
  budgetWindowStartedAt: null,
  readiness: 'BLOCKED',
  readinessReason: 'credential not verified',
  adminState: 'PAUSED',
  lastAttemptAt: at('2026-11-01T08:00:00.000Z'),
  lastSuccessAt: at('2026-10-31T08:00:00.000Z'),
  lastNonemptyAt: at('2026-10-30T08:00:00.000Z'),
  nextAttemptAt: at('2026-11-02T08:00:00.000Z'),
  cooldownUntil: at('2026-11-01T12:00:00.000Z'),
  consecutiveFailures: 2,
  lastErrorCode: 'ACCESS_POLICY',
}

function harness(
  rows: Record<string, unknown>[],
  facts: Record<string, unknown>[],
  transitions: { sourceId: string; toState: string | null; reasonCode: string | null }[] = [],
) {
  const execute = vi.fn(async (_q: SQL) => ({ rows: facts }))
  const selectDistinctOn = vi.fn(() => ({
    from: () => ({ where: () => ({ orderBy: async () => transitions }) }),
  }))
  const db = { db: { select: () => ({ from: async () => rows }), execute, selectDistinctOn } }
  return {
    service: new JobSourcingService(db as never, {} as never, new JobSourceRegistry([])),
    execute,
    selectDistinctOn,
  }
}

describe('listSources — Task 6.5 operational fields', () => {
  it('maps the row and the off-row facts; the answer parses', async () => {
    const h = harness(
      [ROW],
      [
        {
          id: ID,
          paused_until_ms: Date.parse('2026-11-03T00:00:00.000Z'),
          pause_reason: 'HTTP_403',
          cost_unit: 'REQUEST',
          resume_checkpoint: true,
        },
      ],
      [{ sourceId: ID, toState: 'FAILING', reasonCode: 'ACCESS_CHANGED' }],
    )
    const [item] = await h.service.listSources(ADMIN, new Date('2026-11-01T09:00:00.000Z'))
    expect(item).toMatchObject({
      id: ID,
      enabled: false,
      readiness: 'BLOCKED',
      readinessReason: 'credential not verified',
      adminState: 'PAUSED',
      lastAttemptAt: '2026-11-01T08:00:00.000Z',
      lastSuccessAt: '2026-10-31T08:00:00.000Z',
      lastNonemptyAt: '2026-10-30T08:00:00.000Z',
      nextAttemptAt: '2026-11-02T08:00:00.000Z',
      cooldownUntil: '2026-11-01T12:00:00.000Z',
      consecutiveFailures: 2,
      lastErrorCode: 'ACCESS_POLICY',
      hostPausedUntil: '2026-11-03T00:00:00.000Z',
      hostPauseReason: 'HTTP_403',
      costUnit: 'REQUEST',
      resumeCheckpoint: true,
      healthState: 'FAILING',
    })
    expect(jobSourceListSchema.parse({ items: [item] }).items[0]).toEqual(item)
  })

  it('a non-string fact cell maps to null, never through (MUT-1)', async () => {
    const h = harness(
      [ROW],
      [
        {
          id: ID,
          paused_until_ms: '1',
          pause_reason: 403,
          cost_unit: 7,
          resume_checkpoint: 'true',
        },
      ],
    )
    const [item] = await h.service.listSources(ADMIN)
    expect(item).toMatchObject({
      hostPausedUntil: null,
      hostPauseReason: null,
      costUnit: null,
      resumeCheckpoint: false,
    })
  })

  it('no sources: an empty list, and no fact or health query', async () => {
    const h = harness([], [])
    expect(await h.service.listSources(ADMIN)).toEqual([])
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.selectDistinctOn).not.toHaveBeenCalled()
  })

  it('NULL columns and a source without facts map to null / false', async () => {
    const h = harness(
      [
        {
          ...ROW,
          id: OTHER,
          readinessReason: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastNonemptyAt: null,
          nextAttemptAt: null,
          cooldownUntil: null,
          lastErrorCode: null,
        },
        ROW,
      ],
      [
        {
          id: ID,
          paused_until_ms: null,
          pause_reason: null,
          cost_unit: null,
          resume_checkpoint: null,
        },
      ],
    )
    const items = await h.service.listSources(ADMIN)
    for (const item of items) {
      expect(item).toMatchObject({
        hostPausedUntil: null,
        hostPauseReason: null,
        costUnit: null,
        resumeCheckpoint: false,
        healthState: null,
      })
    }
    expect(items[0]).toMatchObject({
      readinessReason: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastNonemptyAt: null,
      nextAttemptAt: null,
      cooldownUntil: null,
      lastErrorCode: null,
    })
    expect(jobSourceListSchema.safeParse({ items }).success).toBe(true)
  })

  it('reads the host pause only while it is in force, the meter unit and the resume rule', async () => {
    const h = harness([ROW], [])
    await h.service.listSources(ADMIN)
    const { sql } = dialect.sqlToQuery(h.execute.mock.calls[0]?.[0] as SQL)
    expect(sql).toContain('CASE WHEN h.paused_until > clock_timestamp()')
    expect(sql).toContain('LEFT JOIN job_source_hosts h ON h.host_key = s.host_key')
    expect(sql).toContain('LEFT JOIN job_account_meters m ON m.id = s.account_meter_id')
    // The ledger's own `inheritedCheckpoint` (CR-L-1), bound to the listed row, compared with `{}`.
    expect(sql).toContain('CASE WHEN l.config_version = s.config_version')
    expect(sql).toContain('WHERE l.source_id = s.id AND true')
    expect(sql).toContain("'{}'::jsonb) <> '{}'::jsonb")
    expect(sql).toContain('AS resume_checkpoint')
  })

  it('a non-ADMIN is refused before any query', async () => {
    const h = harness([ROW], [])
    await expect(h.service.listSources({ ...ADMIN, role: 'HR' })).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(h.execute).not.toHaveBeenCalled()
  })
})
