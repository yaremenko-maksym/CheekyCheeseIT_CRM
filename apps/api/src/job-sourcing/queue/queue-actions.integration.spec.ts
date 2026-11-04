import { randomUUID } from 'node:crypto'
import { HttpException } from '@nestjs/common'
import type { JobQueueSubmitRequestDto, SessionUser } from '@crm/shared'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
  sqlstateOfRejection,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import {
  loadRoster,
  MATCH_RULE_VERSION,
  opportunityInputsVersion,
} from '../runtime/recompute-inputs'
import { JobQueueActionsService } from './queue-actions.service'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * r5 Task 6.3 — the queue's writes against a real Postgres, as the API role (`crm_app`), with
 * FOREIGN rows in the tables each read touches. The schema is the `db:push` one, which already
 * declares the staged per-senior UNIQUE (`job-queue-submissions-per-senior-ddl.integration.spec.ts`
 * proves the staged file reaches the same objects). NEVER `crm_db`: `openCrmAppSession` refuses it.
 *
 * Team A and team B share `senShared`. The raw-JSON cases assert ABSENCE on the serialized answer,
 * because a field that merely did not parse is still a leak on the wire.
 */
const TAG = `qact-${randomUUID().slice(0, 8)}`
const user = (id: string, role: SessionUser['role']): SessionUser =>
  ({ id, role, email: `${id}@example.test` }) as SessionUser

const ACTION_TRIGGERS = [
  'trg_job_queue_actions_append_only',
  'trg_job_queue_actions_no_truncate',
] as const

let session: CrmAppSession
let actions: JobQueueActionsService
const ids: Record<string, string> = {}
const id = (key: string): string => ids[key] as string
const SESSION = {} as Record<'admin' | 'hrA' | 'hrB' | 'hrNone', SessionUser>

const q = (text: string, params: unknown[] = []) => session.admin.query(text, params)

async function mkUser(key: string, role: SessionUser['role']): Promise<void> {
  const { rows } = await q(
    `INSERT INTO users (email, display_name, role, tech_stack)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${TAG}-${key}@example.test`, `${TAG} ${key}`, role, ['Go']],
  )
  ids[key] = rows[0].id as string
}
async function mkTeam(key: string): Promise<void> {
  const { rows } = await q(`INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`, [
    `${TAG}-${key}`,
  ])
  ids[key] = rows[0].id as string
}
const join = (team: string, member: string) =>
  q(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [id(team), id(member)])

/** A fresh opportunity. `copyOf` gives it the same candidate key as another one's. */
async function mkOpp(copyKey?: string): Promise<string> {
  const title = `${TAG} ${randomUUID()}`
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key, employer_name, employer_key)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, copyKey ?? title, `${TAG} Employer`, copyKey === undefined ? null : `${TAG}-emp`],
  )
  return rows[0].id as string
}

/** A LEAD match at the live versions: what makes the opportunity visible to the senior's teams. */
async function lead(opp: string, senior: string): Promise<void> {
  const roster = await loadRoster(session.databaseService.db)
  const v = roster.versions.get(id(senior))
  await q(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
        exclusion_version, rule_version, outcome, evidence)
     VALUES ($1, $2, 1, $3, $4, $5, 'LEAD', '{}')`,
    [opp, id(senior), v?.profile, v?.exclusion, MATCH_RULE_VERSION],
  )
}

/**
 * The one place fixtures state an evaluated opportunity: an owner decision may add a column to this
 * area, and only this helper then changes. Visibility itself is read through the predicate.
 */
const markEvaluatedOpen = async (opp: string) => {
  const { exclusions } = await loadRoster(session.databaseService.db)
  await q(
    `UPDATE job_opportunities
        SET evaluated_revision = revision, evaluation_verdict = 'OPEN', evaluated_inputs_version = $2
      WHERE id = $1`,
    [opp, opportunityInputsVersion(exclusions)],
  )
}

async function triageGrant(opp: string, team: string): Promise<void> {
  await markEvaluatedOpen(opp)
  await q(
    `INSERT INTO job_opportunity_team_triage
       (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision, expires_at)
     VALUES ($1, $2, $3, 1, 1, now() + interval '1 day')`,
    [opp, id(team), id('admin')],
  )
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; raw: string }> {
  const e: unknown = await p.then(
    () => new Error('expected a refusal, got a result'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  const http = e as HttpException
  return { status: http.getStatus(), raw: JSON.stringify(http.getResponse()) }
}
async function expectCode(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const r = await refusal(p)
  expect(r.status).toBe(status)
  expect(JSON.parse(r.raw).code).toBe(code)
}
const expectNotFound = (p: Promise<unknown>) => expectCode(p, 404, 'JOB_OPPORTUNITY_NOT_FOUND')
const expectStale = (p: Promise<unknown>) => expectCode(p, 409, 'JOB_QUEUE_VERSION_CONFLICT')

const submitBody = (
  senior: string,
  over: Partial<JobQueueSubmitRequestDto> = {},
): JobQueueSubmitRequestDto => ({
  seniorId: id(senior),
  idempotencyKey: randomUUID(),
  expectedOpportunityRevision: 1,
  confirmPossibleDuplicate: false,
  ...over,
})

const submissionRows = async (opp: string) =>
  (await q(`SELECT * FROM job_queue_assignments WHERE opportunity_id = $1`, [opp])).rows
const actionRows = async (opp: string) =>
  (
    await q(
      `SELECT kind, actor_id, team_id, before_version, after_version FROM job_queue_actions
        WHERE opportunity_id = $1 ORDER BY created_at`,
      [opp],
    )
  ).rows

describe.skipIf(!hasDatabaseUrl())('JobQueueActionsService against Postgres (Task 6.3)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 6 })
    const probe = await session.admin.query(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    actions = new JobQueueActionsService(session.databaseService, new JobQueueScopeService())

    await mkUser('admin', 'ADMIN')
    for (const hr of ['hrA', 'hrB', 'hrNone', 'hrLeaving']) await mkUser(hr, 'HR')
    for (const s of [
      'senA',
      'senA2',
      'senB',
      'senShared',
      'senShared2',
      'senShared3',
      'senShared4',
      'senLeaving',
      'senArchived',
      'senStop',
      'senMid',
      'senTeamMid',
      'senSlug',
      'senShared5',
      'senShared6',
      'senShared7',
    ]) {
      await mkUser(s, 'SENIOR')
    }
    await mkUser('hrTeamMid', 'HR')
    await mkTeam('teamA')
    await mkTeam('teamB')
    await mkTeam('teamMid')
    for (const m of ['hrTeamMid', 'senTeamMid']) await join('teamMid', m)
    for (const m of [
      'hrA',
      'hrLeaving',
      'senA',
      'senA2',
      'senLeaving',
      'senArchived',
      'senStop',
      'senMid',
      'senSlug',
    ]) {
      await join('teamA', m)
    }
    for (const m of ['hrB', 'senB']) await join('teamB', m)
    for (const s of [
      'senShared',
      'senShared2',
      'senShared3',
      'senShared4',
      'senShared5',
      'senShared6',
      'senShared7',
    ]) {
      await join('teamA', s)
      await join('teamB', s)
    }
    SESSION.admin = user(id('admin'), 'ADMIN')
    SESSION.hrA = user(id('hrA'), 'HR')
    SESSION.hrB = user(id('hrB'), 'HR')
    SESSION.hrNone = user(id('hrNone'), 'HR')
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      // The only way to clean an append-only table is to be its owner (the append-only spec's way).
      for (const name of ACTION_TRIGGERS) {
        await q(`ALTER TABLE job_queue_actions DISABLE TRIGGER ${name}`)
      }
      const taggedUsers = `SELECT id FROM users WHERE email LIKE $1`
      const emails = [`${TAG}%`]
      await q(`DELETE FROM job_queue_actions WHERE actor_id IN (${taggedUsers})`, emails)
      await q(
        `DELETE FROM job_queue_assignments WHERE senior_id IN (${taggedUsers})
            OR assignee_id IN (${taggedUsers})`,
        emails,
      )
      await q(`DELETE FROM job_queue_dismissals WHERE dismissed_by IN (${taggedUsers})`, emails)
      await q(
        `DELETE FROM job_opportunity_sources WHERE opportunity_id IN
           (SELECT id FROM job_opportunities WHERE title LIKE $1)`,
        emails,
      )
      await q(
        `UPDATE job_source_records SET latest_revision_id = NULL WHERE namespace LIKE $1`,
        emails,
      )
      await q(
        `DELETE FROM job_source_record_revisions WHERE source_record_id IN
           (SELECT id FROM job_source_records WHERE namespace LIKE $1)`,
        emails,
      )
      await q(`DELETE FROM job_source_records WHERE namespace LIKE $1`, emails)
      await q(`DELETE FROM job_opportunities WHERE title LIKE $1`, emails)
      await q(`DELETE FROM job_exclusion_filters WHERE senior_id IN (${taggedUsers})`, emails)
      await q(`DELETE FROM team_members WHERE user_id IN (${taggedUsers})`, emails)
      await q(`DELETE FROM teams WHERE name LIKE $1`, emails)
      await q(`DELETE FROM users WHERE email LIKE $1`, emails)
    } finally {
      for (const name of ACTION_TRIGGERS) {
        await q(`ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER ${name}`)
      }
      await session.close()
    }
  })

  describe('submit: the model', () => {
    it('two seniors of one team are submitted independently', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const one = await actions.submit(SESSION.hrA, opp, submitBody('senA'))
      const two = await actions.submit(SESSION.hrA, opp, submitBody('senA2'))
      expect(one.submission.id).not.toBe(two.submission.id)
      expect(one.submission.version).toBe(1)
      expect(two.submission.version).toBe(1)
      expect(one.submission.submittedByName).toBe(`${TAG} hrA`)
      const rows = await submissionRows(opp)
      expect(rows.map((r) => r.senior_id).sort()).toEqual([id('senA'), id('senA2')].sort())
      expect(rows.every((r) => r.team_id === id('teamA') && r.scope_kind === 'TEAM')).toBe(true)
    })

    it('a triage item with no match row may be submitted', async () => {
      const opp = await mkOpp()
      await triageGrant(opp, 'teamA')
      const res = await actions.submit(SESSION.hrA, opp, submitBody('senA'))
      expect(res.submission.state).toBe('TAKEN')
    })

    it('the same senior concurrently: exactly one wins, the other is the generic conflict', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const settled = await Promise.allSettled([
        actions.submit(SESSION.hrA, opp, submitBody('senA')),
        actions.submit(SESSION.hrA, opp, submitBody('senA')),
      ])
      const won = settled.filter((s) => s.status === 'fulfilled')
      const lost = settled.filter((s) => s.status === 'rejected')
      expect(won).toHaveLength(1)
      expect(lost).toHaveLength(1)
      const failure = (lost[0] as PromiseRejectedResult).reason as HttpException
      expect(failure.getStatus()).toBe(409)
      expect(failure.getResponse()).toMatchObject({ code: 'JOB_QUEUE_VERSION_CONFLICT' })
      expect(await submissionRows(opp)).toHaveLength(1)
      expect(await actionRows(opp)).toHaveLength(1)
    })

    it('a repeated key returns the earlier success and writes nothing more', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const body = submitBody('senA')
      const first = await actions.submit(SESSION.hrA, opp, body)
      const retry = await actions.submit(SESSION.hrA, opp, body)
      expect(retry).toEqual(first)
      expect(await actionRows(opp)).toHaveLength(1)
      expect(await submissionRows(opp)).toHaveLength(1)
    })

    it('a lost-response retry after the row moved on still answers the earlier success', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const body = submitBody('senA')
      const first = await actions.submit(SESSION.hrA, opp, body)
      await actions.cancelSubmission(SESSION.hrA, opp, first.submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      expect(await actions.submit(SESSION.hrA, opp, body)).toEqual(first)
    })

    it('a retry whose target has since become invisible gets the 404: it fails closed', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const body = submitBody('senA')
      await actions.submit(SESSION.hrA, opp, body)
      await q(`UPDATE job_opportunities SET revision = revision + 1 WHERE id = $1`, [opp])
      await expectNotFound(actions.submit(SESSION.hrA, opp, body))
      expect(await actionRows(opp)).toHaveLength(1)
    })

    it('the log names no person: the reason holds no senior and no assignee', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const { submission } = await actions.submit(SESSION.hrA, opp, submitBody('senA'))
      await actions.cancelSubmission(SESSION.hrA, opp, submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      const { rows } = await q(`SELECT reason FROM job_queue_actions WHERE opportunity_id = $1`, [
        opp,
      ])
      expect(rows).toHaveLength(2)
      for (const { reason } of rows) {
        expect(Object.keys(JSON.parse(reason as string)).sort()).toEqual([
          'fp',
          'submissionId',
          'submittedAt',
        ])
        expect(reason).not.toContain(id('senA'))
        expect(reason).not.toContain(id('hrA'))
      }
    })

    it('the same key with another payload is the idempotency conflict, on any opportunity', async () => {
      const opp = await mkOpp()
      const other = await mkOpp()
      await lead(opp, 'senA')
      await lead(other, 'senA')
      const body = submitBody('senA')
      await actions.submit(SESSION.hrA, opp, body)
      await expectCode(
        actions.submit(SESSION.hrA, opp, { ...body, seniorId: id('senA2') }),
        409,
        'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
      )
      await expectCode(
        actions.submit(SESSION.hrA, other, body),
        409,
        'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
      )
      expect(await submissionRows(other)).toHaveLength(0)
    })

    it('one key used concurrently on two opportunities: one writes, the other conflicts', async () => {
      const a = await mkOpp()
      const b = await mkOpp()
      await lead(a, 'senA')
      await lead(b, 'senA')
      const body = submitBody('senA')
      const settled = await Promise.allSettled([
        actions.submit(SESSION.hrA, a, body),
        actions.submit(SESSION.hrA, b, body),
      ])
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
      const failure = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
      expect((failure.reason as HttpException).getResponse()).toMatchObject({
        code: 'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
      })
    })

    it('another actor reusing a key is unrelated: per-actor keys disclose nothing', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await lead(opp, 'senB')
      const key = randomUUID()
      await actions.submit(SESSION.hrA, opp, submitBody('senA', { idempotencyKey: key }))
      const res = await actions.submit(
        SESSION.hrB,
        opp,
        submitBody('senB', { idempotencyKey: key }),
      )
      expect(res.submission.seniorId).toBe(id('senB'))
    })

    it('an audit failure rolls the mutation back', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const code = await session.withPrivilegeWithdrawn('INSERT', 'job_queue_actions', () =>
        sqlstateOfRejection(() => actions.submit(SESSION.hrA, opp, submitBody('senA'))),
      )
      expect(code).toBe('42501')
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('an own cancelled row is the versioned UPDATE: same id, next version, audit moves', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const first = await actions.submit(SESSION.hrA, opp, submitBody('senA'))
      await actions.cancelSubmission(SESSION.hrA, opp, first.submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      await expectStale(actions.submit(SESSION.hrA, opp, submitBody('senA')))
      await expectStale(
        actions.submit(SESSION.hrA, opp, submitBody('senA', { expectedVersion: 1 })),
      )
      const again = await actions.submit(
        SESSION.hrA,
        opp,
        submitBody('senA', { expectedVersion: 2 }),
      )
      expect(again.submission).toMatchObject({
        id: first.submission.id,
        version: 3,
        state: 'TAKEN',
      })
      expect(again.submission.cancelledAt).toBeNull()
      const log = await actionRows(opp)
      expect(log.map((r) => [r.kind, r.before_version, r.after_version])).toEqual([
        ['TAKEN', 0, 1],
        ['RELEASED', 1, 2],
        ['TAKEN', 2, 3],
      ])
    })

    it('a stale revision of the opportunity is a conflict, not a write', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await expectStale(
        actions.submit(SESSION.hrA, opp, submitBody('senA', { expectedOpportunityRevision: 99 })),
      )
      expect(await submissionRows(opp)).toHaveLength(0)
    })
  })

  describe('submit: who may write', () => {
    it('an ADMIN in STUDIO writes a STUDIO row; for a senior of any team', async () => {
      const opp = await mkOpp()
      const res = await actions.submit(SESSION.admin, opp, submitBody('senB'))
      expect(res.submission.state).toBe('TAKEN')
      const [row] = await submissionRows(opp)
      expect(row.scope_kind).toBe('STUDIO')
      expect(row.team_id).toBeNull()
      expect(row.assignee_id).toBe(id('admin'))
    })

    it('an HR naming a team they are not in, or with none, is the same 404', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senB')
      await expectNotFound(
        actions.submit(SESSION.hrA, opp, submitBody('senB', { teamId: id('teamB') })),
      )
      await expectNotFound(actions.submit(SESSION.hrNone, opp, submitBody('senB')))
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('a senior of another team is a 404, even on an opportunity visible to the actor', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await expectNotFound(actions.submit(SESSION.hrA, opp, submitBody('senB')))
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('an opportunity outside the scope, or missing, is the same 404', async () => {
      const foreign = await mkOpp()
      await lead(foreign, 'senB')
      const a = await refusal(actions.submit(SESSION.hrA, foreign, submitBody('senA')))
      const b = await refusal(actions.submit(SESSION.hrA, randomUUID(), submitBody('senA')))
      expect(a).toEqual(b)
      expect(a.status).toBe(404)
    })

    it('an opportunity that just became hidden fails: its revision moved past the match', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await q(`UPDATE job_opportunities SET revision = revision + 1 WHERE id = $1`, [opp])
      await expectNotFound(
        actions.submit(SESSION.hrA, opp, submitBody('senA', { expectedOpportunityRevision: 2 })),
      )
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('a senior who left the team or was archived is refused', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await q(`UPDATE team_members SET left_at = now() WHERE user_id = $1 AND team_id = $2`, [
        id('senLeaving'),
        id('teamA'),
      ])
      await expectNotFound(actions.submit(SESSION.hrA, opp, submitBody('senLeaving')))
      await q(`UPDATE users SET archived_at = now() WHERE id = $1`, [id('senArchived')])
      await expectNotFound(actions.submit(SESSION.hrA, opp, submitBody('senArchived')))
      expect(await submissionRows(opp)).toHaveLength(0)
      expect(await actionRows(opp)).toHaveLength(0)
    })

    it('a senior who stop-listed the company is the same 404', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await q(
        `INSERT INTO job_exclusion_filters (senior_id, kind, value, normalized_value)
         VALUES ($1, 'COMPANY', $2, $3)`,
        [id('senStop'), `${TAG} Employer`, `${TAG} employer`],
      )
      await expectNotFound(actions.submit(SESSION.hrA, opp, submitBody('senStop')))
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('a stop-list entry matching only the DOU URL slug is the same 404, as in the funnel', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const slug = `slugonly${TAG.replace('-', '')}`
      const { rows } = await q(
        `INSERT INTO job_source_records
           (source_type, namespace, identity_kind, identity_key, source_url)
         VALUES ('DOU_RSS', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
        [`${TAG}-ns`, randomUUID(), `https://jobs.dou.ua/companies/${slug}/vacancies/1/`],
      )
      const record = rows[0].id as string
      const revision = await q(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized,
            original_identity)
         VALUES ($1, 'v1', 'v1', $2, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
        [record, randomUUID().replaceAll('-', '').padEnd(64, '0')],
      )
      await q(`UPDATE job_source_records SET latest_revision_id = $2 WHERE id = $1`, [
        record,
        revision.rows[0].id,
      ])
      await q(
        `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
         VALUES ($1, $2, '1')`,
        [record, opp],
      )
      // The opportunity's own employer is another name: only the URL's slug can match.
      await q(
        `INSERT INTO job_exclusion_filters (senior_id, kind, value, normalized_value)
         VALUES ($1, 'COMPANY', $2, $2)`,
        [id('senSlug'), slug],
      )
      await expectNotFound(actions.submit(SESSION.hrA, opp, submitBody('senSlug')))
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('another senior stop-list does not refuse this senior', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const employer = `${TAG} Employer`
      await q(
        `INSERT INTO job_exclusion_filters (senior_id, kind, value, normalized_value)
         VALUES ($1, 'COMPANY', $2, $3) ON CONFLICT DO NOTHING`,
        [id('senStop'), employer, employer.toLowerCase()],
      )
      await expect(actions.submit(SESSION.hrA, opp, submitBody('senA2'))).resolves.toBeDefined()
    })

    /**
     * A concurrent writer holds a change until the attempt is proved to be queued behind it, then
     * commits. The proof is the database's own: a backend whose blockers include the holder's pid.
     */
    async function underConcurrentChange(
      change: (client: PoolClient) => Promise<unknown>,
      attempt: () => Promise<unknown>,
    ): Promise<void> {
      const client = await session.admin.connect()
      let pending: Promise<unknown> | undefined
      try {
        await client.query('BEGIN')
        const holder = await client.query('SELECT pg_backend_pid() AS pid')
        await change(client)
        pending = expectNotFound(attempt())
        await untilQueuedBehind(Number(holder.rows[0].pid))
        await client.query('COMMIT')
        await pending
      } catch (err) {
        await client.query('ROLLBACK')
        await pending?.catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    }

    /** Bounded: an attempt that never queues is a failure of the test, not a silent pass. */
    async function untilQueuedBehind(holderPid: number): Promise<void> {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const { rows } = await q(
          `SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        )
        if (rows.length > 0) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('no backend queued behind the held lock within 10s')
    }

    it('membership mid-mutation: a senior leaving while the submit waits is refused', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await underConcurrentChange(
        (c) =>
          c.query(`UPDATE team_members SET left_at = now() WHERE user_id = $1 AND team_id = $2`, [
            id('senMid'),
            id('teamA'),
          ]),
        () => actions.submit(SESSION.hrA, opp, submitBody('senMid')),
      )
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('permission mid-mutation: the actor leaving while the submit waits is refused', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const actor = user(id('hrLeaving'), 'HR')
      await underConcurrentChange(
        (c) =>
          c.query(`UPDATE team_members SET left_at = now() WHERE user_id = $1 AND team_id = $2`, [
            id('hrLeaving'),
            id('teamA'),
          ]),
        () => actions.submit(actor, opp, submitBody('senA')),
      )
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('team mid-mutation: an archival while the submit waits is refused', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senTeamMid')
      const actor = user(id('hrTeamMid'), 'HR')
      await underConcurrentChange(
        (c) => c.query(`UPDATE teams SET archived_at = now() WHERE id = $1`, [id('teamMid')]),
        () => actions.submit(actor, opp, submitBody('senTeamMid')),
      )
      expect(await submissionRows(opp)).toHaveLength(0)
    })

    it('a posting close while the submit waits on the set lock is refused, and writes nothing', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await underConcurrentChange(
        (c) =>
          c.query(
            `UPDATE job_opportunities SET availability = 'CLOSED', revision = revision + 1
              WHERE id = $1`,
            [opp],
          ),
        () => actions.submit(SESSION.hrA, opp, submitBody('senA')),
      )
      expect(await submissionRows(opp)).toHaveLength(0)
      expect(await actionRows(opp)).toHaveLength(0)
    })

    it('a session role the database no longer holds is refused', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      // The JWT still says ADMIN; the row says HR.
      const stale = user(id('hrA'), 'ADMIN')
      await expectNotFound(actions.submit(stale, opp, submitBody('senA')))
      expect(await submissionRows(opp)).toHaveLength(0)
    })
  })

  describe('owner decision A3: a senior shared by two teams', () => {
    const FOREIGN_FIELDS = ['"id"', 'submittedAt', 'cancelledAt', '"version"', 'submittedByName']

    it('B on A LIVE submission: a conflict with the bare marker, nothing of the row', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared')
      const a = await actions.submit(SESSION.hrA, opp, submitBody('senShared'))
      const r = await refusal(actions.submit(SESSION.hrB, opp, submitBody('senShared')))
      expect(r.status).toBe(409)
      const body = JSON.parse(r.raw)
      expect(body.submittedElsewhere).toBe(true)
      expect(body.code).toBe('JOB_QUEUE_VERSION_CONFLICT')
      for (const field of FOREIGN_FIELDS) expect(r.raw).not.toContain(field)
      for (const value of [
        a.submission.id,
        a.submission.submittedAt,
        id('teamA'),
        id('hrA'),
        `${TAG} hrA`,
      ]) {
        expect(r.raw).not.toContain(value)
      }
      expect(await submissionRows(opp)).toHaveLength(1)
    })

    it('A CANCELLED submission: every error B can provoke is byte-identical to no submission', async () => {
      const cancelled = await mkOpp()
      const untouched = await mkOpp()
      await lead(cancelled, 'senShared2')
      await lead(untouched, 'senShared2')
      const a = await actions.submit(SESSION.hrA, cancelled, submitBody('senShared2'))
      await actions.cancelSubmission(SESSION.hrA, cancelled, a.submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      for (const expectedVersion of [1, 2, 3]) {
        const withRow = await refusal(
          actions.submit(SESSION.hrB, cancelled, submitBody('senShared2', { expectedVersion })),
        )
        const noRow = await refusal(
          actions.submit(SESSION.hrB, untouched, submitBody('senShared2', { expectedVersion })),
        )
        expect(withRow).toEqual(noRow)
        expect(withRow.raw).not.toContain('submittedElsewhere')
      }
      const stale = { expectedOpportunityRevision: 99 }
      expect(
        await refusal(actions.submit(SESSION.hrB, cancelled, submitBody('senShared2', stale))),
      ).toEqual(
        await refusal(actions.submit(SESSION.hrB, untouched, submitBody('senShared2', stale))),
      )
    })

    it('B over A CANCELLED row: new id, version 1, nothing of A, and A history survives', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared3')
      const a = await actions.submit(SESSION.hrA, opp, submitBody('senShared3'))
      const cancel = await actions.cancelSubmission(SESSION.hrA, opp, a.submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      const b = await actions.submit(SESSION.hrB, opp, submitBody('senShared3'))
      expect(b.submission.id).not.toBe(a.submission.id)
      expect(b.submission.version).toBe(1)
      expect(b.submission.cancelledAt).toBeNull()
      const raw = JSON.stringify(b)
      for (const value of [
        a.submission.id,
        a.submission.submittedAt,
        cancel.submission.cancelledAt as string,
        id('teamA'),
        id('hrA'),
        `${TAG} hrA`,
      ]) {
        expect(raw).not.toContain(value)
      }
      const rows = await submissionRows(opp)
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(b.submission.id)
      expect(rows[0].team_id).toBe(id('teamB'))
      const log = await actionRows(opp)
      expect(log.map((r) => [r.kind, r.team_id, r.before_version, r.after_version])).toEqual([
        ['TAKEN', id('teamA'), 0, 1],
        ['RELEASED', id('teamA'), 1, 2],
        ['TAKEN', id('teamB'), 0, 1],
      ])
    })

    it('afterwards A sees only the marker, and A retrying its old key does not touch B row', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared4')
      const key = randomUUID()
      const a = await actions.submit(
        SESSION.hrA,
        opp,
        submitBody('senShared4', { idempotencyKey: key }),
      )
      await actions.cancelSubmission(SESSION.hrA, opp, a.submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      const b = await actions.submit(SESSION.hrB, opp, submitBody('senShared4'))
      const r = await refusal(
        actions.submit(SESSION.hrA, opp, submitBody('senShared4', { expectedVersion: 2 })),
      )
      expect(JSON.parse(r.raw).submittedElsewhere).toBe(true)
      expect(r.raw).not.toContain(b.submission.id)
      const replay = await actions.submit(
        SESSION.hrA,
        opp,
        submitBody('senShared4', { idempotencyKey: key }),
      )
      expect(replay).toEqual(a)
      expect(JSON.stringify(replay)).not.toContain(b.submission.id)
      expect((await submissionRows(opp))[0].id).toBe(b.submission.id)
    })
  })

  describe('owner decision A3: a takeover racing the team it takes over from', () => {
    const marker = (result: PromiseSettledResult<unknown>) => {
      expect(result.status).toBe('rejected')
      const failure = (result as PromiseRejectedResult).reason as HttpException
      expect(failure.getStatus()).toBe(409)
      expect(failure.getResponse()).toMatchObject({ submittedElsewhere: true })
    }

    it('takeover against A re-submitting its cancelled row: one wins, the other has the marker', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared5')
      const a = await actions.submit(SESSION.hrA, opp, submitBody('senShared5'))
      await actions.cancelSubmission(SESSION.hrA, opp, a.submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      const [byB, byA] = await Promise.allSettled([
        actions.submit(SESSION.hrB, opp, submitBody('senShared5')),
        actions.submit(SESSION.hrA, opp, submitBody('senShared5', { expectedVersion: 2 })),
      ])
      const rows = await submissionRows(opp)
      expect(rows).toHaveLength(1)
      expect([byB.status, byA.status].sort()).toEqual(['fulfilled', 'rejected'])
      marker(byB.status === 'fulfilled' ? byA : byB)
      expect(rows[0]).toMatchObject(
        byB.status === 'fulfilled'
          ? { state: 'TAKEN', team_id: id('teamB'), version: 1 }
          : { state: 'TAKEN', team_id: id('teamA'), version: 3, id: a.submission.id },
      )
    })

    it('takeover against A cancelling: the cancel holds, and the row is the winner of the order', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared6')
      const a = await actions.submit(SESSION.hrA, opp, submitBody('senShared6'))
      const [cancel, byB] = await Promise.allSettled([
        actions.cancelSubmission(SESSION.hrA, opp, a.submission.id, {
          idempotencyKey: randomUUID(),
          expectedVersion: 1,
        }),
        actions.submit(SESSION.hrB, opp, submitBody('senShared6')),
      ])
      expect(cancel.status).toBe('fulfilled')
      const rows = await submissionRows(opp)
      expect(rows).toHaveLength(1)
      ;[byB].filter((b) => b.status === 'rejected').forEach(marker)
      expect(rows[0]).toMatchObject(
        byB.status === 'fulfilled'
          ? { team_id: id('teamB'), state: 'TAKEN' }
          : { team_id: id('teamA'), state: 'RELEASED' },
      )
    })

    it('A retrying its cancel after the takeover is a 404: the row it names is gone', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared7')
      const a = await actions.submit(SESSION.hrA, opp, submitBody('senShared7'))
      const cancel = { idempotencyKey: randomUUID(), expectedVersion: 1 }
      await actions.cancelSubmission(SESSION.hrA, opp, a.submission.id, cancel)
      const b = await actions.submit(SESSION.hrB, opp, submitBody('senShared7'))
      await expectNotFound(actions.cancelSubmission(SESSION.hrA, opp, a.submission.id, cancel))
      expect((await submissionRows(opp))[0].id).toBe(b.submission.id)
    })
  })

  describe('a reused key is no existence oracle: hidden and missing answer alike', () => {
    async function usedKeyAndHiddenTarget() {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const hidden = await mkOpp()
      await lead(hidden, 'senB')
      return { opp, hidden, key: randomUUID() }
    }

    it('submit', async () => {
      const { opp, hidden, key } = await usedKeyAndHiddenTarget()
      const body = submitBody('senA', { idempotencyKey: key })
      await actions.submit(SESSION.hrA, opp, body)
      const a = await refusal(actions.submit(SESSION.hrA, hidden, body))
      const b = await refusal(actions.submit(SESSION.hrA, randomUUID(), body))
      expect(a.status).toBe(404)
      expect(a.raw).toBe(b.raw)
    })

    it('dismiss', async () => {
      const { opp, hidden, key } = await usedKeyAndHiddenTarget()
      const body = { scope: 'TEAM' as const, reason: 'SPAM' as const, idempotencyKey: key }
      await actions.dismiss(SESSION.hrA, opp, body)
      const a = await refusal(actions.dismiss(SESSION.hrA, hidden, body))
      const b = await refusal(actions.dismiss(SESSION.hrA, randomUUID(), body))
      expect(a.status).toBe(404)
      expect(a.raw).toBe(b.raw)
    })

    it('cancel', async () => {
      const { opp, hidden, key } = await usedKeyAndHiddenTarget()
      const own = await actions.submit(SESSION.hrA, opp, submitBody('senA'))
      const foreign = await actions.submit(SESSION.hrB, hidden, submitBody('senB'))
      const body = { idempotencyKey: key, expectedVersion: 1 }
      await actions.cancelSubmission(SESSION.hrA, opp, own.submission.id, body)
      const a = await refusal(
        actions.cancelSubmission(SESSION.hrA, hidden, foreign.submission.id, body),
      )
      const b = await refusal(actions.cancelSubmission(SESSION.hrA, hidden, randomUUID(), body))
      const c = await refusal(
        actions.cancelSubmission(SESSION.hrA, randomUUID(), randomUUID(), body),
      )
      expect(a.status).toBe(404)
      expect(a.raw).toBe(b.raw)
      expect(a.raw).toBe(c.raw)
    })

    it('undo', async () => {
      const { opp, hidden, key } = await usedKeyAndHiddenTarget()
      const dismissal = { scope: 'TEAM' as const, reason: 'SPAM' as const }
      await actions.dismiss(SESSION.hrA, opp, { ...dismissal, idempotencyKey: randomUUID() })
      await actions.dismiss(SESSION.hrB, hidden, { ...dismissal, idempotencyKey: randomUUID() })
      const body = { scope: 'TEAM' as const, idempotencyKey: key, expectedVersion: 1 }
      await actions.undo(SESSION.hrA, opp, body)
      const a = await refusal(actions.undo(SESSION.hrA, hidden, body))
      const b = await refusal(actions.undo(SESSION.hrA, randomUUID(), body))
      expect(a.status).toBe(404)
      expect(a.raw).toBe(b.raw)
    })
  })

  describe('possible duplicates, per senior', () => {
    it('two concurrent submissions to unmerged copies: exactly one passes without confirmation', async () => {
      const copyKey = `${TAG}-${randomUUID()}`
      const one = await mkOpp(copyKey)
      const two = await mkOpp(copyKey)
      await lead(one, 'senA')
      await lead(two, 'senA')
      const settled = await Promise.allSettled([
        actions.submit(SESSION.hrA, one, submitBody('senA')),
        actions.submit(SESSION.hrA, two, submitBody('senA')),
      ])
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
      const failure = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
      const body = (failure.reason as HttpException).getResponse() as {
        code: string
        possibleDuplicates: { items: Array<{ opportunityId: string }>; totalCount: number }
      }
      expect(body.code).toBe('JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED')
      expect(body.possibleDuplicates.totalCount).toBe(1)
      expect([one, two]).toContain(body.possibleDuplicates.items[0]?.opportunityId)
    })

    it('a confirmation passes; another senior needs none', async () => {
      const copyKey = `${TAG}-${randomUUID()}`
      const one = await mkOpp(copyKey)
      const two = await mkOpp(copyKey)
      await lead(one, 'senA')
      await lead(two, 'senA')
      await actions.submit(SESSION.hrA, one, submitBody('senA'))
      await actions.submit(SESSION.hrA, two, submitBody('senA2'))
      await expectCode(
        actions.submit(SESSION.hrA, two, submitBody('senA')),
        409,
        'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
      )
      const res = await actions.submit(
        SESSION.hrA,
        two,
        submitBody('senA', { confirmPossibleDuplicate: true }),
      )
      expect(res.submission.state).toBe('TAKEN')
    })

    it('another team live submission on a copy changes nothing for this team', async () => {
      const copyKey = `${TAG}-${randomUUID()}`
      const one = await mkOpp(copyKey)
      const two = await mkOpp(copyKey)
      await lead(one, 'senShared')
      await lead(two, 'senShared')
      await actions.submit(SESSION.hrA, one, submitBody('senShared'))
      const res = await actions.submit(SESSION.hrB, two, submitBody('senShared'))
      expect(res.submission.state).toBe('TAKEN')
    })
  })

  describe('cancel', () => {
    async function liveSubmission(senior = 'senA') {
      const opp = await mkOpp()
      await lead(opp, senior)
      const { submission } = await actions.submit(SESSION.hrA, opp, submitBody(senior))
      return { opp, submission }
    }
    const cancelBody = (expectedVersion = 1) => ({
      idempotencyKey: randomUUID(),
      expectedVersion,
    })

    it('keeps the row, records who, and the action log has both rows', async () => {
      const { opp, submission } = await liveSubmission()
      const res = await actions.cancelSubmission(SESSION.hrA, opp, submission.id, cancelBody())
      expect(res.submission).toMatchObject({ id: submission.id, state: 'RELEASED', version: 2 })
      expect(res.submission.cancelledAt).not.toBeNull()
      const [row] = await submissionRows(opp)
      expect(row.state).toBe('RELEASED')
      expect(row.released_by).toBe(id('hrA'))
      expect((await actionRows(opp)).map((r) => r.kind)).toEqual(['TAKEN', 'RELEASED'])
    })

    it('a foreign team HR gets the 404 a missing submission gets, and the row is untouched', async () => {
      const { opp, submission } = await liveSubmission('senShared')
      const foreign = await refusal(
        actions.cancelSubmission(SESSION.hrB, opp, submission.id, cancelBody()),
      )
      const missing = await refusal(
        actions.cancelSubmission(SESSION.hrB, opp, randomUUID(), cancelBody()),
      )
      expect(foreign).toEqual(missing)
      expect(foreign.status).toBe(404)
      expect((await submissionRows(opp))[0].state).toBe('TAKEN')
    })

    it('a submission of another opportunity is the same 404', async () => {
      const { submission } = await liveSubmission()
      const other = await mkOpp()
      await expectNotFound(
        actions.cancelSubmission(SESSION.hrA, other, submission.id, cancelBody()),
      )
    })

    it('any ADMIN cancels in STUDIO; a second cancel is the version conflict', async () => {
      const { opp, submission } = await liveSubmission()
      const res = await actions.cancelSubmission(SESSION.admin, opp, submission.id, cancelBody())
      expect(res.submission.state).toBe('RELEASED')
      await expectStale(actions.cancelSubmission(SESSION.hrA, opp, submission.id, cancelBody(2)))
    })

    it('a stale version is the generic conflict; a retry returns the earlier success', async () => {
      const { opp, submission } = await liveSubmission()
      await expectStale(actions.cancelSubmission(SESSION.hrA, opp, submission.id, cancelBody(9)))
      const body = cancelBody()
      const first = await actions.cancelSubmission(SESSION.hrA, opp, submission.id, body)
      expect(await actions.cancelSubmission(SESSION.hrA, opp, submission.id, body)).toEqual(first)
      expect(await actionRows(opp)).toHaveLength(2)
    })

    it('stays possible when the opportunity is hidden: the record can still be corrected', async () => {
      const { opp, submission } = await liveSubmission()
      await q(`UPDATE job_opportunities SET revision = revision + 1 WHERE id = $1`, [opp])
      const res = await actions.cancelSubmission(SESSION.hrA, opp, submission.id, cancelBody())
      expect(res.submission.state).toBe('RELEASED')
    })

    it('submit and cancel racing on one row: serialized, the final state matches the log', async () => {
      const { opp, submission } = await liveSubmission()
      const settled = await Promise.allSettled([
        actions.cancelSubmission(SESSION.hrA, opp, submission.id, cancelBody()),
        actions.submit(SESSION.hrA, opp, submitBody('senA', { expectedVersion: 2 })),
      ])
      const log = await actionRows(opp)
      expect(log.length).toBe(1 + settled.filter((s) => s.status === 'fulfilled').length)
      const [row] = await submissionRows(opp)
      // `created_at` is each transaction's start, so the racing rows may sort either way.
      expect(row.version).toBe(Math.max(...log.map((r) => r.after_version as number)))
    })
  })

  describe('dismiss and undo', () => {
    const dismissBody = (over: Record<string, unknown> = {}) => ({
      scope: 'TEAM' as const,
      reason: 'NOT_RELEVANT' as const,
      idempotencyKey: randomUUID(),
      ...over,
    })
    const undoBody = (expectedVersion: number) => ({
      scope: 'TEAM' as const,
      idempotencyKey: randomUUID(),
      expectedVersion,
    })
    const dismissals = async (opp: string) =>
      (
        await q(
          `SELECT team_id, scope_kind, version, undone_at FROM job_queue_dismissals
            WHERE opportunity_id = $1 ORDER BY team_id NULLS LAST`,
          [opp],
        )
      ).rows

    it('a team dismissal is that team: B dismisses, undoes and re-dismisses apart from A', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared')
      const a = await actions.dismiss(SESSION.hrA, opp, dismissBody())
      const b = await actions.dismiss(SESSION.hrB, opp, dismissBody({ reason: 'SPAM' }))
      expect(a).toMatchObject({ scope: 'TEAM', hidden: true, version: 1 })
      expect(b).toMatchObject({ scope: 'TEAM', hidden: true, version: 1, reason: 'SPAM' })
      const undone = await actions.undo(SESSION.hrB, opp, undoBody(1))
      expect(undone).toMatchObject({ hidden: false, version: 2, reason: 'SPAM' })
      const rows = await dismissals(opp)
      expect(rows).toHaveLength(2)
      const teamARow = rows.find((r) => r.team_id === id('teamA'))
      expect(teamARow?.undone_at).toBeNull()
      expect(teamARow?.version).toBe(1)
      const again = await actions.dismiss(SESSION.hrB, opp, dismissBody({ expectedVersion: 2 }))
      expect(again).toMatchObject({ hidden: true, version: 3 })
    })

    it('the response to B carries nothing of A, and a foreign dismissal does not conflict', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared')
      await actions.dismiss(SESSION.hrA, opp, dismissBody())
      const b = await actions.dismiss(SESSION.hrB, opp, dismissBody())
      expect(JSON.stringify(b)).not.toContain(id('teamA'))
      expect(b.version).toBe(1)
    })

    it('B undoing with only A dismissal present is a 404, and A row stays', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared')
      await actions.dismiss(SESSION.hrA, opp, dismissBody())
      await expectNotFound(actions.undo(SESSION.hrB, opp, undoBody(1)))
      const [row] = await dismissals(opp)
      expect(row.undone_at).toBeNull()
    })

    it('a STUDIO dismissal is ADMIN-only', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await expectNotFound(actions.dismiss(SESSION.hrA, opp, dismissBody({ scope: 'STUDIO' })))
      expect(await dismissals(opp)).toHaveLength(0)
      const res = await actions.dismiss(SESSION.admin, opp, dismissBody({ scope: 'STUDIO' }))
      expect(res.scope).toBe('STUDIO')
      const [row] = await dismissals(opp)
      expect(row.scope_kind).toBe('STUDIO')
      expect(row.team_id).toBeNull()
    })

    it('a TEAM dismissal by a non-member, or of a hidden opportunity, is refused', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senB')
      await expectNotFound(actions.dismiss(SESSION.hrA, opp, dismissBody()))
      await expectNotFound(actions.dismiss(SESSION.hrA, opp, dismissBody({ teamId: id('teamB') })))
      expect(await dismissals(opp)).toHaveLength(0)
    })

    it('versions: a re-dismiss and an undo match the expected one; a retry is idempotent', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const body = dismissBody()
      const first = await actions.dismiss(SESSION.hrA, opp, body)
      expect(await actions.dismiss(SESSION.hrA, opp, body)).toEqual(first)
      await expectStale(actions.dismiss(SESSION.hrA, opp, dismissBody()))
      await expectStale(actions.undo(SESSION.hrA, opp, undoBody(9)))
      await actions.undo(SESSION.hrA, opp, undoBody(1))
      await expectStale(actions.undo(SESSION.hrA, opp, undoBody(1)))
      expect((await actionRows(opp)).map((r) => [r.kind, r.after_version])).toEqual([
        ['DISMISSED', 1],
        ['UNDONE', 2],
      ])
    })

    it('dismiss and undo racing: one version wins, the log agrees with the row', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      await actions.dismiss(SESSION.hrA, opp, dismissBody())
      const settled = await Promise.allSettled([
        actions.undo(SESSION.hrA, opp, undoBody(1)),
        actions.dismiss(SESSION.hrA, opp, dismissBody({ expectedVersion: 1 })),
      ])
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
      const [row] = await dismissals(opp)
      expect(row.version).toBe(2)
      expect(await actionRows(opp)).toHaveLength(2)
    })
  })

  describe('opened', () => {
    async function sourceRecord(opp: string): Promise<string> {
      const { rows } = await q(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2) RETURNING id`,
        [`${TAG}-ns`, randomUUID()],
      )
      const record = rows[0].id as string
      await q(
        `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
         VALUES ($1, $2, '1')`,
        [record, opp],
      )
      return record
    }

    it('two copies are two click signals; a repeat of one adds nothing', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const one = await sourceRecord(opp)
      const two = await sourceRecord(opp)
      await actions.opened(SESSION.hrA, opp, { sourceRecordId: one })
      await actions.opened(SESSION.hrA, opp, { sourceRecordId: one })
      await actions.opened(SESSION.hrA, opp, { sourceRecordId: two })
      const log = await actionRows(opp)
      expect(log.map((r) => r.kind)).toEqual(['OPENED', 'OPENED'])
      expect(log.every((r) => r.before_version === null && r.after_version === null)).toBe(true)
    })

    it('an actor the database no longer holds in that role is a 404, and logs nothing', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const record = await sourceRecord(opp)
      const stale = user(id('hrA'), 'ADMIN')
      await expectNotFound(actions.opened(stale, opp, { sourceRecordId: record }))
      expect(await actionRows(opp)).toHaveLength(0)
    })

    it('another team click is its own signal; another team opportunity is a 404', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senShared')
      const record = await sourceRecord(opp)
      await actions.opened(SESSION.hrA, opp, { sourceRecordId: record })
      await actions.opened(SESSION.hrB, opp, { sourceRecordId: record })
      expect(await actionRows(opp)).toHaveLength(2)
      const foreign = await mkOpp()
      await lead(foreign, 'senB')
      const foreignRecord = await sourceRecord(foreign)
      await expectNotFound(actions.opened(SESSION.hrA, foreign, { sourceRecordId: foreignRecord }))
    })

    it('a source record of another opportunity is a 404', async () => {
      const opp = await mkOpp()
      const other = await mkOpp()
      await lead(opp, 'senA')
      const record = await sourceRecord(other)
      await expectNotFound(actions.opened(SESSION.hrA, opp, { sourceRecordId: record }))
      expect(await actionRows(opp)).toHaveLength(0)
    })

    it('a source record that was unlinked from the opportunity is the same 404, and logs nothing', async () => {
      const opp = await mkOpp()
      await lead(opp, 'senA')
      const record = await sourceRecord(opp)
      await q(
        `UPDATE job_opportunity_sources SET unlinked_at = now(), unlink_reason = 'split'
          WHERE opportunity_id = $1 AND source_record_id = $2`,
        [opp, record],
      )
      const unlinked = await refusal(actions.opened(SESSION.hrA, opp, { sourceRecordId: record }))
      expect(unlinked.status).toBe(404)
      expect(JSON.parse(unlinked.raw)).toMatchObject({
        statusCode: 404,
        code: 'JOB_OPPORTUNITY_NOT_FOUND',
      })
      const missing = await refusal(
        actions.opened(SESSION.hrA, opp, { sourceRecordId: randomUUID() }),
      )
      expect(unlinked.raw).toBe(missing.raw)
      expect(await actionRows(opp)).toHaveLength(0)
    })
  })

  describe('suppress', () => {
    it('an ADMIN records it with no version; a retry adds nothing; an HR is refused', async () => {
      const opp = await mkOpp()
      const body = { idempotencyKey: randomUUID() }
      await actions.suppress(SESSION.admin, opp, body)
      await actions.suppress(SESSION.admin, opp, body)
      const log = await actionRows(opp)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({
        kind: 'SUPPRESSED',
        actor_id: id('admin'),
        team_id: null,
        before_version: null,
        after_version: null,
      })
      const r = await refusal(actions.suppress(SESSION.hrA, opp, { idempotencyKey: randomUUID() }))
      expect(r.status).toBe(403)
      expect(await actionRows(opp)).toHaveLength(1)
    })
  })
})
