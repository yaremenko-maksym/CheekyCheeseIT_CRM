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
  const healthWhere = vi.fn((_w: SQL) => ({ orderBy: async () => transitions }))
  const selectDistinctOn = vi.fn(() => ({ from: () => ({ where: healthWhere }) }))
  const db = { db: { select: () => ({ from: async () => rows }), execute, selectDistinctOn } }
  return {
    service: new JobSourcingService(db as never, {} as never, new JobSourceRegistry([])),
    execute,
    selectDistinctOn,
    healthParams: () => dialect.sqlToQuery(healthWhere.mock.calls[0]![0]).params,
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

  it('asks the health query for exactly the listed source ids', async () => {
    const h = harness([ROW, { ...ROW, id: OTHER }], [])
    await h.service.listSources(ADMIN)
    expect(h.healthParams()).toEqual([ID, OTHER, 'TRANSITION'])
  })

  it('an unknown stored health state maps to null and the list still parses (CR-M-1)', async () => {
    const h = harness(
      [ROW, { ...ROW, id: OTHER }],
      [],
      [
        { sourceId: ID, toState: 'MELTED', reasonCode: null },
        { sourceId: OTHER, toState: 'HEALTHY', reasonCode: null },
      ],
    )
    const items = await h.service.listSources(ADMIN)
    expect(items.map((i) => [i.id, i.healthState])).toEqual([
      [ID, null],
      [OTHER, 'HEALTHY'],
    ])
    expect(jobSourceListSchema.safeParse({ items }).success).toBe(true)
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

describe('listSources — task 7.5 meter projection', () => {
  const METER_FACT = {
    id: ID,
    cost_unit: 'REQUEST',
    meter_window: 'MONTH',
    meter_limit: 200,
    meter_used: 120,
    meter_reserved: 10,
    meter_uncertain: 5,
    meter_resets_at_ms: Date.parse('2026-12-01T00:00:00.000Z'),
  }

  it('projects the account meter and the answer parses', async () => {
    const h = harness([ROW], [METER_FACT])
    const [item] = await h.service.listSources(ADMIN)
    expect(item?.meter).toEqual({
      unit: 'REQUEST',
      window: 'MONTH',
      limit: 200,
      used: 120,
      reserved: 10,
      uncertain: 5,
      resetsAt: '2026-12-01T00:00:00.000Z',
    })
    expect(jobSourceListSchema.parse({ items: [item] }).items[0]).toEqual(item)
  })

  it('an unlimited LIFETIME meter keeps null limit and null resetsAt', async () => {
    const h = harness(
      [ROW],
      [{ ...METER_FACT, meter_window: 'LIFETIME', meter_limit: null, meter_resets_at_ms: null }],
    )
    const [item] = await h.service.listSources(ADMIN)
    expect(item?.meter).toMatchObject({ window: 'LIFETIME', limit: null, resetsAt: null })
  })

  it('a source without a meter has meter null', async () => {
    const h = harness([ROW], [{ id: ID, cost_unit: null }])
    expect((await h.service.listSources(ADMIN))[0]?.meter).toBeNull()
  })

  it('a source without any fact row has meter null', async () => {
    const h = harness([ROW], [])
    expect((await h.service.listSources(ADMIN))[0]?.meter).toBeNull()
  })

  it.each([
    ['unit', { cost_unit: 7 }],
    ['window', { meter_window: 3 }],
    ['used', { meter_used: '120' }],
    ['reserved', { meter_reserved: null }],
    ['uncertain', { meter_uncertain: undefined }],
  ])('a non-conforming %s cell drops the meter rather than leaking it', async (_n, patch) => {
    const h = harness([ROW], [{ ...METER_FACT, ...patch }])
    expect((await h.service.listSources(ADMIN))[0]?.meter).toBeNull()
  })

  it('a non-number limit or reset instant maps to null, not through', async () => {
    const h = harness([ROW], [{ ...METER_FACT, meter_limit: '200', meter_resets_at_ms: '1' }])
    expect((await h.service.listSources(ADMIN))[0]?.meter).toMatchObject({
      limit: null,
      resetsAt: null,
    })
  })

  it('reads the meter off the joined row; used and the reset instant are zeroed once the window has elapsed', async () => {
    const h = harness([ROW], [])
    await h.service.listSources(ADMIN)
    const { sql } = dialect.sqlToQuery(h.execute.mock.calls[0]?.[0] as SQL)
    expect(sql).toContain('m.window_kind::text AS meter_window')
    expect(sql).toContain('m.limit_amount::float8 AS meter_limit')
    expect(sql).toContain('m.reserved::float8 AS meter_reserved')
    expect(sql).toContain('m.uncertain::float8 AS meter_uncertain')
    expect(sql).toContain(
      'CASE WHEN m.resets_at IS NOT NULL AND m.resets_at <= clock_timestamp() THEN 0 ELSE m.used::float8 END AS meter_used',
    )
    expect(sql).toContain(
      'CASE WHEN m.resets_at > clock_timestamp() THEN (extract(epoch FROM m.resets_at) * 1000)::float8 END AS meter_resets_at_ms',
    )
  })
})

describe('listSources — task 7.5 policy / authorization deadlines (AC4)', () => {
  it('a Recruitee board with a catalog deadline carries authUntil; policyUntil is null', async () => {
    const h = harness([{ ...ROW, type: 'RECRUITEE_ATS', manifestId: 'recruitee.board.bunq' }], [])
    const [item] = await h.service.listSources(ADMIN)
    expect(item).toMatchObject({ authUntil: '2027-02-10T00:00:00.000Z', policyUntil: null })
    expect(jobSourceListSchema.parse({ items: [item] }).items[0]).toEqual(item)
  })

  it('a source with no deadline reads null / null, and a row without manifestId resolves by type', async () => {
    const h = harness([ROW, { ...ROW, id: OTHER, type: 'RECRUITEE_ATS', manifestId: null }], [])
    const [none, byType] = await h.service.listSources(ADMIN)
    expect(none).toMatchObject({ authUntil: null, policyUntil: null })
    expect(byType).toMatchObject({ authUntil: '2027-02-10T00:00:00.000Z', policyUntil: null })
  })
})
