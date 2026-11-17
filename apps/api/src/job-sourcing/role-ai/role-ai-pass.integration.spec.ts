import { createHash, randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import { cleanupStore } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { SourceObservation } from '../normalize/observation'
import { DETAIL_FETCH, enqueueDirty } from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import { RecomputeWorker, createRecomputeSteps } from '../runtime/recompute-worker'
import { saveObservationPage } from '../store/source-record.store'
import { ROLE_AI_BACKOFF, type RoleAiPassResult, runRoleAiPass } from './role-ai-pass'
import type { RoleAiReply, RoleClassifierInput } from './role-classifier.client'

/**
 * Senior roles PR 3, Task 3.3 — the bounded AI role pass against a real Postgres, run as `crm_app`
 * (the grants are the shipped files). The client is a fake. Every row of a test is dated in 2999,
 * so the pass's `last_observed_at DESC` order reaches them first, and the limit is the test's own
 * eligible count; a row of another suite reaching the fake fails the test. Each test closes its
 * rows afterwards, so a later test never sees them.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `roles3-${TAG}`
const NAMESPACE = `${PREFIX}-ns`
const TYPE = 'REMOTIVE_API' as const
const NOW = new Date('2026-11-17T10:00:00.000Z')
const MIN = 60_000

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let team: string
let seq = 0
const mine: string[] = []

type Row = {
  id: string
  title: string
  titleKey: string
  sha: string | null
  description: string
  revision: number
}

/** A PENDING full-text (or no-description) opportunity, inserted directly. */
async function opportunity(
  opts: { description?: string | null; availability?: string; manual?: boolean } = {},
): Promise<Row> {
  seq += 1
  const title = `Wizard ${PREFIX} ${seq}`
  const description =
    opts.description === undefined ? `DESCRIPTION ${PREFIX} ${seq}` : opts.description
  const sha = description === null ? null : createHash('sha256').update(description).digest('hex')
  if (sha !== null) {
    await session.admin.query(
      `INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [sha, description],
    )
  }
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities
       (title, title_key, stack_keywords, description_sha256, role_status,
        role_classifier_version, availability, manual_team_id, last_observed_at)
     VALUES ($1, $2, ARRAY['backend'], $3, 'PENDING', 'rc.1', $4::job_availability, $5,
             '2999-01-01T00:00:00Z'::timestamptz + $6 * interval '1 second')
     RETURNING id, revision`,
    [title, title.toLowerCase(), sha, opts.availability ?? 'OPEN', opts.manual ? team : null, seq],
  )
  const id = rows[0].id as string
  mine.push(id)
  return {
    id,
    title,
    titleKey: title.toLowerCase(),
    sha,
    description: description ?? '',
    revision: Number(rows[0].revision),
  }
}

/** A no-description ON_DEMAND-type record, through the store, to a PENDING opportunity. */
async function onDemandOpportunity(): Promise<{ recordId: string; version: number; row: Row }> {
  seq += 1
  const nativeId = `od-${seq}`
  const title = `Wizard ${PREFIX} od ${seq}`
  const observation: SourceObservation = {
    identity: {
      provider: TYPE,
      namespace: NAMESPACE,
      nativeId,
      identityKey: JSON.stringify([nativeId]),
      identityKind: 'NATIVE_ID',
    },
    sourcePostingUrl: `https://fixture.test/jobs/${nativeId}`,
    applicationUrl: null,
    originalFields: {} as SourceObservation['originalFields'],
    normalized: {
      title,
      companyName: `Acme ${TAG}`,
      companyNameNormalized: `acme ${TAG}`,
      location: 'Remote',
      descriptionMd: '',
      publishedAt: null,
      dates: [],
      tags: [],
    },
    evidence: [],
    adapterVersion: 'remotive_api-1',
    normalizerVersion: 'n1',
    contentHash: createHash('sha256').update(`${PREFIX}-${nativeId}`).digest('hex'),
  }
  const [saved] = await saveObservationPage(db, run, {
    observations: [observation],
    checkpoint: specCheckpoint(seq),
  })
  const recordId = saved?.recordId as string
  const worker = new RecomputeWorker(createRecomputeSteps(db), {
    owner: `${PREFIX}-w`,
    batchSize: 50,
  })
  for (let i = 0; i < 10 && (await worker.runOnce()).claimed > 0; i += 1) {
    /* drain the shared queue until this record is an opportunity */
  }
  const { rows } = await session.admin.query(
    `SELECT o.id, o.title, o.title_key, o.revision, o.role_status, h.observation_seq
       FROM job_opportunity_sources s
       JOIN job_opportunities o ON o.id = s.opportunity_id
       JOIN job_source_record_heads h ON h.source_record_id = s.source_record_id
      WHERE s.source_record_id = $1 AND s.unlinked_at IS NULL`,
    [recordId],
  )
  const o = rows[0]
  expect(o?.role_status).toBe('PENDING')
  await session.admin.query(
    `UPDATE job_opportunities
        SET last_observed_at = '2999-06-01T00:00:00Z'::timestamptz + $2 * interval '1 second'
      WHERE id = $1`,
    [o.id, seq],
  )
  mine.push(o.id as string)
  return {
    recordId,
    version: Number(o.observation_seq),
    row: {
      id: o.id as string,
      title: o.title as string,
      titleKey: o.title_key as string,
      sha: null,
      description: '',
      revision: Number(o.revision),
    },
  }
}

type Answer = (input: RoleClassifierInput) => RoleAiReply | Error

function fakeClient(answer: Answer) {
  const calls: RoleClassifierInput[] = []
  return {
    calls,
    client: {
      async classify(input: RoleClassifierInput): Promise<RoleAiReply> {
        calls.push(input)
        if (!input.title.includes(PREFIX)) throw new Error('a row of another suite was selected')
        const r = answer(input)
        if (r instanceof Error) throw r
        return r
      },
    },
  }
}

function fakeLog() {
  const lines: unknown[] = []
  return {
    lines,
    log: {
      log: (l: object) => lines.push(['log', l]),
      warn: (l: object) => lines.push(['warn', l]),
      error: (l: object, stack?: string) => lines.push(['error', l, stack]),
    },
  }
}

function pass(
  client: ReturnType<typeof fakeClient>['client'],
  limit: number,
  opts: {
    now?: Date
    onDemandTypes?: readonly (typeof TYPE)[]
    log?: ReturnType<typeof fakeLog>
  } = {},
): Promise<RoleAiPassResult> {
  return runRoleAiPass({
    db,
    client,
    log: (opts.log ?? fakeLog()).log,
    now: () => opts.now ?? NOW,
    onDemandTypes: opts.onDemandTypes ?? [],
    limit,
  })
}

async function rolesOf(id: string) {
  const { rows } = await session.admin.query(
    `SELECT technical_roles, role_status, revision FROM job_opportunities WHERE id = $1`,
    [id],
  )
  return rows[0] as { technical_roles: string[]; role_status: string; revision: number }
}

async function cacheOf(r: Row) {
  const { rows } = await session.admin.query(
    `SELECT outcome, technical_roles, confidence, model, attempts, next_attempt_at
       FROM job_role_classifications
      WHERE title_key = $1 AND description_sha256 = $2 AND classifier_version = 'rc.1'`,
    [r.titleKey, r.sha ?? ''],
  )
  return rows[0] as
    | {
        outcome: string
        technical_roles: string[]
        confidence: string | null
        model: string | null
        attempts: number
        next_attempt_at: Date | null
      }
    | undefined
}

async function roleAiDirty(id: string) {
  const { rows } = await session.admin.query(
    `SELECT target_version::int AS target_version, status FROM job_dirty_work
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason = 'ROLE_AI:rc.1'`,
    [id],
  )
  return rows as { target_version: number; status: string }[]
}

const ok = (roles: RoleAiReply extends never ? never : string[], confidence: number) =>
  ({ kind: 'ok', roles, confidence }) as RoleAiReply

describe.skipIf(!hasDatabaseUrl())('role AI pass against Postgres (roles PR 3, Task 3.3)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry([TYPE]), catalog)
    const { rows: admins } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'Roles3 spec admin', 'ADMIN') RETURNING id`,
      [`roles3-admin-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
    run = handleOf(await kit.claimOne(await kit.reporting({ type: TYPE })))
    const { rows: teams } = await session.admin.query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
      [`roles3-team-${TAG}`],
    )
    team = teams[0].id as string
  })

  afterEach(async () => {
    // A closed row is never a candidate again.
    await session.admin.query(
      `UPDATE job_opportunities SET availability = 'CLOSED' WHERE id = ANY($1::uuid[])`,
      [mine],
    )
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_role_classifications WHERE title_key LIKE $1`, [
        `wizard ${PREFIX}%`,
      ])
      await session.admin.query(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [
        mine,
      ])
      // The directly inserted rows first: cleanupStore deletes every blob holding the tag.
      await session.admin.query(
        `DELETE FROM job_opportunities o WHERE o.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s WHERE s.opportunity_id = o.id)`,
        [mine],
      )
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM teams WHERE id = $1`, [team])
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it('ok + confidence 0.7 -> AI roles, cache row, OPPORTUNITY dirty with reason ROLE_AI:rc.1', async () => {
    const r = await opportunity()
    // The ingest's own work at this revision is done: the ROLE_AI row is a distinct key.
    await enqueueDirty(db, 'OPPORTUNITY', r.id, r.revision, 'INGEST_SPEC')
    const c = fakeClient(() => ok(['FRONTEND_ENGINEER', 'BACKEND_ENGINEER'], 0.7))
    await expect(pass(c.client, 1)).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
    expect(c.calls).toEqual([
      { title: r.title, description: r.description, categories: ['backend'] },
    ])
    await expect(rolesOf(r.id)).resolves.toEqual({
      technical_roles: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER'],
      role_status: 'AI',
      revision: r.revision,
    })
    await expect(cacheOf(r)).resolves.toEqual({
      outcome: 'AI',
      technical_roles: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER'],
      confidence: '0.700',
      model: null,
      attempts: 0,
      next_attempt_at: null,
    })
    await expect(roleAiDirty(r.id)).resolves.toEqual([
      { target_version: r.revision, status: 'PENDING' },
    ])
  })

  it('ok + confidence 0.69 -> UNCLEAR', async () => {
    const r = await opportunity()
    await pass(fakeClient(() => ok(['BACKEND_ENGINEER'], 0.69)).client, 1)
    await expect(rolesOf(r.id)).resolves.toMatchObject({
      technical_roles: [],
      role_status: 'UNCLEAR',
    })
    await expect(cacheOf(r)).resolves.toMatchObject({ outcome: 'UNCLEAR', technical_roles: [] })
    await expect(roleAiDirty(r.id)).resolves.toHaveLength(1)
  })

  it('ok + empty roles -> UNCLEAR', async () => {
    const r = await opportunity()
    await expect(pass(fakeClient(() => ok([], 0.95)).client, 1)).resolves.toMatchObject({
      unclear: 1,
    })
    await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'UNCLEAR' })
  })

  it('a vacancy without a description on an IN_LIST board is full text: UNCLEAR is written, keyed by ""', async () => {
    const r = await opportunity({ description: null })
    const c = fakeClient(() => ok([], 0.95))
    await pass(c.client, 1, { onDemandTypes: [TYPE] })
    expect(c.calls[0]?.description).toBe('')
    await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'UNCLEAR' })
    await expect(cacheOf(r)).resolves.toMatchObject({ outcome: 'UNCLEAR' })
  })

  it('NOT_CONFIGURED -> no writes, stoppedBy NOT_CONFIGURED, row stays PENDING', async () => {
    const r = await opportunity()
    const c = fakeClient(() => ({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
      transport: 'unset',
    }))
    await expect(pass(c.client, 1)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: 'NOT_CONFIGURED',
    })
    await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    await expect(cacheOf(r)).resolves.toBeUndefined()
    await expect(roleAiDirty(r.id)).resolves.toEqual([])
  })

  it('PROVIDER_ERROR on item 1 -> FAILED with backoff, items 2..n untouched, warn log has provider and reason', async () => {
    const rows = [await opportunity(), await opportunity(), await opportunity()]
    const c = fakeClient(() => ({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
      status: 502,
      transport: 'http',
    }))
    const log = fakeLog()
    await expect(pass(c.client, 3, { log })).resolves.toMatchObject({
      failed: 1,
      stoppedBy: 'PROVIDER_ERROR',
    })
    expect(c.calls).toHaveLength(1)
    // Newest first: the last inserted row is item 1.
    const [first, ...rest] = [...rows].reverse() as [Row, ...Row[]]
    await expect(cacheOf(first)).resolves.toMatchObject({
      outcome: 'FAILED',
      attempts: 1,
      next_attempt_at: new Date(NOW.getTime() + 15 * MIN),
    })
    await expect(rolesOf(first.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    for (const r of rest) {
      await expect(cacheOf(r)).resolves.toBeUndefined()
      await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    }
    expect(log.lines).toContainEqual([
      'warn',
      {
        event: 'ROLE_AI_FAILED',
        opportunityId: first.id,
        provider: 'extraction-worker:/classify-roles',
        reason: 'PROVIDER_ERROR:http',
        status: 502,
      },
    ])
  })

  it('INVALID_OUTPUT -> FAILED with backoff, the pass continues', async () => {
    const older = await opportunity()
    const newer = await opportunity()
    const c = fakeClient((input) =>
      input.title === newer.title
        ? { kind: 'unavailable', reason: 'INVALID_OUTPUT', transport: 'reply' }
        : ok(['QA_ENGINEER'], 0.9),
    )
    await expect(pass(c.client, 2)).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 1,
      stoppedBy: null,
    })
    await expect(cacheOf(newer)).resolves.toMatchObject({ outcome: 'FAILED', attempts: 1 })
    await expect(rolesOf(older.id)).resolves.toMatchObject({ role_status: 'AI' })
  })

  it('a FAILED row is not retried before next_attempt_at', async () => {
    const r = await opportunity()
    const failing = fakeClient(() => ({ kind: 'unavailable', reason: 'INVALID_OUTPUT' }))
    await pass(failing.client, 1)
    // Inside the backoff: not a candidate, no call.
    await pass(failing.client, 1, { now: new Date(NOW.getTime() + 14 * MIN) })
    expect(failing.calls).toHaveLength(1)
    // After it: retried, and the next wait doubles.
    const later = new Date(NOW.getTime() + 16 * MIN)
    await pass(failing.client, 1, { now: later })
    expect(failing.calls).toHaveLength(2)
    await expect(cacheOf(r)).resolves.toMatchObject({
      outcome: 'FAILED',
      attempts: 2,
      next_attempt_at: new Date(later.getTime() + ROLE_AI_BACKOFF(1)),
    })
    // A later answer replaces the FAILED row with a terminal one.
    const answering = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await pass(answering.client, 1, { now: new Date(later.getTime() + 31 * MIN) })
    await expect(cacheOf(r)).resolves.toMatchObject({ outcome: 'AI', next_attempt_at: null })
  })

  it('a detail-pending on-demand record is never a candidate and never takes a title-only cache row', async () => {
    const { row } = await onDemandOpportunity()
    // A terminal answer for its title-only key exists: it must still not be applied.
    await session.admin.query(
      `INSERT INTO job_role_classifications
         (title_key, description_sha256, classifier_version, outcome, technical_roles)
       VALUES ($1, '', 'rc.1', 'AI', ARRAY['QA_ENGINEER'])`,
      [row.titleKey],
    )
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await expect(pass(c.client, 1, { onDemandTypes: [TYPE] })).resolves.toMatchObject({
      classified: 0,
    })
    expect(c.calls).toHaveLength(0)
    await expect(rolesOf(row.id)).resolves.toMatchObject({ role_status: 'PENDING' })
  })

  it('detail-pending records do not consume ROLE_AI_PASS_LIMIT', async () => {
    const full = await opportunity()
    // Dated after `full`, so it would take the one slot if it were selected.
    const { row } = await onDemandOpportunity()
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await expect(pass(c.client, 1, { onDemandTypes: [TYPE] })).resolves.toMatchObject({
      classified: 1,
    })
    expect(c.calls.map((x) => x.title)).toEqual([full.title])
    await expect(rolesOf(row.id)).resolves.toMatchObject({ role_status: 'PENDING' })
  })

  it('an on-demand record whose detail settled without a description is not full text: never sent', async () => {
    const { recordId, version, row } = await onDemandOpportunity()
    await enqueueDirty(db, 'SOURCE_RECORD', recordId, version, DETAIL_FETCH)
    await session.admin.query(
      `UPDATE job_dirty_work SET status = 'DONE', completed_at = clock_timestamp()
        WHERE entity_kind = 'SOURCE_RECORD' AND entity_id = $1 AND reason = $2`,
      [recordId, DETAIL_FETCH],
    )
    const c = fakeClient(() => ok([], 0.9))
    await pass(c.client, 1, { onDemandTypes: [TYPE] })
    expect(c.calls).toHaveLength(0)
    // With no ON_DEMAND type configured the same board is IN_LIST: its record is its full text.
    await pass(c.client, 1, { onDemandTypes: [] })
    expect(c.calls.map((x) => x.title)).toEqual([row.title])
    await expect(rolesOf(row.id)).resolves.toMatchObject({ role_status: 'UNCLEAR' })
  })

  it('closed vacancies and manual cards are never candidates', async () => {
    await opportunity({ availability: 'CLOSED' })
    await opportunity({ manual: true })
    const open = await opportunity({ availability: 'UNKNOWN' })
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await pass(c.client, 1)
    expect(c.calls.map((x) => x.title)).toEqual([open.title])
  })

  it('a row reclassified between selection and lock is skipped (stale)', async () => {
    const r = await opportunity()
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    const racing = {
      async classify(input: RoleClassifierInput): Promise<RoleAiReply> {
        // A refresh re-derived it by rule while the model was answering.
        await session.admin.query(
          `UPDATE job_opportunities SET technical_roles = ARRAY['BACKEND_ENGINEER'], role_status = 'RULE'
            WHERE id = $1`,
          [r.id],
        )
        return c.client.classify(input)
      },
    }
    await expect(pass(racing, 1)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
    await expect(rolesOf(r.id)).resolves.toMatchObject({
      role_status: 'RULE',
      technical_roles: ['BACKEND_ENGINEER'],
    })
    await expect(cacheOf(r)).resolves.toBeUndefined()
    await expect(roleAiDirty(r.id)).resolves.toEqual([])
  })

  it('a terminal cache row is applied without a model call', async () => {
    const r = await opportunity()
    await session.admin.query(
      `INSERT INTO job_role_classifications
         (title_key, description_sha256, classifier_version, outcome, technical_roles, confidence)
       VALUES ($1, $2, 'rc.1', 'AI', ARRAY['QA_ENGINEER', 'BACKEND_ENGINEER'], 0.9)`,
      [r.titleKey, r.sha],
    )
    const c = fakeClient(() => ok([], 0.1))
    await expect(pass(c.client, 1)).resolves.toMatchObject({ classified: 1 })
    expect(c.calls).toHaveLength(0)
    await expect(rolesOf(r.id)).resolves.toMatchObject({
      role_status: 'AI',
      technical_roles: ['BACKEND_ENGINEER', 'QA_ENGINEER'],
    })
    await expect(roleAiDirty(r.id)).resolves.toHaveLength(1)
  })

  it('the pass never throws: a client rejection is logged and counted as failed', async () => {
    const r = await opportunity()
    const log = fakeLog()
    const c = fakeClient(() => new Error(`boom ${r.title}`))
    await expect(pass(c.client, 1, { log })).resolves.toMatchObject({
      failed: 1,
      stoppedBy: 'ERROR',
    })
    expect(JSON.stringify(log.lines)).not.toContain(PREFIX)
    await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'PENDING' })
  })

  it('logs never contain the title or description', async () => {
    const rows = [await opportunity(), await opportunity(), await opportunity()]
    let n = 0
    const c = fakeClient(() => {
      n += 1
      if (n === 1) return ok(['QA_ENGINEER'], 0.9)
      if (n === 2) return { kind: 'unavailable', reason: 'INVALID_OUTPUT' }
      return { kind: 'unavailable', reason: 'TIMEOUT', transport: 'timeout' }
    })
    const log = fakeLog()
    await pass(c.client, rows.length, { log })
    expect(c.calls).toHaveLength(3)
    const text = JSON.stringify(log.lines)
    expect(text).toContain('ROLE_AI_PASS')
    expect(text).not.toContain(PREFIX)
    expect(text).not.toContain('DESCRIPTION')
  })
})
