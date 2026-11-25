import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../../database/schema'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { purgeOpportunity, purgeRetiredOpportunities } from './opportunity-purge'

/**
 * Vacancy retention (owner 2026-11-25) against a real Postgres, as `crm_app`: the 60-day sweep and
 * the CLOSED/EXPIRED removal, the tombstone for an opportunity the append-only action log names, and
 * the retired record that frees its natural key so a re-listing is collected as new.
 *
 * The sweep is global, so every assertion reads only this spec's own rows. `job_queue_actions` is
 * append-only (no DELETE for anyone), so the tombstone fixtures that log names stay behind by design.
 */
const TAG = randomUUID().slice(0, 8)
const NAMESPACE = `vr60-${TAG}-ns`
const DAY = 24 * 60 * 60 * 1000

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>
let actor: string

const q = (text: string, params: unknown[] = []) => session.admin.query(text, params)
const tag = () => randomUUID().slice(0, 12)
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

async function newRecord(availability = 'OPEN'): Promise<{ id: string; key: string }> {
  const key = `key-${tag()}`
  const { rows } = await q(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, availability)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3::job_availability) RETURNING id`,
    [NAMESPACE, key, availability],
  )
  return { id: String(rows[0].id), key }
}

async function newOpportunity(opts: {
  publishedAt: string | null
  firstSeenAt?: string
  availability?: string
}): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key, published_at, first_seen_at, availability)
     VALUES ($1, $1, $2::timestamptz, COALESCE($3::timestamptz, now()), $4::job_availability)
     RETURNING id`,
    [`vr60-${tag()}`, opts.publishedAt, opts.firstSeenAt ?? null, opts.availability ?? 'OPEN'],
  )
  return String(rows[0].id)
}

async function link(recordId: string, oppId: string): Promise<void> {
  await q(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version) VALUES ($1, $2, '1')`,
    [recordId, oppId],
  )
}

/** A sourced opportunity with one member record. */
async function sourced(opts: Parameters<typeof newOpportunity>[0]) {
  const oppId = await newOpportunity(opts)
  const record = await newRecord()
  await link(record.id, oppId)
  return { oppId, record }
}

async function exists(table: string, id: string): Promise<boolean> {
  const { rows } = await q(`SELECT 1 FROM ${table} WHERE id = $1`, [id])
  return rows.length > 0
}

async function logOpened(oppId: string, recordId: string): Promise<void> {
  await q(
    `INSERT INTO job_queue_actions (kind, opportunity_id, source_record_id, actor_id, scope_kind, idempotency_key)
     VALUES ('OPENED', $1, $2, $3, 'STUDIO', $4)`,
    [oppId, recordId, actor, `vr60-${tag()}`],
  )
}

describe.skipIf(!hasDatabaseUrl())('vacancy retention purge (owner 2026-11-25)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
    const { rows: u } = await q(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'vr60 actor', 'ADMIN') RETURNING id`,
      [`vr60-${TAG}@example.test`],
    )
    actor = String(u[0].id)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      // Rows the log does not name; tombstones and retired records the log names stay (append-only).
      await q(
        `DELETE FROM job_opportunity_sources WHERE source_record_id IN
           (SELECT id FROM job_source_records WHERE namespace = $1)`,
        [NAMESPACE],
      )
      await q(
        `DELETE FROM job_opportunities o WHERE o.title_key LIKE 'vr60-%'
            AND NOT EXISTS (SELECT 1 FROM job_queue_actions a WHERE a.opportunity_id = o.id)`,
      )
      await q(
        `DELETE FROM job_source_records r WHERE r.namespace = $1
            AND NOT EXISTS (SELECT 1 FROM job_queue_actions a WHERE a.source_record_id = r.id)`,
        [NAMESPACE],
      )
    } finally {
      await session.close()
    }
  })

  it('the sweep removes the 60-day-old (published, or first-seen when undated) and the CLOSED/EXPIRED; keeps the young and open', async () => {
    const oldPublished = await sourced({ publishedAt: ago(61) })
    const oldFirstSeen = await sourced({ publishedAt: null, firstSeenAt: ago(61) })
    const closed = await sourced({ publishedAt: ago(1), availability: 'CLOSED' })
    const expired = await sourced({ publishedAt: ago(1), availability: 'EXPIRED' })
    const young = await sourced({ publishedAt: ago(59) })
    // published_at wins over first_seen_at: a recent posting first seen long ago is still young.
    const youngPublished = await sourced({ publishedAt: ago(10), firstSeenAt: ago(100) })

    const res = await purgeRetiredOpportunities(db)

    expect(res.deleted).toBeGreaterThanOrEqual(4)
    for (const gone of [oldPublished, oldFirstSeen, closed, expired]) {
      expect(await exists('job_opportunities', gone.oppId)).toBe(false)
      expect(await exists('job_source_records', gone.record.id)).toBe(false)
    }
    for (const kept of [young, youngPublished]) {
      expect(await exists('job_opportunities', kept.oppId)).toBe(true)
      expect(await exists('job_source_records', kept.record.id)).toBe(true)
    }
  })

  it('an opportunity the action log names is tombstoned: row and log kept, text and links gone, invisible to the queue join', async () => {
    const oppId = await newOpportunity({ publishedAt: ago(61) })
    const named = await newRecord()
    const unnamed = await newRecord()
    await link(named.id, oppId)
    await link(unnamed.id, oppId)
    await logOpened(oppId, named.id)
    const { rows: logBefore } = await q(
      `SELECT id, kind, opportunity_id, source_record_id FROM job_queue_actions WHERE opportunity_id = $1`,
      [oppId],
    )

    const outcome = await db.transaction((tx) => purgeOpportunity(tx, oppId), {
      isolationLevel: 'read committed',
    })

    expect(outcome).toBe('TOMBSTONED')
    const { rows: opp } = await q(
      `SELECT title, availability::text AS availability, revision FROM job_opportunities WHERE id = $1`,
      [oppId],
    )
    expect(opp[0]).toMatchObject({ title: '', availability: 'EXPIRED' })
    // No link left: the queue reaches a sourced row only through an ACTIVE linked record.
    const { rows: links } = await q(
      `SELECT 1 FROM job_opportunity_sources WHERE opportunity_id = $1`,
      [oppId],
    )
    expect(links).toEqual([])
    // The named record is retired (natural key moved out of the way); the unnamed one is deleted.
    const { rows: rec } = await q(
      `SELECT namespace, source_id FROM job_source_records WHERE id = $1`,
      [named.id],
    )
    expect(rec[0]).toEqual({ namespace: `retired:${named.id}`, source_id: null })
    expect(await exists('job_source_records', unnamed.id)).toBe(false)
    // The append-only log is untouched.
    const { rows: logAfter } = await q(
      `SELECT id, kind, opportunity_id, source_record_id FROM job_queue_actions WHERE opportunity_id = $1`,
      [oppId],
    )
    expect(logAfter).toEqual(logBefore)

    // A tombstone has no link, so the next sweep does not pick it again.
    const revision = Number(opp[0].revision)
    await purgeRetiredOpportunities(db)
    const { rows: again } = await q(`SELECT revision FROM job_opportunities WHERE id = $1`, [oppId])
    expect(Number(again[0].revision)).toBe(revision)
  })

  it('a retired record frees its natural key: the same posting listed again inserts a fresh record', async () => {
    const oppId = await newOpportunity({ publishedAt: ago(61) })
    const named = await newRecord()
    await link(named.id, oppId)
    await logOpened(oppId, named.id)

    await db.transaction((tx) => purgeOpportunity(tx, oppId), { isolationLevel: 'read committed' })

    const { rows } = await q(
      `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, availability)
       VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, 'OPEN') RETURNING id`,
      [NAMESPACE, named.key],
    )
    expect(String(rows[0].id)).not.toBe(named.id)
  })

  it('an opportunity with an open member and a closed one survives a closed-record purge pass', async () => {
    const oppId = await newOpportunity({ publishedAt: ago(1) })
    const open = await newRecord('OPEN')
    const shut = await newRecord('CLOSED')
    await link(open.id, oppId)
    await link(shut.id, oppId)

    await purgeRetiredOpportunities(db)

    expect(await exists('job_opportunities', oppId)).toBe(true)
    expect(await exists('job_source_records', shut.id)).toBe(true)
  })
})
