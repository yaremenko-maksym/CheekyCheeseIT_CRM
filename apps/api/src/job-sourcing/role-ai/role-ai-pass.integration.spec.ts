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
import {
  ROLE_AI_BACKOFF,
  ROLE_AI_MAX_ATTEMPTS,
  type RoleAiPassResult,
  runRoleAiPass,
} from './role-ai-pass'
import { createRoleAiStore } from './role-ai.store'
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
/** This suite's own call meter row: a fixed clock would otherwise spend one shared row across runs. */
const METER_KEY = `role-ai-spec:${TAG}`

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let team: string
let senior: string
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
  opts: {
    description?: string | null
    availability?: string
    manual?: boolean
    /** Evaluated at its revision, as the recompute worker leaves every row it installs. */
    evaluated?: boolean
  } = {},
): Promise<Row> {
  seq += 1
  // `tech lead`: rule-unclassified, and the role-scope gate keeps it PENDING for the seeded
  // SOFTWARE_ARCHITECT senior. A shared-queue drain (onDemandOpportunity) may recompute this row
  // through another suite's roster / exclusion fan-out; a no-signal title would then go OUT_OF_SCOPE.
  const title = `Wizard ${PREFIX} tech lead ${seq}`
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
     VALUES ($1, $2, ARRAY['backend'], $3, 'PENDING', 'rc.2', $4::job_availability, $5,
             '2999-01-01T00:00:00Z'::timestamptz + $6 * interval '1 second')
     RETURNING id, revision`,
    [title, title.toLowerCase(), sha, opts.availability ?? 'OPEN', opts.manual ? team : null, seq],
  )
  const id = rows[0].id as string
  mine.push(id)
  if (opts.evaluated !== false) {
    await session.admin.query(
      `UPDATE job_opportunities
          SET evaluated_revision = revision, evaluation_verdict = 'EXCLUDED',
              evaluated_inputs_version = 'role-ai-spec'
        WHERE id = $1`,
      [id],
    )
  }
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
  // `tech lead` passes the role-scope gate for the seeded SOFTWARE_ARCHITECT senior; the rule leaves it
  // unclassified
  const title = `Wizard ${PREFIX} tech lead od ${seq}`
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
  // the rule left the title unclassified and the real recompute's role-scope gate kept it PENDING:
  // the seeded SOFTWARE_ARCHITECT senior makes `tech lead` reachable whatever the shared roster holds
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
    dailyBudget?: number
  } = {},
): Promise<RoleAiPassResult> {
  return runRoleAiPass({
    db,
    client,
    log: (opts.log ?? fakeLog()).log,
    now: () => opts.now ?? NOW,
    onDemandTypes: opts.onDemandTypes ?? [],
    limit,
    dailyBudget: opts.dailyBudget ?? 10_000,
    meterAccountKey: METER_KEY,
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
      WHERE title_key = $1 AND description_sha256 = $2 AND classifier_version = 'rc.2'`,
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
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason = 'ROLE_AI:rc.2'`,
    [id],
  )
  return rows as { target_version: number; status: string }[]
}

/** The row was never sent, stays PENDING, and has no cache or ROLE_AI dirty row. */
async function expectUntouched(r: Row) {
  await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'PENDING' })
  await expect(cacheOf(r)).resolves.toBeUndefined()
  await expect(roleAiDirty(r.id)).resolves.toEqual([])
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
    const { rows: seniors } = await session.admin.query(
      `INSERT INTO users (email, display_name, role, technical_roles)
       VALUES ($1, 'Roles3 spec senior', 'SENIOR', ARRAY['SOFTWARE_ARCHITECT']) RETURNING id`,
      [`roles3-senior-${TAG}@example.test`],
    )
    senior = seniors[0].id as string
    await session.admin.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [
      team,
      senior,
    ])
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
      await session.admin.query(`DELETE FROM job_account_meters WHERE account_key = $1`, [
        METER_KEY,
      ])
      // The directly inserted rows first: cleanupStore deletes every blob holding the tag.
      await session.admin.query(
        `DELETE FROM job_opportunities o WHERE o.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s WHERE s.opportunity_id = o.id)`,
        [mine],
      )
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM team_members WHERE user_id = $1`, [senior])
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [senior])
      await session.admin.query(`DELETE FROM teams WHERE id = $1`, [team])
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it('ok + confidence 0.7 -> AI roles, cache row, OPPORTUNITY dirty with reason ROLE_AI:rc.2', async () => {
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
    // An own eligible row, older: inside the backoff the one slot goes to it, never to another suite.
    const sentinel = await opportunity()
    const r = await opportunity()
    const failing = fakeClient((input) =>
      input.title === r.title
        ? { kind: 'unavailable', reason: 'INVALID_OUTPUT' }
        : ok(['QA_ENGINEER'], 0.9),
    )
    const callsOf = (title: string) => failing.calls.filter((x) => x.title === title).length
    await pass(failing.client, 1)
    // Inside the backoff: not a candidate, no call.
    await pass(failing.client, 1, { now: new Date(NOW.getTime() + 14 * MIN) })
    expect(callsOf(r.title)).toBe(1)
    expect(callsOf(sentinel.title)).toBe(1)
    // After it: retried, and the next wait doubles.
    const later = new Date(NOW.getTime() + 16 * MIN)
    await pass(failing.client, 1, { now: later })
    expect(callsOf(r.title)).toBe(2)
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
    // An own eligible row, older than the excluded one: the one slot never reaches another suite's row.
    const sentinel = await opportunity()
    const { row } = await onDemandOpportunity()
    // A terminal answer for its title-only key exists: it must still not be applied.
    await session.admin.query(
      `INSERT INTO job_role_classifications
         (title_key, description_sha256, classifier_version, outcome, technical_roles)
       VALUES ($1, '', 'rc.2', 'AI', ARRAY['QA_ENGINEER'])`,
      [row.titleKey],
    )
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await pass(c.client, 1, { onDemandTypes: [TYPE] })
    expect(c.calls.map((x) => x.title)).toEqual([sentinel.title])
    await expect(rolesOf(row.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    await expect(roleAiDirty(row.id)).resolves.toEqual([])
  })

  it('a fixture row recomputed by a shared-queue drain stays PENDING and keeps its AI slot', async () => {
    // CI round 5: another suite's roster / exclusion fan-out can enqueue a recompute of every open
    // row, and onDemandOpportunity drains the shared queue. The re-gated fixture must stay a candidate.
    const sentinel = await opportunity()
    await enqueueDirty(db, 'OPPORTUNITY', sentinel.id, sentinel.revision, 'ROLE_AI_SPEC_FANOUT')
    await onDemandOpportunity()
    await expect(rolesOf(sentinel.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await pass(c.client, 1, { onDemandTypes: [TYPE] })
    expect(c.calls.map((x) => x.title)).toEqual([sentinel.title])
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
    const sentinel = await opportunity()
    const { recordId, version, row } = await onDemandOpportunity()
    await enqueueDirty(db, 'SOURCE_RECORD', recordId, version, DETAIL_FETCH)
    await session.admin.query(
      `UPDATE job_dirty_work SET status = 'DONE', completed_at = clock_timestamp()
        WHERE entity_kind = 'SOURCE_RECORD' AND entity_id = $1 AND reason = $2`,
      [recordId, DETAIL_FETCH],
    )
    const c = fakeClient(() => ok([], 0.9))
    await pass(c.client, 1, { onDemandTypes: [TYPE] })
    expect(c.calls.map((x) => x.title)).toEqual([sentinel.title])
    await expectUntouched(row)
    // With no ON_DEMAND type configured the same board is IN_LIST: its record is its full text.
    await pass(c.client, 1, { onDemandTypes: [] })
    expect(c.calls.map((x) => x.title)).toEqual([sentinel.title, row.title])
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
       VALUES ($1, $2, 'rc.2', 'AI', ARRAY['QA_ENGINEER', 'BACKEND_ENGINEER'], 0.9)`,
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

  it('the pass never throws: a client rejection is logged and gets a FAILED backoff', async () => {
    const r = await opportunity()
    const log = fakeLog()
    const c = fakeClient(() => new Error(`boom ${r.title}`))
    await expect(pass(c.client, 1, { log })).resolves.toMatchObject({
      failed: 1,
      stoppedBy: null,
    })
    expect(JSON.stringify(log.lines)).not.toContain(PREFIX)
    await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    await expect(cacheOf(r)).resolves.toMatchObject({
      outcome: 'FAILED',
      attempts: 1,
      next_attempt_at: new Date(NOW.getTime() + 15 * MIN),
    })
  })

  it('a row behind a stale classifier version is never a candidate', async () => {
    const sentinel = await opportunity()
    const old = await opportunity()
    await session.admin.query(
      `UPDATE job_opportunities SET role_classifier_version = 'rc.0' WHERE id = $1`,
      [old.id],
    )
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await pass(c.client, 1)
    expect(c.calls.map((x) => x.title)).toEqual([sentinel.title])
    await expectUntouched(old)
  })

  it.each([
    ['title_key', `UPDATE job_opportunities SET title_key = title_key || ' moved' WHERE id = $1`],
    ['description_sha256', `UPDATE job_opportunities SET description_sha256 = NULL WHERE id = $1`],
  ])('a row whose %s changed during the call is stale: nothing is written', async (_, change) => {
    const r = await opportunity()
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    const racing = {
      async classify(input: RoleClassifierInput): Promise<RoleAiReply> {
        await session.admin.query(change, [r.id])
        return c.client.classify(input)
      },
    }
    await expect(pass(racing, 1)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
    await expect(rolesOf(r.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    await expect(cacheOf(r)).resolves.toBeUndefined()
    await expect(roleAiDirty(r.id)).resolves.toEqual([])
  })

  it('a cached UNCLEAR answer is applied without a model call', async () => {
    const r = await opportunity()
    await session.admin.query(
      `INSERT INTO job_role_classifications
         (title_key, description_sha256, classifier_version, outcome, confidence)
       VALUES ($1, $2, 'rc.2', 'UNCLEAR', 0.4)`,
      [r.titleKey, r.sha],
    )
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await expect(pass(c.client, 1)).resolves.toMatchObject({ unclear: 1, classified: 0 })
    expect(c.calls).toEqual([])
    await expect(rolesOf(r.id)).resolves.toMatchObject({
      role_status: 'UNCLEAR',
      technical_roles: [],
    })
    await expect(roleAiDirty(r.id)).resolves.toHaveLength(1)
  })

  it('an AI cache row with no roles is no answer: the model is asked and the row replaced', async () => {
    const r = await opportunity()
    await session.admin.query(
      `INSERT INTO job_role_classifications
         (title_key, description_sha256, classifier_version, outcome, confidence)
       VALUES ($1, $2, 'rc.2', 'AI', 0.9)`,
      [r.titleKey, r.sha],
    )
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await expect(pass(c.client, 1)).resolves.toMatchObject({ classified: 1 })
    expect(c.calls.map((x) => x.title)).toEqual([r.title])
    await expect(cacheOf(r)).resolves.toMatchObject({
      outcome: 'AI',
      technical_roles: ['QA_ENGINEER'],
    })
  })

  it('a failure on a row reclassified during the call writes no FAILED row', async () => {
    const r = await opportunity()
    const log = fakeLog()
    const racing = {
      async classify(): Promise<RoleAiReply> {
        await session.admin.query(
          `UPDATE job_opportunities SET technical_roles = ARRAY['BACKEND_ENGINEER'], role_status = 'RULE'
            WHERE id = $1`,
          [r.id],
        )
        return { kind: 'unavailable', reason: 'INVALID_OUTPUT' }
      },
    }
    await expect(pass(racing, 1, { log })).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
    await expect(cacheOf(r)).resolves.toBeUndefined()
    expect(log.lines.filter((l) => (l as unknown[])[0] === 'warn')).toEqual([])
  })

  it('a failure never overwrites a terminal row written for the key during the call', async () => {
    const r = await opportunity()
    const racing = {
      async classify(): Promise<RoleAiReply> {
        // Another vacancy with the same text was answered meanwhile.
        await session.admin.query(
          `INSERT INTO job_role_classifications
             (title_key, description_sha256, classifier_version, outcome, technical_roles, confidence)
           VALUES ($1, $2, 'rc.2', 'AI', ARRAY['QA_ENGINEER'], 0.9)`,
          [r.titleKey, r.sha],
        )
        return { kind: 'unavailable', reason: 'INVALID_OUTPUT' }
      },
    }
    await pass(racing, 1)
    await expect(cacheOf(r)).resolves.toEqual({
      outcome: 'AI',
      technical_roles: ['QA_ENGINEER'],
      confidence: '0.900',
      model: null,
      attempts: 0,
      next_attempt_at: null,
    })
  })

  it('two failures of one key at once both count: the attempts increment is atomic', async () => {
    // Two vacancies with the same title and text share one cache key.
    const a = await opportunity()
    const { rows } = await session.admin.query(
      `INSERT INTO job_opportunities
         (title, title_key, stack_keywords, description_sha256, role_status,
          role_classifier_version, availability, last_observed_at)
       VALUES ($1, $2, ARRAY['backend'], $3, 'PENDING', 'rc.2', 'OPEN',
               '2999-01-01T00:00:00Z'::timestamptz - interval '1 second')
       RETURNING id`,
      [a.title, a.titleKey, a.sha],
    )
    mine.push(rows[0].id as string)
    const store = createRoleAiStore(db, [], METER_KEY)
    const asCandidate = (id: string) => ({
      id,
      title: a.title,
      titleKey: a.titleKey,
      descriptionSha256: a.sha,
      description: a.description,
      categories: ['backend'],
    })
    await expect(
      Promise.all([
        store.recordFailure(asCandidate(a.id), NOW),
        store.recordFailure(asCandidate(rows[0].id as string), NOW),
      ]),
    ).resolves.toEqual([true, true])
    await expect(cacheOf(a)).resolves.toMatchObject({
      outcome: 'FAILED',
      attempts: 2,
      next_attempt_at: new Date(NOW.getTime() + ROLE_AI_BACKOFF(1)),
    })
  })

  it('recordFailure writes nothing and returns false when a terminal row already owns the key', async () => {
    const a = await opportunity()
    await session.admin.query(
      `INSERT INTO job_role_classifications
         (title_key, description_sha256, classifier_version, outcome, technical_roles, confidence)
       VALUES ($1, $2, 'rc.2', 'AI', ARRAY['QA_ENGINEER'], 0.9)`,
      [a.titleKey, a.sha],
    )
    const before = await cacheOf(a)
    const store = createRoleAiStore(db, [], METER_KEY)
    await expect(
      store.recordFailure(
        {
          id: a.id,
          title: a.title,
          titleKey: a.titleKey,
          descriptionSha256: a.sha,
          description: a.description,
          categories: ['backend'],
        },
        NOW,
      ),
    ).resolves.toBe(false)
    await expect(cacheOf(a)).resolves.toEqual(before)
    expect(before).toMatchObject({ outcome: 'AI', attempts: 0, next_attempt_at: null })
  })

  it(`a key at ${ROLE_AI_MAX_ATTEMPTS} attempts is no candidate; one below the cap still is`, async () => {
    const sentinel = await opportunity()
    const capped = await opportunity()
    const below = await opportunity()
    for (const [r, attempts] of [
      [capped, ROLE_AI_MAX_ATTEMPTS],
      [below, ROLE_AI_MAX_ATTEMPTS - 1],
    ] as const) {
      await session.admin.query(
        `INSERT INTO job_role_classifications
           (title_key, description_sha256, classifier_version, outcome, attempts, next_attempt_at)
         VALUES ($1, $2, 'rc.2', 'FAILED', $3, $4::timestamptz)`,
        [r.titleKey, r.sha, attempts, new Date(NOW.getTime() - MIN).toISOString()],
      )
    }
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    await pass(c.client, 2)
    expect(c.calls.map((x) => x.title)).toEqual([below.title, sentinel.title])
    await expect(rolesOf(capped.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    await expect(cacheOf(capped)).resolves.toMatchObject({
      outcome: 'FAILED',
      attempts: ROLE_AI_MAX_ATTEMPTS,
    })
  })

  it('an on-demand record whose source link is unlinked is no longer on demand: sent as IN_LIST', async () => {
    const { recordId, row } = await onDemandOpportunity()
    await session.admin.query(
      `UPDATE job_opportunity_sources SET unlinked_at = clock_timestamp(), unlink_reason = 'split'
        WHERE source_record_id = $1`,
      [recordId],
    )
    const c = fakeClient(() => ok([], 0.9))
    await pass(c.client, 1, { onDemandTypes: [TYPE] })
    expect(c.calls.map((x) => x.title)).toEqual([row.title])
  })

  it('a row that became detail-pending during the call is stale: no title-only answer is stored', async () => {
    const { recordId, row } = await onDemandOpportunity()
    const link = (unlinked: string) =>
      session.admin.query(
        `UPDATE job_opportunity_sources
            SET unlinked_at = ${unlinked}, unlink_reason = ${unlinked === 'NULL' ? 'NULL' : `'split'`}
          WHERE source_record_id = $1`,
        [recordId],
      )
    await link('clock_timestamp()')
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    const racing = {
      async classify(input: RoleClassifierInput): Promise<RoleAiReply> {
        await link('NULL') // the on-demand link is back: its detail is not fetched yet
        return c.client.classify(input)
      },
    }
    await expect(pass(racing, 1, { onDemandTypes: [TYPE] })).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
    expect(c.calls.map((x) => x.title)).toEqual([row.title])
    await expectUntouched(row)
  })

  it('the daily budget: N calls a UTC day, then a skip, and the next UTC day calls again', async () => {
    const rows = [await opportunity(), await opportunity(), await opportunity()]
    const log = fakeLog()
    const c = fakeClient(() => ok(['QA_ENGINEER'], 0.9))
    const day = new Date('2999-03-01T23:00:00.000Z')
    await expect(pass(c.client, 3, { now: day, dailyBudget: 2, log })).resolves.toMatchObject({
      classified: 2,
      stoppedBy: 'DAILY_BUDGET',
    })
    expect(c.calls).toHaveLength(2)
    expect(log.lines).toContainEqual(['log', { event: 'ROLE_AI_SKIPPED', reason: 'DAILY_BUDGET' }])
    // The oldest row waits: the same UTC day refuses it, the next one sends it.
    await pass(c.client, 1, { now: new Date(day.getTime() + 30 * MIN), dailyBudget: 2 })
    expect(c.calls).toHaveLength(2)
    await pass(c.client, 1, { now: new Date(day.getTime() + 90 * MIN), dailyBudget: 2 })
    expect(c.calls.map((x) => x.title)).toEqual([rows[2]?.title, rows[1]?.title, rows[0]?.title])
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

  describe('role-AI spend: only gated, evaluated rows are sent (spec 2026-11-19 §4)', () => {
    it('an OUT_OF_SCOPE row is never a candidate', async () => {
      const sentinel = await opportunity()
      const out = await opportunity()
      await session.admin.query(
        `UPDATE job_opportunities SET role_status = 'OUT_OF_SCOPE' WHERE id = $1`,
        [out.id],
      )
      const c = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
      await pass(c.client, 1)
      expect(c.calls.map((x) => x.title)).toEqual([sentinel.title])
      await expect(rolesOf(out.id)).resolves.toMatchObject({ role_status: 'OUT_OF_SCOPE' })
    })

    it('a PENDING row not yet evaluated at its revision is not a candidate', async () => {
      const sentinel = await opportunity()
      const ungated = await opportunity({ evaluated: false })
      const c = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
      await pass(c.client, 1)
      expect(c.calls.map((x) => x.title)).toEqual([sentinel.title])
      await expect(rolesOf(ungated.id)).resolves.toMatchObject({ role_status: 'PENDING' })
    })

    it('a row the real recompute evaluated is a candidate; one evaluated at an older revision is not', async () => {
      const { row } = await onDemandOpportunity()
      await session.admin.query(
        `UPDATE job_opportunities SET evaluated_revision = revision - 1 WHERE id = $1`,
        [row.id],
      )
      const stale = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
      await pass(stale.client, 5)
      expect(stale.calls.map((x) => x.title)).not.toContain(row.title)
      await session.admin.query(
        `UPDATE job_opportunities SET evaluated_revision = revision WHERE id = $1`,
        [row.id],
      )
      const fresh = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
      await pass(fresh.client, 5)
      expect(fresh.calls.map((x) => x.title)).toContain(row.title)
    })
  })
})
