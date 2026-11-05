import type { SessionUser } from '@crm/shared'
import { HttpException } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { JobSourcingService } from './job-sourcing.service'
import { JobSourceRegistry } from './registry/job-source-registry'

/**
 * r5 Phase 6 fix round (SR-M-1): `openOpportunity` authorizes through live LEAD / TRIAGE match
 * rows, and a manual card must never be reachable that way: only its owner team sees it, through
 * the queue. The real-DB proof is `job-queue-rbac.integration.spec.ts`; this pins the predicate
 * for the mutation gate, which runs unit specs only.
 */
const OPP = '7d9b0d1c-2e5f-4a8b-9c6d-1e2f3a4b5c6d'
const admin = { id: 'admin-1', role: 'ADMIN' } as SessionUser

function harness() {
  const seen: string[] = []
  const execute = vi.fn(async (query: SQL) => {
    seen.push(new PgDialect().sqlToQuery(query).sql.replace(/\s+/g, ' '))
    return { rows: [] }
  })
  const db = { db: { execute } }
  const svc = new JobSourcingService(db as never, {} as never, new JobSourceRegistry([]))
  return { svc, seen }
}

describe('openOpportunity: a manual card grants no match-based access (SR-M-1)', () => {
  it('the live-match roster read excludes manual cards, so the answer is the 404', async () => {
    const h = harness()
    const e: unknown = await h.svc.openOpportunity(OPP, admin).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(HttpException)
    expect((e as HttpException).getStatus()).toBe(404)
    expect((e as HttpException).getResponse()).toMatchObject({ code: 'JOB_OPPORTUNITY_NOT_FOUND' })
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]).toContain(
      'AND m.opportunity_revision = o.revision AND o.manual_team_id IS NULL AND u.role = ',
    )
  })
})
