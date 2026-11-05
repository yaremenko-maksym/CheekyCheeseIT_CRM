import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import { JobQueueRecomputeService } from './queue-recompute.service'

/** r5 Task 6.4 — the recompute run: unit seam = `enqueue` over a scripted transaction executor. */
const dialect = new PgDialect()
const ADMIN = { id: '0b7f6c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e', role: 'ADMIN' } as SessionUser
const NEW_RUN = '1c8a7d2f-3e4b-4c5d-9e0f-2a3b4c5d6e7f'
const LIVE_RUN = '2d9b8e3a-4f5c-4d6e-8f1a-3b4c5d6e7f8a'
const DONE_RUN = '3e0c9f4b-5a6d-4e7f-9a2b-4c5d6e7f8a9b'

/**
 * A DatabaseService whose transaction answers the open-runs read with `open`, the cycle INSERT with
 * `cycle`, and the dirty INSERT with `enqueued` rows; it records every statement in order.
 */
function scripted({
  open = [] as { id: string; in_flight: boolean }[],
  cycle = [{ id: NEW_RUN }] as Record<string, unknown>[],
  enqueued = 2,
} = {}) {
  const seen: { sql: string; params: unknown[] }[] = []
  const tx = {
    execute: (q: SQL) => {
      const r = dialect.sqlToQuery(q)
      seen.push(r)
      if (r.sql.includes('FROM job_collection_cycles')) return Promise.resolve({ rows: open })
      if (r.sql.includes('INSERT INTO job_collection_cycles'))
        return Promise.resolve({ rows: cycle })
      if (r.sql.includes('INSERT INTO job_dirty_work'))
        return Promise.resolve({
          rows: Array.from({ length: enqueued }, (_, i) => ({ id: `w${i}` })),
        })
      return Promise.resolve({ rows: [] })
    },
  }
  const transaction = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx))
  const service = new JobQueueRecomputeService({
    db: { transaction },
  } as unknown as DatabaseService)
  const kinds = () =>
    seen.map((s) =>
      s.sql.includes('pg_advisory_xact_lock')
        ? 'lock'
        : s.sql.includes('FROM job_collection_cycles')
          ? 'open-runs'
          : s.sql.includes('INSERT INTO job_collection_cycles')
            ? 'open-run'
            : s.sql.includes('INSERT INTO job_dirty_work')
              ? 'enqueue'
              : s.sql.includes('UPDATE job_collection_cycles')
                ? 'close'
                : 'other',
    )
  const closed = () =>
    seen
      .filter((s) => s.sql.includes('UPDATE job_collection_cycles'))
      .map((s) => JSON.parse(String(s.params[0])) as string[])
  return { service, transaction, seen, kinds, closed }
}

describe('JobQueueRecomputeService.enqueue', () => {
  it.each(['HR', 'SENIOR', 'JUNIOR', 'ACCOUNTANT'] as const)(
    'a %s is refused before any statement runs',
    async (role) => {
      const h = scripted()
      await expect(h.service.enqueue({ ...ADMIN, role } as SessionUser)).rejects.toThrow(
        ForbiddenException,
      )
      expect(h.transaction).not.toHaveBeenCalled()
    },
  )

  it('no open run: opens one for the ADMIN and enqueues the work under its id', async () => {
    const h = scripted()
    expect(await h.service.enqueue(ADMIN)).toEqual({ runId: NEW_RUN })
    expect(h.kinds()).toEqual(['lock', 'open-runs', 'open-run', 'enqueue'])
    const open = h.seen[2]!
    expect(open.sql).toContain("VALUES ('MANUAL', $1, $2::uuid)")
    expect(String(open.params[0])).toMatch(/^RECOMPUTE:[0-9a-f-]{36}$/)
    expect(open.params[1]).toBe(ADMIN.id)
    const enqueue = h.seen[3]!
    // The first two binds are the run's; the rest are the MATCH-partition predicate's own.
    expect(enqueue.params.slice(0, 2)).toEqual([`ADMIN_RECOMPUTE:${NEW_RUN}`, NEW_RUN])
    expect(enqueue.sql).toContain("WHERE o.availability IN ('OPEN', 'UNKNOWN')")
    expect(enqueue.sql).toContain("w.status IN ('PENDING', 'CLAIMED')")
    // The in-flight skip reads only MATCH-partition rows: the predicate is applied to w.reason.
    expect(enqueue.sql).toContain('AND NOT ((w.reason = $3) OR (starts_with(w.reason, $4)')
    expect(enqueue.sql).toContain(
      'ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING',
    )
  })

  it('the lock comes first: two ADMINs pressing at once serialize on one key', async () => {
    const h = scripted()
    await h.service.enqueue(ADMIN)
    expect(h.seen[0]!.params).toEqual(['job_queue:recompute'])
  })

  it('a run with work in flight: answers ITS id and enqueues nothing', async () => {
    const h = scripted({ open: [{ id: LIVE_RUN, in_flight: true }] })
    expect(await h.service.enqueue(ADMIN)).toEqual({ runId: LIVE_RUN })
    expect(h.kinds()).toEqual(['lock', 'open-runs'])
  })

  it('a finished open run is closed, then a new run opens', async () => {
    const h = scripted({ open: [{ id: DONE_RUN, in_flight: false }] })
    expect(await h.service.enqueue(ADMIN)).toEqual({ runId: NEW_RUN })
    expect(h.kinds()).toEqual(['lock', 'open-runs', 'close', 'open-run', 'enqueue'])
    expect(h.closed()).toEqual([[DONE_RUN]])
  })

  it('finished runs are closed even when a live one is answered', async () => {
    const h = scripted({
      open: [
        { id: DONE_RUN, in_flight: false },
        { id: LIVE_RUN, in_flight: true },
      ],
    })
    expect(await h.service.enqueue(ADMIN)).toEqual({ runId: LIVE_RUN })
    expect(h.kinds()).toEqual(['lock', 'open-runs', 'close'])
    expect(h.closed()).toEqual([[DONE_RUN]])
  })

  it('nothing to enqueue: the new run is closed at once and its id still answered', async () => {
    const h = scripted({ enqueued: 0 })
    expect(await h.service.enqueue(ADMIN)).toEqual({ runId: NEW_RUN })
    expect(h.kinds()).toEqual(['lock', 'open-runs', 'open-run', 'enqueue', 'close'])
    expect(h.closed()).toEqual([[NEW_RUN]])
  })

  it('the cycle INSERT returns no id: fails loud, nothing enqueued', async () => {
    const h = scripted({ cycle: [] })
    await expect(h.service.enqueue(ADMIN)).rejects.toThrow('recompute: no cycle row')
    expect(h.kinds()).toEqual(['lock', 'open-runs', 'open-run'])
  })

  it('the open-runs read only looks at OPEN MANUAL cycles keyed RECOMPUTE:', async () => {
    const h = scripted()
    await h.service.enqueue(ADMIN)
    const read = h.seen[1]!
    expect(read.sql).toContain("c.trigger = 'MANUAL' AND c.status = 'OPEN'")
    expect(read.params).toEqual(['RECOMPUTE:'])
  })
})
