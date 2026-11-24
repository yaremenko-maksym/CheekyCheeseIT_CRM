import { randomUUID } from 'node:crypto'
import { HttpException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { type JobQueueListQuery, jobQueueListQuerySchema, type SessionUser } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Env } from '../../config/env'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { authorizeSenior } from '../../tailored-resumes/tailored-access'
import {
  loadRoster,
  MATCH_RULE_VERSION,
  opportunityInputsVersion,
  type SeniorVersions,
} from '../runtime/recompute-inputs'
import { JobQueueService } from './job-queue.service'
import { JobQueueActionsService } from './queue-actions.service'
import { NONE_SCOPE } from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * task-hr-queue-all-teams — the HR queue against a real Postgres, as the API role (`crm_app`).
 *
 * Step 1 (the "0 vacancies" report) — a mechanism proven locally, NOT confirmed on prod (the task
 * file's Diagnosis holds the prod SELECT): a senior who joined a DROP-type team (`JOIN_DROP_TEAM`)
 * is in the matching roster (`loadRoster` counts any active membership), so ADMIN's STUDIO list
 * filtered by that senior shows their LEAD. Owner decision 2026-11-24 (reversing Q1 Option B): a
 * live team of either type is a queue scope, so a drop team's HR sees, submits and triages for its
 * active SENIOR member, a DROP-only HR gets a queue, and an HR's union includes their drop team. A
 * foreign drop team, an archived one and a left membership still grant nothing.
 */
const TAG = `qhrt${randomUUID().slice(0, 8)}`
const SECRET = 'integration-secret-integration-secret'
const ACTION_TRIGGERS = [
  'trg_job_queue_actions_append_only',
  'trg_job_queue_actions_no_truncate',
] as const
const config = { get: () => SECRET } as unknown as ConfigService<Env, true>

const ids: Record<string, string> = {}
const id = (key: string) => ids[key] as string
const asUser = (key: string, role: SessionUser['role']): SessionUser =>
  ({ id: id(key), role, email: `${key}@example.test` }) as SessionUser
const q = (over: Record<string, unknown> = {}): JobQueueListQuery =>
  jobQueueListQuerySchema.parse({ search: TAG, limit: 50, ...over })

let session: CrmAppSession
let service: JobQueueService
let actions: JobQueueActionsService
let live: ReadonlyMap<string, SeniorVersions>
let seq = 0

const sqlq = (text: string, params: unknown[] = []) => session.admin.query(text, params)

async function mkUser(key: string, role: SessionUser['role']) {
  const { rows } = await sqlq(
    `INSERT INTO users (email, display_name, role, tech_stack) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${TAG}-${key}@example.test`, `${TAG} name ${key}`, role, ['Go']],
  )
  ids[key] = rows[0].id as string
}
/** Created one second apart, so the HR's team order (`created_at`, then id) is the creation order. */
async function mkTeam(key: string, type: 'SENIOR' | 'DROP' = 'SENIOR', archived = false) {
  seq += 1
  const { rows } = await sqlq(
    `INSERT INTO teams (name, type, created_at, archived_at)
     VALUES ($1, $2, now() - interval '1 hour' + make_interval(secs => $3),
             CASE WHEN $4 THEN now() END) RETURNING id`,
    [`${TAG}-${key}`, type, seq, archived],
  )
  ids[key] = rows[0].id as string
}
const join = (team: string, member: string) =>
  sqlq(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [id(team), id(member)])

async function mkOpp(key: string) {
  const { rows } = await sqlq(
    `INSERT INTO job_opportunities
       (title, title_key, revision, availability, first_seen_at, technical_roles, role_status)
     VALUES ($1, $2, 1, 'OPEN', now(), ARRAY['BACKEND_ENGINEER'], 'RULE') RETURNING id`,
    [`${TAG} ${key}`, `${TAG}-${key}`],
  )
  ids[key] = rows[0].id as string
  seq += 1
  const record = await sqlq(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
    [`${TAG}-ns`, `${TAG}-k${seq}`, `https://jobs.example.test/${TAG}/${seq}`],
  )
  await sqlq(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
     VALUES ($1, $2, 'r1')`,
    [record.rows[0].id, id(key)],
  )
}
/** A live LEAD: what the recompute worker would stamp for this senior right now. */
function lead(opp: string, senior: string, score = 50) {
  const v = live.get(id(senior)) as SeniorVersions
  return sqlq(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
        exclusion_version, rule_version, outcome, evidence)
     SELECT $1::uuid, $2::uuid, o.revision, $3, $4, $5, 'LEAD', $6::jsonb
       FROM job_opportunities o WHERE o.id = $1::uuid`,
    [
      id(opp),
      id(senior),
      v.profile,
      v.exclusion,
      MATCH_RULE_VERSION,
      JSON.stringify({
        score,
        reasons: [{ code: 'TECH_MATCH', evidence: ['Go:CORE'], ruleVersion: 'r' }],
        rankWarnings: [],
      }),
    ],
  )
}

const listed = async (user: SessionUser, over: Record<string, unknown> = {}) =>
  (await service.list(user, q({ tab: 'NEW', ...over }))).items.map((i) => i.opportunityId)

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  const e: unknown = await p.then(
    () => new Error('expected a refusal'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  const http = e as HttpException
  return { status: http.getStatus(), code: (http.getResponse() as { code: string }).code }
}
const NOT_FOUND = { status: 404, code: 'JOB_OPPORTUNITY_NOT_FOUND' }
const REFRESH = { status: 409, code: 'JOB_QUEUE_REFRESH_REQUIRED' }
const hr = () => asUser('hr', 'HR')
const admin = () => asUser('admin', 'ADMIN')

describe.skipIf(!hasDatabaseUrl())('HR job queue across teams (task-hr-queue-all-teams)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await sqlq(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    service = new JobQueueService(session.databaseService, new JobQueueScopeService(), config)
    actions = new JobQueueActionsService(session.databaseService, new JobQueueScopeService())

    await mkUser('admin', 'ADMIN')
    await mkUser('hrDrop', 'HR')
    await mkUser('drop', 'DROP')
    await mkUser('senDrop', 'SENIOR')
    // The union: `hr` is in teamA, teamB and the senior-less teamE (in that order); teamC is foreign.
    for (const u of ['hr', 'hrC']) await mkUser(u, 'HR')
    for (const u of ['senA', 'senB', 'senC']) await mkUser(u, 'SENIOR')
    for (const t of ['teamA', 'teamB', 'teamE', 'teamC']) await mkTeam(t)
    for (const [t, m] of [
      ['teamA', 'hr'],
      ['teamA', 'senA'],
      ['teamB', 'hr'],
      ['teamB', 'senB'],
      ['teamE', 'hr'],
      ['teamC', 'hrC'],
      ['teamC', 'senC'],
    ] as const)
      await join(t, m)
    // The drop-team shape `createDropTeam` + `addSeniorToDropTeam` build: drop, HR, one senior.
    // `hrMix` is in teamA and the drop team, so their union holds a team of each type. `senLeft`
    // left the drop team; teamDropY is a foreign drop team; teamDropGone an archived one.
    for (const u of ['hrMix', 'hrDropY', 'hrGone']) await mkUser(u, 'HR')
    await mkUser('dropY', 'DROP')
    for (const u of ['senLeft', 'senDropY', 'senGone']) await mkUser(u, 'SENIOR')
    await mkTeam('teamDrop', 'DROP')
    for (const m of ['drop', 'hrDrop', 'senDrop', 'hrMix', 'senLeft']) await join('teamDrop', m)
    await join('teamA', 'hrMix')
    await sqlq(`UPDATE team_members SET left_at = now() WHERE team_id = $1 AND user_id = $2`, [
      id('teamDrop'),
      id('senLeft'),
    ])
    await mkTeam('teamDropY', 'DROP')
    for (const m of ['dropY', 'hrDropY', 'senDropY']) await join('teamDropY', m)
    await mkTeam('teamDropGone', 'DROP', true)
    for (const m of ['hrGone', 'senGone']) await join('teamDropGone', m)
    const roster = await loadRoster(session.databaseService.db)
    live = roster.versions

    await mkOpp('oppDrop')
    await lead('oppDrop', 'senDrop')
    await mkOpp('oppDropY')
    await lead('oppDropY', 'senDropY')
    await mkOpp('oppGone')
    await lead('oppGone', 'senGone')
    // No LEAD anywhere: a triage item, visible to a team only through an ADMIN grant.
    await mkOpp('oppTriage')
    // A grant shows only an opportunity evaluated OPEN at the live inputs (the GRANT branch).
    await sqlq(
      `UPDATE job_opportunities
          SET evaluated_revision = 1, evaluation_verdict = 'OPEN', evaluated_inputs_version = $2
        WHERE id = $1`,
      [id('oppTriage'), opportunityInputsVersion(roster.exclusions)],
    )
    for (const o of ['oppA', 'oppB', 'oppC', 'oppAB']) await mkOpp(o)
    await lead('oppA', 'senA', 70)
    await lead('oppB', 'senB', 50)
    await lead('oppC', 'senC', 90)
    await lead('oppAB', 'senA', 40)
    await lead('oppAB', 'senB', 60)
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      const teams = `SELECT id FROM teams WHERE name LIKE $1`
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE status <> 'INVALIDATED' AND team_id IN (${teams})`,
        [`${TAG}%`],
      )
      await sqlq(`DELETE FROM job_queue_generations WHERE team_id IN (${teams})`, [`${TAG}%`])
      // Only one STUDIO generation may be PUBLISHED in the database: leave none behind.
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE scope_kind = 'STUDIO' AND status = 'PUBLISHED'`,
      )
      await sqlq(
        `DELETE FROM job_queue_generations WHERE scope_kind = 'STUDIO' AND status = 'INVALIDATED'`,
      )
      const opps = `SELECT id FROM job_opportunities WHERE title LIKE $1`
      // An append-only table is cleaned only by its owner, with its triggers off (as in
      // queue-actions.integration.spec.ts).
      for (const name of ACTION_TRIGGERS)
        await sqlq(`ALTER TABLE job_queue_actions DISABLE TRIGGER ${name}`)
      try {
        for (const table of [
          'job_queue_actions',
          'job_queue_assignments',
          'job_queue_dismissals',
          'job_opportunity_team_triage',
        ])
          await sqlq(`DELETE FROM ${table} WHERE opportunity_id IN (${opps})`, [`${TAG}%`])
      } finally {
        for (const name of ACTION_TRIGGERS)
          await sqlq(`ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER ${name}`)
      }
      await sqlq(`DELETE FROM job_opportunity_sources WHERE opportunity_id IN (${opps})`, [
        `${TAG}%`,
      ])
      await sqlq(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_source_records WHERE namespace = $1`, [`${TAG}-ns`])
      await sqlq(`DELETE FROM team_members WHERE team_id IN (${teams})`, [`${TAG}%`])
      await sqlq(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
      await sqlq(
        `DELETE FROM senior_resumes WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
        [`${TAG}%`],
      )
      await sqlq(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    } finally {
      await session.close()
    }
  })

  describe('Step 1 — a drop-team senior', () => {
    it('ADMIN STUDIO filtered by the senior lists their LEAD (the owner’s control view)', async () => {
      expect(await listed(asUser('admin', 'ADMIN'), { seniorIds: id('senDrop') })).toContain(
        id('oppDrop'),
      )
    })

    it('a DROP-only HR gets their drop team as a scope: list, card and its one active senior', async () => {
      const hrDrop = asUser('hrDrop', 'HR')
      const db = session.databaseService.db
      // the DROP owner and the senior who left are not the team's seniors
      expect(await new JobQueueScopeService().resolveView(hrDrop, undefined, db)).toMatchObject({
        kind: 'TEAM',
        teamId: id('teamDrop'),
        seniorIds: [id('senDrop')],
      })
      expect(await listed(hrDrop)).toEqual([id('oppDrop')])
      expect(await listed(hrDrop, { teamId: id('teamDrop') })).toEqual([id('oppDrop')])
      expect((await service.card(hrDrop, id('oppDrop'))).opportunityId).toBe(id('oppDrop'))
      const { items } = await service.seniorOptions(hrDrop, {})
      expect(items.map((i) => [i.id, i.teamName])).toEqual([[id('senDrop'), `${TAG}-teamDrop`]])
    })

    it('the HR of the drop team submits for its senior; cancel finds it again', async () => {
      const hrDrop = asUser('hrDrop', 'HR')
      const res = await actions.submit(hrDrop, id('oppDrop'), {
        seniorId: id('senDrop'),
        idempotencyKey: randomUUID(),
        expectedOpportunityRevision: (await service.card(hrDrop, id('oppDrop'))).revision,
        confirmPossibleDuplicate: false,
      })
      expect(await listed(hrDrop, { tab: 'SUBMITTED' })).toEqual([id('oppDrop')])
      await actions.cancelSubmission(hrDrop, id('oppDrop'), res.submission.id, {
        idempotencyKey: randomUUID(),
        expectedVersion: res.submission.version,
      })
      expect(await listed(hrDrop)).toEqual([id('oppDrop')])
    })

    it('an HR in a SENIOR and a DROP team reads the union of both', async () => {
      const hrMix = asUser('hrMix', 'HR')
      expect([...(await listed(hrMix))].sort()).toEqual(
        [id('oppA'), id('oppAB'), id('oppDrop')].sort(),
      )
      expect(await listed(hrMix, { teamId: id('teamDrop') })).toEqual([id('oppDrop')])
      expect(await listed(hrMix, { seniorIds: id('senDrop') })).toEqual([id('oppDrop')])
      const { items } = await service.seniorOptions(hrMix, {})
      expect(items.map((i) => [i.id, i.teamName])).toEqual(
        expect.arrayContaining([
          [id('senA'), `${TAG}-teamA`],
          [id('senDrop'), `${TAG}-teamDrop`],
        ]),
      )
      expect(items).toHaveLength(2)
      const db = session.databaseService.db
      expect(
        await authorizeSenior(
          new JobQueueScopeService(),
          hrMix,
          id('oppDrop'),
          id('senDrop'),
          undefined,
          db,
        ),
      ).toMatchObject({ kind: 'TEAM', teamId: id('teamDrop') })
    })

    it('ADMIN names the drop team as a scope', async () => {
      expect(await listed(admin(), { teamId: id('teamDrop') })).toEqual([id('oppDrop')])
    })

    it('a foreign drop team is the same empty list / 404 as any foreign team', async () => {
      const hrDrop = asUser('hrDrop', 'HR')
      const submit = (user: SessionUser, opp: string, senior: string) =>
        refusal(
          actions.submit(user, id(opp), {
            seniorId: id(senior),
            idempotencyKey: randomUUID(),
            expectedOpportunityRevision: 1,
            confirmPossibleDuplicate: false,
          }),
        )
      expect(await listed(hrDrop)).not.toContain(id('oppDropY'))
      expect(await listed(hrDrop, { teamId: id('teamDropY') })).toEqual([])
      expect(await listed(hrDrop, { seniorIds: id('senDropY') })).toEqual([])
      expect(await refusal(service.card(hrDrop, id('oppDropY')))).toEqual(NOT_FOUND)
      expect(await submit(hrDrop, 'oppDropY', 'senDropY')).toEqual(NOT_FOUND)
      // a foreign drop team's senior on an own card is not eligible either
      expect(await submit(hrDrop, 'oppDrop', 'senDropY')).toEqual(NOT_FOUND)
      // …and a SENIOR-team HR sees no drop team's data, nor its HR any SENIOR team's
      expect(await listed(hr())).not.toContain(id('oppDrop'))
      expect(await refusal(service.card(hr(), id('oppDrop')))).toEqual(NOT_FOUND)
      expect(await submit(hr(), 'oppDrop', 'senDrop')).toEqual(NOT_FOUND)
      expect(await refusal(service.card(hrDrop, id('oppA')))).toEqual(NOT_FOUND)
      expect(await listed(hrDrop, { seniorIds: id('senA') })).toEqual([])
    })

    it('an archived drop team, a left membership and the DROP owner grant nothing', async () => {
      const hrGone = asUser('hrGone', 'HR')
      const db = session.databaseService.db
      await expect(new JobQueueScopeService().resolveView(hrGone, undefined, db)).resolves.toEqual(
        NONE_SCOPE,
      )
      expect(await listed(hrGone)).toEqual([])
      expect(await listed(admin(), { teamId: id('teamDropGone') })).toEqual([])
      for (const senior of ['senLeft', 'drop'])
        expect(
          await refusal(
            actions.submit(asUser('hrDrop', 'HR'), id('oppDrop'), {
              seniorId: id(senior),
              idempotencyKey: randomUUID(),
              expectedOpportunityRevision: 1,
              confirmPossibleDuplicate: false,
            }),
          ),
        ).toEqual(NOT_FOUND)
    })

    it('ADMIN grants a triage item to the drop team, never to an archived one', async () => {
      const card = await service.card(admin(), id('oppTriage'))
      const grant = (team: string) =>
        actions.grantTeamTriage(admin(), id('oppTriage'), {
          teamId: id(team),
          expectedOpportunityRevision: card.revision,
          policyVersion: card.triagePolicyVersion as number,
          reason: 'Drop team triage check',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          idempotencyKey: randomUUID(),
        })
      expect(await refusal(grant('teamDropGone'))).toEqual({
        status: 422,
        code: 'JOB_TRIAGE_ASSIGNMENT_NOT_ALLOWED',
      })
      await grant('teamDrop')
      expect(await listed(asUser('hrDrop', 'HR'))).toContain(id('oppTriage'))
      expect(await listed(asUser('hrDropY', 'HR'))).not.toContain(id('oppTriage'))
      expect(await refusal(service.card(hr(), id('oppTriage')))).toEqual(NOT_FOUND)
    })
  })

  describe('the union of the HR’s teams (AC 1, 2, 4)', () => {
    const own = () => [id('oppA'), id('oppB'), id('oppAB')]

    it('ADMIN STUDIO is unchanged: every team’s opportunity, a foreign one included', async () => {
      // Listed first, so a PUBLISHED STUDIO generation exists for the union to (not) pick up.
      expect(await listed(admin())).toEqual(expect.arrayContaining([...own(), id('oppC')]))
    })

    it('lists every own team’s opportunity exactly once, never a foreign team’s', async () => {
      const items = await listed(hr())
      expect([...items].sort()).toEqual([...own()].sort())
      const { counts } = await service.list(hr(), q({ tab: 'NEW' }))
      expect(counts).toEqual({ NEW: 3, SUBMITTED: 0, HIDDEN: 0 })
    })

    it('orders the union by the best member rank: oppA (70), oppAB (60), oppB (50)', async () => {
      expect(await listed(hr())).toEqual([id('oppA'), id('oppAB'), id('oppB')])
    })

    it('a named own team narrows the list to that team', async () => {
      expect(await listed(hr(), { teamId: id('teamB') })).toEqual([id('oppAB'), id('oppB')])
    })

    it('a foreign team, or only a foreign senior in the filter, is empty', async () => {
      expect(await listed(hr(), { teamId: id('teamC') })).toEqual([])
      expect(await listed(hr(), { seniorIds: id('senC') })).toEqual([])
      expect(await listed(hr(), { seniorIds: id('senB') })).toEqual([id('oppAB'), id('oppB')])
    })

    it('pages the union with a cursor, each item once', async () => {
      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 4; page += 1) {
        const res = await service.list(hr(), q({ tab: 'NEW', limit: 1, cursor }))
        seen.push(...res.items.map((i) => i.opportunityId))
        if (res.nextCursor === null) break
        cursor = res.nextCursor
      }
      expect(seen).toEqual([id('oppA'), id('oppAB'), id('oppB')])
    })

    it('a cursor is refresh-required once a member team’s generation is replaced', async () => {
      const first = await service.list(hr(), q({ tab: 'NEW', limit: 1 }))
      expect(first.nextCursor).not.toBeNull()
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE status = 'PUBLISHED' AND team_id = $1`,
        [id('teamB')],
      )
      expect(
        await refusal(
          service.list(hr(), q({ tab: 'NEW', limit: 1, cursor: first.nextCursor as string })),
        ),
      ).toEqual(REFRESH)
    })

    it('opens a card of any own team without naming it; a foreign card is the same 404', async () => {
      for (const o of ['oppA', 'oppB', 'oppAB'])
        await expect(service.card(hr(), id(o))).resolves.toMatchObject({ opportunityId: id(o) })
      expect(await refusal(service.card(hr(), id('oppC')))).toEqual(NOT_FOUND)
      expect(await refusal(service.sources(hr(), id('oppC'), {}))).toEqual(NOT_FOUND)
      expect(await refusal(service.seniors(hr(), id('oppC'), {}))).toEqual(NOT_FOUND)
    })

    it('the card lists the matched seniors of every own team, never a foreign one', async () => {
      const card = await service.card(hr(), id('oppAB'))
      expect(card.seniors.items.map((s) => s.seniorId).sort()).toEqual(
        [id('senA'), id('senB')].sort(),
      )
    })

    it('the picker offers only the HR’s seniors, each under their own team', async () => {
      const { items } = await service.seniorOptions(hr(), {})
      expect(items).toEqual([
        { id: id('senA'), name: `${TAG} name senA`, teamName: `${TAG}-teamA`, technicalRoles: [] },
        { id: id('senB'), name: `${TAG} name senB`, teamName: `${TAG}-teamB`, technicalRoles: [] },
      ])
    })
  })

  describe('writes from the union name one team (AC 5)', () => {
    const key = () => randomUUID()
    const revisionOf = async (opp: string) => (await service.card(hr(), id(opp))).revision

    it('dismiss hides the item for the first own team that sees it; undo restores it', async () => {
      await actions.dismiss(hr(), id('oppAB'), {
        scope: 'TEAM',
        reason: 'NOT_RELEVANT',
        idempotencyKey: key(),
      })
      expect(await listed(hr(), { tab: 'HIDDEN' })).toEqual([id('oppAB')])
      expect(await listed(hr(), { teamId: id('teamA'), tab: 'HIDDEN' })).toEqual([id('oppAB')])
      expect(await listed(hr(), { teamId: id('teamB') })).toContain(id('oppAB'))

      const { dismissal } = await service.card(hr(), id('oppAB'))
      expect(dismissal).toMatchObject({ scope: 'TEAM' })
      await actions.undo(hr(), id('oppAB'), {
        scope: 'TEAM',
        idempotencyKey: key(),
        expectedVersion: dismissal?.version as number,
      })
      expect(await listed(hr())).toContain(id('oppAB'))
      expect(await listed(hr(), { teamId: id('teamA') })).toContain(id('oppAB'))
    })

    it('opened is logged for the team that sees the item', async () => {
      const card = await service.card(hr(), id('oppB'))
      await actions.opened(hr(), id('oppB'), {
        sourceRecordId: card.primarySource?.sourceRecordId as string,
      })
      expect(await listed(hr(), { teamId: id('teamB'), activity: 'OPENED' })).toEqual([id('oppB')])
      expect(await listed(hr(), { activity: 'OPENED' })).toEqual([id('oppB')])
    })

    it('submit names the senior’s own team; cancel finds it again', async () => {
      const res = await actions.submit(hr(), id('oppAB'), {
        seniorId: id('senB'),
        idempotencyKey: key(),
        expectedOpportunityRevision: await revisionOf('oppAB'),
        confirmPossibleDuplicate: false,
      })
      expect(await listed(hr(), { teamId: id('teamB'), tab: 'SUBMITTED' })).toEqual([id('oppAB')])
      expect(await listed(hr(), { teamId: id('teamA') })).toContain(id('oppAB'))
      await actions.cancelSubmission(hr(), id('oppAB'), res.submission.id, {
        idempotencyKey: key(),
        expectedVersion: res.submission.version,
      })
      expect(await listed(hr(), { teamId: id('teamB') })).toContain(id('oppAB'))
    })

    it('a foreign opportunity or a foreign senior is the same 404 from the union', async () => {
      expect(
        await refusal(
          actions.dismiss(hr(), id('oppC'), {
            scope: 'TEAM',
            reason: 'SPAM',
            idempotencyKey: key(),
          }),
        ),
      ).toEqual(NOT_FOUND)
      for (const [opp, senior] of [
        ['oppC', 'senC'],
        ['oppAB', 'senC'],
      ] as const)
        expect(
          await refusal(
            actions.submit(hr(), id(opp), {
              seniorId: id(senior),
              idempotencyKey: key(),
              expectedOpportunityRevision: 1,
              confirmPossibleDuplicate: false,
            }),
          ),
        ).toEqual(NOT_FOUND)
    })

    it('cancelling another team’s submission is the same 404 and leaves it untouched', async () => {
      const hrC = asUser('hrC', 'HR')
      const res = await actions.submit(hrC, id('oppC'), {
        seniorId: id('senC'),
        idempotencyKey: key(),
        expectedOpportunityRevision: (await service.card(hrC, id('oppC'))).revision,
        confirmPossibleDuplicate: false,
      })
      const state = async () => ({
        row: (
          await sqlq(`SELECT to_jsonb(a) AS r FROM job_queue_assignments a WHERE a.id = $1`, [
            res.submission.id,
          ])
        ).rows,
        actions: (
          await sqlq(`SELECT count(*)::int AS n FROM job_queue_actions WHERE opportunity_id = $1`, [
            id('oppC'),
          ])
        ).rows[0].n as number,
      })
      const before = await state()
      expect(before.row).toHaveLength(1)
      // from the union, naming the submission's (foreign) team, and naming an own team
      for (const team of [undefined, 'teamC', 'teamA'])
        expect(
          await refusal(
            actions.cancelSubmission(hr(), id('oppC'), res.submission.id, {
              idempotencyKey: key(),
              expectedVersion: res.submission.version,
              ...(team === undefined ? {} : { teamId: id(team) }),
            }),
          ),
        ).toEqual(NOT_FOUND)
      expect(await state()).toEqual(before)
    })

    it('an external submission for the own drop team’s senior is created; a foreign drop team’s is the same 404', async () => {
      const resume = async (senior: string) =>
        (await sqlq(`INSERT INTO senior_resumes (user_id) VALUES ($1) RETURNING id`, [id(senior)]))
          .rows[0].id as string
      const card = (title: string, team: string, senior: string, resumeId: string) => ({
        title,
        companyName: `${TAG} Co`,
        descriptionMd: 'A vacancy found outside the sources.',
        idempotencyKey: key(),
        submission: { teamId: id(team), seniorId: id(senior), resumeId },
        confirmPossibleDuplicate: false,
      })
      const count = async (title: string) =>
        (await sqlq(`SELECT count(*)::int AS n FROM job_opportunities WHERE title = $1`, [title]))
          .rows[0].n as number
      const hrDrop = asUser('hrDrop', 'HR')
      const own = `${TAG} manual drop card`
      const res = await actions.createManualCard(
        hrDrop,
        card(own, 'teamDrop', 'senDrop', await resume('senDrop')),
      )
      expect(res.submission.seniorId).toBe(id('senDrop'))
      expect(await count(own)).toBe(1)
      const foreign = `${TAG} manual foreign drop card`
      const foreignResume = await resume('senDropY')
      for (const [user, team] of [
        [hrDrop, 'teamDropY'],
        [hr(), 'teamDropY'],
      ] as const)
        expect(
          await refusal(
            actions.createManualCard(user, card(foreign, team, 'senDropY', foreignResume)),
          ),
        ).toEqual(NOT_FOUND)
      expect(await count(foreign)).toBe(0)
    })

    it('a tailored resume names the team of the asked senior; a foreign one is the same 404', async () => {
      const db = session.databaseService.db
      const scopes = new JobQueueScopeService()
      const teamOf = async (opp: string, senior: string) =>
        authorizeSenior(scopes, hr(), id(opp), id(senior), undefined, db)
      expect(await teamOf('oppAB', 'senB')).toMatchObject({ kind: 'TEAM', teamId: id('teamB') })
      expect(await teamOf('oppAB', 'senA')).toMatchObject({ kind: 'TEAM', teamId: id('teamA') })
      for (const [opp, senior] of [
        ['oppB', 'senA'],
        ['oppAB', 'senC'],
        ['oppC', 'senC'],
      ] as const)
        expect(await refusal(teamOf(opp, senior))).toEqual(NOT_FOUND)
    })
  })
})
