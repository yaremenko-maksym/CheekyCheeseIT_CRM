import { randomUUID } from 'node:crypto'
import { ForbiddenException, HttpException } from '@nestjs/common'
import type { JobExclusionDto, SessionUser } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { Evaluated, Excluded } from '../funnel/evaluate'
import type { RoleFamily } from '../funnel/layer1'
import {
  installMatches,
  loadRoster,
  MATCH_RULE_VERSION,
  opportunityInputsVersion,
  type RosterInputs,
  type SeniorVersions,
} from '../runtime/recompute-inputs'
import { type JobQueueScope, NONE_SCOPE, STUDIO_SCOPE } from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * r5 Task 6.1 — queue visibility against a real Postgres, as the API role (`crm_app`). A mocked
 * E2E cannot prove a backend scope (the #110/#157 lesson). Fixtures are written directly (users,
 * teams, opportunities, per-senior matches, triage grants). Match rows carry the LIVE versions
 * the recompute worker would stamp (`loadRoster` / `rosterVersions`, `MATCH_RULE_VERSION`), so a
 * visible row is visible for the right reason, and each stale variant differs in exactly one
 * version — the matrix fails if the staleness gap (PANEL-DS-1) returns.
 */
const TAG = randomUUID().slice(0, 8)
const user = (id: string, role: SessionUser['role']): SessionUser =>
  ({ id, role, email: `${id}@example.test` }) as SessionUser

async function expectNotFound(p: Promise<unknown>): Promise<void> {
  const e: unknown = await p.then(
    () => new Error('expected JOB_OPPORTUNITY_NOT_FOUND, got a result'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  expect((e as HttpException).getStatus()).toBe(404)
  expect(((e as HttpException).getResponse() as { code: string }).code).toBe(
    'JOB_OPPORTUNITY_NOT_FOUND',
  )
}

interface MatchOpts {
  revision?: number
  profile?: string
  exclusion?: string
  rule?: string
  evidence?: Record<string, unknown>
}

let session: CrmAppSession
let service: {
  resolve(user: SessionUser, teamId?: string): Promise<JobQueueScope>
  assertVisible(scope: JobQueueScope, opportunityId: string): Promise<void>
}
let live: ReadonlyMap<string, SeniorVersions>
/** The studio-wide exclusions at setup: what the live inputs version is computed from. */
let studio: readonly JobExclusionDto[] = []
const ids: Record<string, string> = {}
const userIds: string[] = []
const teamIds: string[] = []
const oppIds: string[] = []
const recordIds: string[] = []

describe.skipIf(!hasDatabaseUrl())('JobQueueScopeService against Postgres (Task 6.1)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 2 })
    const probe = await session.admin.query(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    const real = new JobQueueScopeService()
    service = {
      resolve: (u, teamId) => real.resolve(u, teamId, session.databaseService.db),
      assertVisible: (scope, id) => real.assertVisible(scope, id, session.databaseService.db),
    }
    const q = (text: string, params: unknown[]) => session.admin.query(text, params)

    const mkUser = async (key: string, role: SessionUser['role'], archived = false) => {
      const { rows } = await q(
        `INSERT INTO users (email, display_name, role, tech_stack, archived_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          `qscope-${key}-${TAG}@example.test`,
          `qscope ${key}`,
          role,
          ['Go'],
          archived ? new Date() : null,
        ],
      )
      ids[key] = rows[0].id as string
      userIds.push(ids[key])
    }
    const mkTeam = async (key: string, createdAt: string, type = 'SENIOR', archived = false) => {
      const { rows } = await q(
        `INSERT INTO teams (name, type, created_at, archived_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`qscope-${key}-${TAG}`, type, createdAt, archived ? new Date() : null],
      )
      ids[key] = rows[0].id as string
      teamIds.push(ids[key])
    }
    const join = (team: string, member: string, left = false) =>
      q(`INSERT INTO team_members (team_id, user_id, left_at) VALUES ($1, $2, $3)`, [
        ids[team],
        ids[member],
        left ? new Date() : null,
      ])
    const mkOpp = async (key: string, revision = 1, availability = 'OPEN') => {
      const { rows } = await q(
        `INSERT INTO job_opportunities (title, title_key, revision, availability)
         VALUES ($1, $1, $2, $3) RETURNING id`,
        [`qscope ${key} ${TAG}`, revision, availability],
      )
      ids[key] = rows[0].id as string
      oppIds.push(ids[key])
    }
    const match = (opp: string, senior: string, outcome: string, o: MatchOpts = {}) => {
      // A senior outside the live roster (archived / left) has no live version: stamp a dummy.
      const v = live.get(ids[senior] as string) ?? { profile: 'none', exclusion: 'none' }
      return q(
        `INSERT INTO job_opportunity_matches
           (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
            exclusion_version, rule_version, outcome, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ids[opp],
          ids[senior],
          o.revision ?? 1,
          o.profile ?? v.profile,
          o.exclusion ?? v.exclusion,
          o.rule ?? MATCH_RULE_VERSION,
          outcome,
          JSON.stringify(o.evidence ?? {}),
        ],
      )
    }
    const grant = (opp: string, team: string, expires: string, revoked = false) =>
      q(
        `INSERT INTO job_opportunity_team_triage
           (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision,
            expires_at, revoked_at)
         VALUES ($1, $2, $3, 1, 1, now() + $4::interval, $5)`,
        [ids[opp], ids[team], ids['admin'], expires, revoked ? new Date() : null],
      )
    /** What `installMatches` records, stamped directly; the writer itself is in the SR-M-2 cases. */
    const evaluated = (opp: string, revision: number, verdict: 'OPEN' | 'EXCLUDED') =>
      q(
        `UPDATE job_opportunities
            SET evaluated_revision = $2, evaluation_verdict = $3, evaluated_inputs_version = $4
          WHERE id = $1`,
        [ids[opp], revision, verdict, opportunityInputsVersion(studio)],
      )

    await mkUser('admin', 'ADMIN')
    for (const hr of ['hrA', 'hrB', 'hrNone', 'hrMulti', 'hrGone']) await mkUser(hr, 'HR')
    for (const s of ['senA', 'senB', 'senLeft', 'senLive', 'senGone']) await mkUser(s, 'SENIOR')
    await mkUser('senArchived', 'SENIOR', true)
    await mkUser('junA', 'JUNIOR')

    await mkTeam('teamA', '2020-01-01T00:00:00Z')
    await mkTeam('teamB', '2020-01-02T00:00:00Z')
    await mkTeam('teamGone', '2020-01-03T00:00:00Z')
    // Older than A, but archived / DROP-type: never a queue scope, never the default.
    await mkTeam('teamArchived', '2019-01-01T00:00:00Z', 'SENIOR', true)
    await mkTeam('teamDrop', '2019-01-02T00:00:00Z', 'DROP')

    for (const m of ['hrA', 'senA', 'senArchived', 'senLive', 'junA']) await join('teamA', m)
    await join('teamA', 'senLeft', true)
    for (const m of ['hrB', 'senB']) await join('teamB', m)
    for (const m of ['hrGone', 'senGone']) await join('teamGone', m)
    for (const t of ['teamB', 'teamA', 'teamArchived', 'teamDrop']) await join(t, 'hrMulti')
    // hrNone: a membership that was left, and one in an archived team — no active team.
    await join('teamB', 'hrNone', true)
    await join('teamArchived', 'hrNone')

    // The live versions, after the roster is final, from the same helper the worker uses.
    const roster = await loadRoster(session.databaseService.db)
    live = roster.versions
    studio = roster.exclusions.filter((e) => e.seniorId === null)

    await mkOpp('oppA')
    await match('oppA', 'senA', 'LEAD')
    await mkOpp('oppB')
    await match('oppB', 'senB', 'LEAD')
    await mkOpp('oppStaleRevision', 2)
    await match('oppStaleRevision', 'senA', 'LEAD', { revision: 1 })
    await mkOpp('oppStaleProfile')
    await match('oppStaleProfile', 'senA', 'LEAD', { profile: 'stale-profile' })
    await mkOpp('oppStaleExclusion')
    await match('oppStaleExclusion', 'senA', 'LEAD', { exclusion: 'stale-exclusion' })
    await mkOpp('oppStaleRule')
    await match('oppStaleRule', 'senA', 'LEAD', { rule: 'eval.0+l1.0' })
    await mkOpp('oppTriage')
    await match('oppTriage', 'senA', 'TRIAGE')
    await mkOpp('oppExcluded')
    await match('oppExcluded', 'senA', 'EXCLUDED')
    await mkOpp('oppArchivedSenior')
    await match('oppArchivedSenior', 'senArchived', 'LEAD')
    await mkOpp('oppLeftSenior')
    await match('oppLeftSenior', 'senLeft', 'LEAD')
    await mkOpp('oppGrant')
    await grant('oppGrant', 'teamA', '1 day')
    await evaluated('oppGrant', 1, 'OPEN')
    await mkOpp('oppGrantExpired')
    await grant('oppGrantExpired', 'teamA', '-1 minute')
    await evaluated('oppGrantExpired', 1, 'OPEN')
    await mkOpp('oppGrantRevoked')
    await grant('oppGrantRevoked', 'teamA', '1 day', true)
    await evaluated('oppGrantRevoked', 1, 'OPEN')
    // Evaluated OPEN on purpose: the availability condition alone must hide these two.
    await mkOpp('oppGrantClosed', 1, 'CLOSED')
    await grant('oppGrantClosed', 'teamA', '1 day')
    await evaluated('oppGrantClosed', 1, 'OPEN')
    await mkOpp('oppGrantExpiredPosting', 1, 'EXPIRED')
    await grant('oppGrantExpiredPosting', 'teamA', '1 day')
    await evaluated('oppGrantExpiredPosting', 1, 'OPEN')
    await mkOpp('oppGrantGlobalExcluded')
    await grant('oppGrantGlobalExcluded', 'teamA', '1 day')
    await evaluated('oppGrantGlobalExcluded', 1, 'EXCLUDED')
    await match('oppGrantGlobalExcluded', 'senB', 'EXCLUDED', {
      evidence: { stage: 'GLOBAL_RESTRICTIONS', reasons: [] },
    })
    await mkOpp('oppGrantLayer1Rejected')
    await grant('oppGrantLayer1Rejected', 'teamA', '1 day')
    await evaluated('oppGrantLayer1Rejected', 1, 'EXCLUDED')
    await match('oppGrantLayer1Rejected', 'senA', 'EXCLUDED', {
      evidence: { stage: 'CLASSIFICATION', reasons: [] },
    })
    // A global exclusion at an OLD revision no longer applies to the current one.
    await mkOpp('oppGrantOldExclusion', 2)
    await grant('oppGrantOldExclusion', 'teamA', '1 day')
    await evaluated('oppGrantOldExclusion', 2, 'OPEN')
    await match('oppGrantOldExclusion', 'senA', 'EXCLUDED', {
      revision: 1,
      evidence: { stage: 'GLOBAL_RESTRICTIONS', reasons: [] },
    })
    // A per-senior stop-list (A1g) does not hide the opportunity from the team.
    await mkOpp('oppGrantSeniorStopList')
    await grant('oppGrantSeniorStopList', 'teamA', '1 day')
    await evaluated('oppGrantSeniorStopList', 1, 'OPEN')
    await match('oppGrantSeniorStopList', 'senA', 'EXCLUDED', {
      evidence: { stage: 'SCOPED_RESTRICTIONS', reasons: [] },
    })
    // SR-M-2: a grant made at revision 1, the opportunity bumped to 2, evaluated only at 1, with
    // a revision-1 LEAD row: the recompute for revision 2 has not run yet.
    await mkOpp('oppGrantBumped', 2)
    await grant('oppGrantBumped', 'teamA', '1 day')
    await evaluated('oppGrantBumped', 1, 'OPEN')
    await match('oppGrantBumped', 'senA', 'LEAD', { revision: 1 })
    // ...and a granted opportunity never evaluated (no row at all, no verdict).
    await mkOpp('oppGrantNoRows')
    await grant('oppGrantNoRows', 'teamA', '1 day')
    // SR-M-2 through the real writer, with an empty roster and a revision bump.
    for (const opp of ['oppGrantEmptyOpen', 'oppGrantEmptyExcluded', 'oppGrantRecomputed']) {
      await mkOpp(opp)
      await grant(opp, 'teamA', '1 day')
    }
    await mkOpp('oppUnmatched')
    await mkOpp('oppLive')
    await match('oppLive', 'senLive', 'LEAD')
    await mkOpp('oppGoneLead')
    await match('oppGoneLead', 'senGone', 'LEAD')
    await mkOpp('oppGoneGrant')
    await grant('oppGoneGrant', 'teamGone', '1 day')
    await evaluated('oppGoneGrant', 1, 'OPEN')

    // Task 6.4c — triage subscriptions. Each family is used by exactly one subscription, so every
    // hidden opportunity below differs from the visible `oppSub` in exactly one condition.
    const subscribe = (
      team: string,
      roleFamily: string,
      expires: string,
      o: { revoked?: boolean; sourceTypes?: string[] } = {},
    ) =>
      q(
        `INSERT INTO job_team_triage_subscriptions
           (team_id, role_family, source_types, policy_version, actor_id, reason, expires_at,
            revoked_at, revoked_by, revoke_reason)
         VALUES ($1, $2, $3::job_source_type[], 1, $4, 'qscope', now() + $5::interval,
                 $6, $7, $8)`,
        [
          ids[team],
          roleFamily,
          o.sourceTypes ?? [],
          ids['admin'],
          expires,
          o.revoked ? new Date() : null,
          o.revoked ? ids['admin'] : null,
          o.revoked ? 'qscope revoked' : null,
        ],
      )
    /** A verified-employer opportunity, evaluated OPEN at its revision, with a persisted family. */
    const subOpp = async (
      key: string,
      roleFamily: string | null,
      o: { verified?: boolean; verdict?: 'OPEN' | 'EXCLUDED'; availability?: string } = {},
    ) => {
      await mkOpp(key, 1, o.availability ?? 'OPEN')
      await evaluated(key, 1, o.verdict ?? 'OPEN')
      const verified = o.verified ?? true
      await q(
        `UPDATE job_opportunities
            SET role_family = $2, employer_verified = $3, employer_key = $4
          WHERE id = $1`,
        [ids[key], roleFamily, verified, verified ? `qscope-employer-${TAG}` : null],
      )
    }
    const linkSource = async (opp: string, sourceType: string, unlinked = false) => {
      const { rows } = await q(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ($1, $2, 'NATIVE_ID', $3) RETURNING id`,
        [sourceType, `qscope-${TAG}`, `qscope-${opp}-${sourceType}-${TAG}`],
      )
      recordIds.push(rows[0].id as string)
      await q(
        `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version, unlinked_at)
         VALUES ($1, $2, 1, $3)`,
        [rows[0].id, ids[opp], unlinked ? new Date() : null],
      )
    }

    await subscribe('teamA', 'SOFTWARE', '1 day')
    await subscribe('teamA', 'DATA', '-1 minute')
    await subscribe('teamA', 'QA', '1 day', { revoked: true })
    await subscribe('teamB', 'DEVOPS', '1 day')
    await subscribe('teamA', 'DESIGN', '1 day', { sourceTypes: ['HIMALAYAS_API'] })
    await subOpp('oppSub', 'SOFTWARE')
    await subOpp('oppSubExpired', 'DATA')
    await subOpp('oppSubRevoked', 'QA')
    await subOpp('oppSubUnverified', 'SOFTWARE', { verified: false })
    await subOpp('oppSubForeign', 'DEVOPS')
    await subOpp('oppSubNullFamily', null)
    await subOpp('oppSubUnsubscribedFamily', 'PRODUCT')
    await subOpp('oppSubExcluded', 'SOFTWARE', { verdict: 'EXCLUDED' })
    await subOpp('oppSubClosed', 'SOFTWARE', { availability: 'CLOSED' })
    await subOpp('oppSubBumped', 'SOFTWARE')
    await q(`UPDATE job_opportunities SET revision = 2 WHERE id = $1`, [ids['oppSubBumped']])
    await subOpp('oppSubSourceMatch', 'DESIGN')
    await linkSource('oppSubSourceMatch', 'GREENHOUSE_ATS')
    await linkSource('oppSubSourceMatch', 'HIMALAYAS_API')
    await subOpp('oppSubSourceMiss', 'DESIGN')
    await linkSource('oppSubSourceMiss', 'GREENHOUSE_ATS')
    await subOpp('oppSubSourceUnlinked', 'DESIGN')
    await linkSource('oppSubSourceUnlinked', 'HIMALAYAS_API', true)
    await subOpp('oppSubSourceNone', 'DESIGN')
    // Visible only through team A's SOFTWARE subscription until the test suppresses it.
    await subOpp('oppSubSuppressed', 'SOFTWARE')
    // Verified and subscribed, but never evaluated: the real writer decides it below.
    await mkOpp('oppSubRecomputed')
    await q(
      `UPDATE job_opportunities SET employer_verified = true, employer_key = $2 WHERE id = $1`,
      [ids['oppSubRecomputed'], `qscope-employer-${TAG}`],
    )
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      // The suppression row is append-only: only its owner can clean it, as the RBAC spec does.
      await session.admin.query(
        `ALTER TABLE job_queue_actions DISABLE TRIGGER trg_job_queue_actions_append_only`,
      )
      await session.admin.query(
        `DELETE FROM job_queue_actions WHERE opportunity_id = ANY($1::uuid[])`,
        [oppIds],
      )
      await session.admin.query(
        `ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER trg_job_queue_actions_append_only`,
      )
      // Source links RESTRICT both the opportunity and the record, so they go first.
      await session.admin.query(
        `DELETE FROM job_opportunity_sources WHERE opportunity_id = ANY($1::uuid[])`,
        [oppIds],
      )
      await session.admin.query(`DELETE FROM job_source_records WHERE id = ANY($1::uuid[])`, [
        recordIds,
      ])
      // Subscriptions RESTRICT their actor (the admin) and cascade only from the team.
      await session.admin.query(
        `DELETE FROM job_team_triage_subscriptions WHERE team_id = ANY($1::uuid[])`,
        [teamIds],
      )
      // Matches and grants cascade from the opportunity; grants RESTRICT the admin, so opps first.
      await session.admin.query(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [
        oppIds,
      ])
      await session.admin.query(
        `DELETE FROM job_exclusion_filters WHERE senior_id = ANY($1::uuid[])`,
        [userIds],
      )
      await session.admin.query(`DELETE FROM team_members WHERE team_id = ANY($1::uuid[])`, [
        teamIds,
      ])
      await session.admin.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [teamIds])
      await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds])
    } finally {
      await session.close()
    }
  })

  const resolve = (key: string, role: SessionUser['role'], teamKey?: string) =>
    service.resolve(
      user(ids[key] as string, role),
      teamKey === undefined ? undefined : ids[teamKey],
    )
  const visible = (scope: JobQueueScope, opp: string) =>
    service.assertVisible(scope, ids[opp] as string)

  describe('resolve', () => {
    it('ADMIN without a team is STUDIO', async () => {
      await expect(resolve('admin', 'ADMIN')).resolves.toEqual(STUDIO_SCOPE)
    })

    it('ADMIN naming team A gets it, with only its live SENIOR members and their live versions', async () => {
      const scope = await resolve('admin', 'ADMIN', 'teamA')
      const seniors = [ids['senA'], ids['senLive']].sort() as string[]
      expect(scope).toEqual({
        kind: 'TEAM',
        teamId: ids['teamA'],
        seniorIds: seniors,
        versions: seniors.map((seniorId) => ({
          seniorId,
          profile: live.get(seniorId)?.profile,
          exclusion: live.get(seniorId)?.exclusion,
        })),
        inputsVersion: opportunityInputsVersion(studio),
      })
    })

    it('an uppercase team id is the same team (HR and ADMIN)', async () => {
      const upper = (ids['teamA'] as string).toUpperCase()
      expect(await service.resolve(user(ids['admin'] as string, 'ADMIN'), upper)).toMatchObject({
        kind: 'TEAM',
        teamId: ids['teamA'],
      })
      expect(await service.resolve(user(ids['hrA'] as string, 'HR'), upper)).toMatchObject({
        kind: 'TEAM',
        teamId: ids['teamA'],
      })
    })

    it('a malformed team id is NONE, not a 503 (PANEL-GLM-5)', async () => {
      await expect(service.resolve(user(ids['admin'] as string, 'ADMIN'), 'nope')).resolves.toEqual(
        NONE_SCOPE,
      )
      await expect(service.resolve(user(ids['hrA'] as string, 'HR'), 'nope')).resolves.toEqual(
        NONE_SCOPE,
      )
    })

    it('ADMIN naming an archived or DROP team is NONE', async () => {
      await expect(resolve('admin', 'ADMIN', 'teamArchived')).resolves.toEqual(NONE_SCOPE)
      await expect(resolve('admin', 'ADMIN', 'teamDrop')).resolves.toEqual(NONE_SCOPE)
    })

    it('own HR defaults to their team; seniors exclude archived, left and non-SENIOR members', async () => {
      expect(await resolve('hrA', 'HR')).toMatchObject({
        kind: 'TEAM',
        teamId: ids['teamA'],
        seniorIds: [ids['senA'], ids['senLive']].sort(),
      })
    })

    it('a multi-team HR defaults to the oldest live SENIOR team, and may name another', async () => {
      expect(await resolve('hrMulti', 'HR')).toMatchObject({ kind: 'TEAM', teamId: ids['teamA'] })
      expect(await resolve('hrMulti', 'HR', 'teamB')).toMatchObject({
        kind: 'TEAM',
        teamId: ids['teamB'],
        seniorIds: [ids['senB']],
      })
      await expect(resolve('hrMulti', 'HR', 'teamArchived')).resolves.toEqual(NONE_SCOPE)
    })

    it('foreign HR naming team A is NONE', async () => {
      await expect(resolve('hrB', 'HR', 'teamA')).resolves.toEqual(NONE_SCOPE)
    })

    it('HR with only left / archived memberships is NONE', async () => {
      await expect(resolve('hrNone', 'HR')).resolves.toEqual(NONE_SCOPE)
    })

    it.each(['SENIOR', 'JUNIOR', 'ACCOUNTANT', 'DROP'] as const)('%s is a 403', async (role) => {
      await expect(resolve('senA', role)).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  describe('assertVisible', () => {
    it('STUDIO sees every existing opportunity, including unmatched triage', async () => {
      for (const opp of ['oppA', 'oppB', 'oppUnmatched', 'oppExcluded']) {
        await expect(visible(STUDIO_SCOPE, opp)).resolves.toBeUndefined()
      }
    })

    it('a non-existent or malformed opportunity id is the same 404 (STUDIO and TEAM)', async () => {
      await expectNotFound(service.assertVisible(STUDIO_SCOPE, randomUUID()))
      await expectNotFound(service.assertVisible(STUDIO_SCOPE, 'not-a-uuid'))
      const a = await resolve('hrA', 'HR')
      await expectNotFound(service.assertVisible(a, randomUUID()))
      await expectNotFound(service.assertVisible(a, 'not-a-uuid'))
    })

    it('team A sees its live-version LEAD and its live grant; team B sees neither', async () => {
      const a = await resolve('hrA', 'HR')
      const b = await resolve('hrB', 'HR')
      await expect(visible(a, 'oppA')).resolves.toBeUndefined()
      await expect(visible(a, 'oppGrant')).resolves.toBeUndefined()
      await expectNotFound(visible(b, 'oppA'))
      await expectNotFound(visible(b, 'oppGrant'))
      await expect(visible(b, 'oppB')).resolves.toBeUndefined()
      await expectNotFound(visible(a, 'oppB'))
    })

    it.each([
      'oppStaleRevision',
      'oppStaleProfile',
      'oppStaleExclusion',
      'oppStaleRule',
      'oppTriage',
      'oppExcluded',
      'oppArchivedSenior',
      'oppLeftSenior',
      'oppUnmatched',
    ])('team A does not see %s', async (opp) => {
      await expectNotFound(visible(await resolve('hrA', 'HR'), opp))
    })

    it.each([
      'oppGrantExpired',
      'oppGrantRevoked',
      'oppGrantClosed',
      'oppGrantExpiredPosting',
      'oppGrantGlobalExcluded',
      'oppGrantLayer1Rejected',
    ])('a grant does not expose %s', async (opp) => {
      await expectNotFound(visible(await resolve('hrA', 'HR'), opp))
    })

    it('a grant still exposes an item with an old-revision or per-senior exclusion', async () => {
      const a = await resolve('hrA', 'HR')
      await expect(visible(a, 'oppGrantOldExclusion')).resolves.toBeUndefined()
      await expect(visible(a, 'oppGrantSeniorStopList')).resolves.toBeUndefined()
    })

    describe('SR-M-2: a grant shows only what was evaluated OPEN at the current revision', () => {
      const db = () => session.databaseService.db
      // No senior, but the live studio exclusions: what an empty production roster would load.
      const emptyRoster = (): RosterInputs => ({
        rosterSeniorIds: [],
        profiles: [],
        exclusions: studio,
        versions: new Map(),
      })
      const audit = { noTeamAccess: [], ignoredExclusionIds: [] }
      const base = {
        recordKey: 'k',
        revisionId: '1',
        evaluatedAt: '2026-11-04T10:00:00.000Z',
        trace: [],
      }
      // UNKNOWN records a NULL role family, so no subscription branch interferes with these cases.
      const open = (opp: string, roleFamily: RoleFamily = 'UNKNOWN') =>
        ({
          ...base,
          kind: 'EVALUATED',
          opportunityId: ids[opp],
          status: 'NO_MATCH',
          layer1: { roleFamily: { value: roleFamily } },
          projections: [],
          audit: { ...audit, excluded: [] },
        }) as unknown as Evaluated
      const excludedGlobally = (opp: string): Excluded => ({
        ...base,
        kind: 'EXCLUDED',
        opportunityId: ids[opp] as string,
        roleFamily: 'UNKNOWN',
        reasons: [],
        audit: {
          ...audit,
          excluded: [
            { subject: 'OPPORTUNITY', stage: 'GLOBAL_RESTRICTIONS', reasons: [], inputs: {} },
          ],
        },
      })

      it('evaluated OPEN at the current revision is visible; evaluated EXCLUDED is a 404', async () => {
        const a = await resolve('hrA', 'HR')
        await expect(visible(a, 'oppGrant')).resolves.toBeUndefined()
        await expectNotFound(visible(a, 'oppGrantGlobalExcluded'))
        await expectNotFound(visible(a, 'oppGrantLayer1Rejected'))
      })

      it('never evaluated is a 404', async () => {
        await expectNotFound(visible(await resolve('hrA', 'HR'), 'oppGrantNoRows'))
      })

      it('a bumped revision is a 404 even with an OPEN verdict at the old one', async () => {
        await expectNotFound(visible(await resolve('hrA', 'HR'), 'oppGrantBumped'))
      })

      it('after a bump the item is a 404 until its recompute, then visible', async () => {
        const a = await resolve('hrA', 'HR')
        const opp = 'oppGrantRecomputed'
        await installMatches(db(), ids[opp] as string, 1, open(opp), emptyRoster())
        await expect(visible(a, opp)).resolves.toBeUndefined()
        await session.admin.query(`UPDATE job_opportunities SET revision = 2 WHERE id = $1`, [
          ids[opp],
        ])
        await expectNotFound(visible(a, opp))
        await installMatches(db(), ids[opp] as string, 2, open(opp), emptyRoster())
        await expect(visible(a, opp)).resolves.toBeUndefined()
      })

      it('an empty roster writes no rows and the verdict still decides: OPEN visible, EXCLUDED 404', async () => {
        const a = await resolve('hrA', 'HR')
        const openOpp = 'oppGrantEmptyOpen'
        const excludedOpp = 'oppGrantEmptyExcluded'
        await expectNotFound(visible(a, openOpp))
        await expectNotFound(visible(a, excludedOpp))
        expect(
          await installMatches(db(), ids[openOpp] as string, 1, open(openOpp), emptyRoster()),
        ).toBe(0)
        expect(
          await installMatches(
            db(),
            ids[excludedOpp] as string,
            1,
            excludedGlobally(excludedOpp),
            emptyRoster(),
          ),
        ).toBe(0)
        await expect(visible(a, openOpp)).resolves.toBeUndefined()
        await expectNotFound(visible(a, excludedOpp))
      })

      it('SR-M-1: a studio keyword added after evaluation hides a zero-row granted item at once; its recompute shows it again', async () => {
        const opp = 'oppGrantEmptyOpen'
        await expect(visible(await resolve('hrA', 'HR'), opp)).resolves.toBeUndefined()
        const { rows } = await session.admin.query(
          `INSERT INTO job_exclusion_filters (senior_id, kind, value, normalized_value)
           VALUES (NULL, 'KEYWORD', $1, $1) RETURNING id`,
          [`qscope-kw-${TAG}`],
        )
        try {
          // No recompute has run: the recorded inputs version is the old one, so a fresh scope hides it.
          await expectNotFound(visible(await resolve('hrA', 'HR'), opp))
          const now = await loadRoster(db())
          expect(await installMatches(db(), ids[opp] as string, 1, open(opp), now)).toBe(0)
          const { rows: record } = await session.admin.query(
            `SELECT evaluated_inputs_version FROM job_opportunities WHERE id = $1`,
            [ids[opp]],
          )
          expect(record).toEqual([
            { evaluated_inputs_version: opportunityInputsVersion(now.exclusions) },
          ])
          expect(record[0].evaluated_inputs_version).not.toBe(opportunityInputsVersion(studio))
          await expect(visible(await resolve('hrA', 'HR'), opp)).resolves.toBeUndefined()
        } finally {
          await session.admin.query(`DELETE FROM job_exclusion_filters WHERE id = $1`, [rows[0].id])
          await installMatches(db(), ids[opp] as string, 1, open(opp), emptyRoster())
        }
      })

      it('SR-M-1: a match rule deploy hides a granted item until it is evaluated at the new rule version', async () => {
        const opp = 'oppGrant'
        const a = await resolve('hrA', 'HR')
        expect(a.kind).toBe('TEAM')
        const deployed = {
          ...(a as Extract<JobQueueScope, { kind: 'TEAM' }>),
          inputsVersion: opportunityInputsVersion(studio, 'eval.2+l1.1'),
        }
        await expect(visible(a, opp)).resolves.toBeUndefined()
        await expectNotFound(visible(deployed, opp))
        // What a recompute after the deploy records; the old rule's scope then no longer sees it.
        const stamp = (version: string) =>
          session.admin.query(
            `UPDATE job_opportunities SET evaluated_inputs_version = $2 WHERE id = $1`,
            [ids[opp], version],
          )
        try {
          await stamp(deployed.inputsVersion)
          await expect(visible(deployed, opp)).resolves.toBeUndefined()
          await expectNotFound(visible(a, opp))
        } finally {
          await stamp(opportunityInputsVersion(studio))
        }
      })
    })

    describe('Task 6.4c: a triage subscription shows a live, verified, OPEN family match', () => {
      it('team A sees the opportunity of its live subscription; team B does not', async () => {
        await expect(visible(await resolve('hrA', 'HR'), 'oppSub')).resolves.toBeUndefined()
        await expectNotFound(visible(await resolve('hrB', 'HR'), 'oppSub'))
      })

      it('another team’s subscription shows nothing to team A, and its own team sees it', async () => {
        await expectNotFound(visible(await resolve('hrA', 'HR'), 'oppSubForeign'))
        await expect(visible(await resolve('hrB', 'HR'), 'oppSubForeign')).resolves.toBeUndefined()
      })

      it.each([
        ['oppSubExpired', 'an expired subscription'],
        ['oppSubRevoked', 'a revoked subscription'],
        ['oppSubUnverified', 'an unverified employer'],
        ['oppSubNullFamily', 'a NULL role family (fail closed)'],
        ['oppSubUnsubscribedFamily', 'a family no subscription names'],
        ['oppSubExcluded', 'an EXCLUDED verdict'],
        ['oppSubClosed', 'a CLOSED posting'],
        ['oppSubBumped', 'a verdict at an old revision'],
      ])('%s is a 404: %s', async (opp) => {
        await expectNotFound(visible(await resolve('hrA', 'HR'), opp))
      })

      it('a source filter admits an opportunity with an ACTIVE link of a listed type only', async () => {
        const a = await resolve('hrA', 'HR')
        await expect(visible(a, 'oppSubSourceMatch')).resolves.toBeUndefined()
        await expectNotFound(visible(a, 'oppSubSourceMiss'))
        await expectNotFound(visible(a, 'oppSubSourceUnlinked'))
        await expectNotFound(visible(a, 'oppSubSourceNone'))
      })

      it('an ADMIN suppression hides an item visible only through a subscription', async () => {
        const a = await resolve('hrA', 'HR')
        await expect(visible(a, 'oppSubSuppressed')).resolves.toBeUndefined()
        await session.admin.query(
          `INSERT INTO job_queue_actions
             (kind, opportunity_id, actor_id, scope_kind, idempotency_key, reason)
           VALUES ('SUPPRESSED', $1, $2, 'STUDIO', $3, 'qscope suppress')`,
          [ids['oppSubSuppressed'], ids['admin'], `qscope-suppress-${TAG}`],
        )
        await expectNotFound(visible(a, 'oppSubSuppressed'))
        await expect(visible(STUDIO_SCOPE, 'oppSubSuppressed')).resolves.toBeUndefined()
      })

      it('a stale inputs version hides a subscribed item, like a grant', async () => {
        const a = await resolve('hrA', 'HR')
        const deployed = {
          ...(a as Extract<JobQueueScope, { kind: 'TEAM' }>),
          inputsVersion: opportunityInputsVersion(studio, 'eval.2+l1.1+rf.1'),
        }
        await expect(visible(a, 'oppSub')).resolves.toBeUndefined()
        await expectNotFound(visible(deployed, 'oppSub'))
      })

      it('the real writer persists the family: 404 before, visible after, 404 once it is UNKNOWN', async () => {
        const opp = 'oppSubRecomputed'
        const db = session.databaseService.db
        const roster: RosterInputs = {
          rosterSeniorIds: [],
          profiles: [],
          exclusions: studio,
          versions: new Map(),
        }
        const verdict = (roleFamily: RoleFamily) =>
          ({
            kind: 'EVALUATED',
            recordKey: 'k',
            opportunityId: ids[opp],
            revisionId: '1',
            evaluatedAt: '2026-11-05T10:00:00.000Z',
            status: 'NO_MATCH',
            layer1: { roleFamily: { value: roleFamily } },
            projections: [],
            trace: [],
            audit: { excluded: [], noTeamAccess: [], ignoredExclusionIds: [] },
          }) as unknown as Evaluated
        const a = await resolve('hrA', 'HR')
        await expectNotFound(visible(a, opp))
        await installMatches(db, ids[opp] as string, 1, verdict('SOFTWARE'), roster)
        const { rows } = await session.admin.query(
          `SELECT role_family FROM job_opportunities WHERE id = $1`,
          [ids[opp]],
        )
        expect(rows).toEqual([{ role_family: 'SOFTWARE' }])
        await expect(visible(a, opp)).resolves.toBeUndefined()
        await installMatches(db, ids[opp] as string, 1, verdict('UNKNOWN'), roster)
        await expectNotFound(visible(a, opp))
      })
    })

    it('NONE sees nothing', async () => {
      await expectNotFound(visible(await resolve('hrNone', 'HR'), 'oppA'))
    })
  })

  describe('live changes after resolve', () => {
    it('a new exclusion stales the senior: a fresh scope no longer sees the LEAD', async () => {
      await expect(visible(await resolve('hrA', 'HR'), 'oppA')).resolves.toBeUndefined()
      await session.admin.query(
        `INSERT INTO job_exclusion_filters (senior_id, kind, value, normalized_value)
         VALUES ($1, 'COMPANY', $2, $2)`,
        [ids['senA'], `qscope-co-${TAG}`],
      )
      await expectNotFound(visible(await resolve('hrA', 'HR'), 'oppA'))
    })

    it('an archived team shows nothing, even with a live LEAD and a live grant', async () => {
      const gone = await resolve('hrGone', 'HR')
      await expect(visible(gone, 'oppGoneLead')).resolves.toBeUndefined()
      await expect(visible(gone, 'oppGoneGrant')).resolves.toBeUndefined()
      await session.admin.query(`UPDATE teams SET archived_at = now() WHERE id = $1`, [
        ids['teamGone'],
      ])
      await expectNotFound(visible(gone, 'oppGoneLead'))
      await expectNotFound(visible(gone, 'oppGoneGrant'))
    })

    it('a roster change after resolve wins: the per-request scope grants nothing', async () => {
      const a = await resolve('hrA', 'HR')
      await expect(visible(a, 'oppLive')).resolves.toBeUndefined()
      await session.admin.query(
        `UPDATE team_members SET left_at = now() WHERE team_id = $1 AND user_id = $2`,
        [ids['teamA'], ids['senLive']],
      )
      expect(a.kind === 'TEAM' && a.seniorIds).toContain(ids['senLive'])
      await expectNotFound(visible(a, 'oppLive'))
    })
  })
})
