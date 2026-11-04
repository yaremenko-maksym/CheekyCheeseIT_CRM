import { randomUUID } from 'node:crypto'
import { ForbiddenException, HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { type JobQueueScope, STUDIO_SCOPE } from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * r5 Task 6.1 — queue visibility against a real Postgres, as the API role (`crm_app`). A mocked
 * E2E cannot prove a backend scope (the #110/#157 lesson). Fixtures are written directly (users,
 * teams, opportunities, per-senior matches, triage grants) so every row of the matrix is explicit:
 * ADMIN, own HR, foreign HR, no-team HR, archived / left member, other roles, stale revision,
 * EXCLUDED, live / expired / revoked grant, live roster change after the scope was resolved.
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

let session: CrmAppSession
let service: JobQueueScopeService
const ids: Record<string, string> = {}
const userIds: string[] = []
const teamIds: string[] = []
const oppIds: string[] = []

describe.skipIf(!hasDatabaseUrl())('JobQueueScopeService against Postgres (Task 6.1)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 2 })
    const probe = await session.admin.query(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    service = new JobQueueScopeService(session.databaseService)
    const q = (text: string, params: unknown[]) => session.admin.query(text, params)

    const mkUser = async (key: string, role: SessionUser['role'], archived = false) => {
      const { rows } = await q(
        `INSERT INTO users (email, display_name, role, archived_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`qscope-${key}-${TAG}@example.test`, `qscope ${key}`, role, archived ? new Date() : null],
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
    const mkOpp = async (key: string, revision = 1) => {
      const { rows } = await q(
        `INSERT INTO job_opportunities (title, title_key, revision) VALUES ($1, $1, $2) RETURNING id`,
        [`qscope ${key} ${TAG}`, revision],
      )
      ids[key] = rows[0].id as string
      oppIds.push(ids[key])
    }
    const match = (opp: string, senior: string, outcome: string, revision = 1) =>
      q(
        `INSERT INTO job_opportunity_matches
           (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
            exclusion_version, rule_version, outcome)
         VALUES ($1, $2, $3, 'v', 'v', 'v', $4)`,
        [ids[opp], ids[senior], revision, outcome],
      )
    const grant = (opp: string, team: string, expires: string, revoked = false) =>
      q(
        `INSERT INTO job_opportunity_team_triage
           (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision,
            expires_at, revoked_at)
         VALUES ($1, $2, $3, 1, 1, now() + $4::interval, $5)`,
        [ids[opp], ids[team], ids['admin'], expires, revoked ? new Date() : null],
      )

    await mkUser('admin', 'ADMIN')
    await mkUser('hrA', 'HR')
    await mkUser('hrB', 'HR')
    await mkUser('hrNone', 'HR')
    await mkUser('hrMulti', 'HR')
    await mkUser('senA', 'SENIOR')
    await mkUser('senB', 'SENIOR')
    await mkUser('senArchived', 'SENIOR', true)
    await mkUser('senLeft', 'SENIOR')
    await mkUser('senLive', 'SENIOR')
    await mkUser('junA', 'JUNIOR')

    await mkTeam('teamA', '2020-01-01T00:00:00Z')
    await mkTeam('teamB', '2020-01-02T00:00:00Z')
    // Older than A, but archived / DROP-type: never a queue scope, never the default.
    await mkTeam('teamArchived', '2019-01-01T00:00:00Z', 'SENIOR', true)
    await mkTeam('teamDrop', '2019-01-02T00:00:00Z', 'DROP')

    for (const m of ['hrA', 'senA', 'senArchived', 'senLive', 'junA']) await join('teamA', m)
    await join('teamA', 'senLeft', true)
    for (const m of ['hrB', 'senB']) await join('teamB', m)
    for (const t of ['teamB', 'teamA', 'teamArchived', 'teamDrop']) await join(t, 'hrMulti')
    // hrNone: a membership that was left, and one in an archived team — no active team.
    await join('teamB', 'hrNone', true)
    await join('teamArchived', 'hrNone')

    await mkOpp('oppA')
    await match('oppA', 'senA', 'LEAD')
    await mkOpp('oppB')
    await match('oppB', 'senB', 'LEAD')
    await mkOpp('oppStale', 2)
    await match('oppStale', 'senA', 'LEAD', 1)
    await mkOpp('oppExcluded')
    await match('oppExcluded', 'senA', 'EXCLUDED')
    await mkOpp('oppArchivedSenior')
    await match('oppArchivedSenior', 'senArchived', 'LEAD')
    await mkOpp('oppLeftSenior')
    await match('oppLeftSenior', 'senLeft', 'LEAD')
    await mkOpp('oppGrant')
    await grant('oppGrant', 'teamA', '1 day')
    await mkOpp('oppGrantExpired')
    await grant('oppGrantExpired', 'teamA', '-1 minute')
    await mkOpp('oppGrantRevoked')
    await grant('oppGrantRevoked', 'teamA', '1 day', true)
    await mkOpp('oppUnmatched')
    await mkOpp('oppLive')
    await match('oppLive', 'senLive', 'LEAD')
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      // Matches and grants cascade from the opportunity; grants RESTRICT the admin, so opps first.
      await session.admin.query(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [
        oppIds,
      ])
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

  describe('resolve', () => {
    it('ADMIN without a team is STUDIO', async () => {
      await expect(resolve('admin', 'ADMIN')).resolves.toEqual(STUDIO_SCOPE)
    })

    it('ADMIN naming team A gets it, with only its live SENIOR members (sorted)', async () => {
      const expected = [ids['senA'], ids['senLive']].sort()
      await expect(resolve('admin', 'ADMIN', 'teamA')).resolves.toEqual({
        kind: 'TEAM',
        teamId: ids['teamA'],
        seniorIds: expected,
      })
    })

    it('ADMIN naming an archived or DROP team is NONE', async () => {
      await expect(resolve('admin', 'ADMIN', 'teamArchived')).resolves.toEqual({ kind: 'NONE' })
      await expect(resolve('admin', 'ADMIN', 'teamDrop')).resolves.toEqual({ kind: 'NONE' })
    })

    it('own HR defaults to their team; seniors exclude archived, left and non-SENIOR members', async () => {
      const scope = await resolve('hrA', 'HR')
      expect(scope).toEqual({
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
      await expect(resolve('hrMulti', 'HR', 'teamArchived')).resolves.toEqual({ kind: 'NONE' })
    })

    it('foreign HR naming team A is NONE', async () => {
      await expect(resolve('hrB', 'HR', 'teamA')).resolves.toEqual({ kind: 'NONE' })
    })

    it('HR with only left / archived memberships is NONE', async () => {
      await expect(resolve('hrNone', 'HR')).resolves.toEqual({ kind: 'NONE' })
    })

    it.each(['SENIOR', 'JUNIOR', 'ACCOUNTANT', 'DROP'] as const)('%s is a 403', async (role) => {
      await expect(resolve('senA', role)).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  describe('assertVisible', () => {
    const visible = (scope: JobQueueScope, opp: string) =>
      service.assertVisible(scope, ids[opp] as string)

    it('STUDIO sees every existing opportunity, including unmatched triage', async () => {
      for (const opp of ['oppA', 'oppB', 'oppUnmatched', 'oppExcluded']) {
        await expect(visible(STUDIO_SCOPE, opp)).resolves.toBeUndefined()
      }
    })

    it('STUDIO: a non-existent opportunity is the same 404', async () => {
      await expectNotFound(service.assertVisible(STUDIO_SCOPE, randomUUID()))
    })

    it('team A sees its LEAD and its live grant; team B sees neither', async () => {
      const a = await resolve('hrA', 'HR')
      const b = await resolve('hrB', 'HR')
      await expect(visible(a, 'oppA')).resolves.toBeUndefined()
      await expect(visible(a, 'oppGrant')).resolves.toBeUndefined()
      await expectNotFound(visible(b, 'oppA'))
      await expectNotFound(visible(b, 'oppGrant'))
      await expect(visible(b, 'oppB')).resolves.toBeUndefined()
      await expectNotFound(visible(a, 'oppB'))
    })

    it('team A does not see stale, EXCLUDED, archived-senior, left-senior or unmatched items', async () => {
      const a = await resolve('hrA', 'HR')
      for (const opp of [
        'oppStale',
        'oppExcluded',
        'oppArchivedSenior',
        'oppLeftSenior',
        'oppUnmatched',
      ]) {
        await expectNotFound(visible(a, opp))
      }
    })

    it('an expired or revoked grant grants nothing', async () => {
      const a = await resolve('hrA', 'HR')
      await expectNotFound(visible(a, 'oppGrantExpired'))
      await expectNotFound(visible(a, 'oppGrantRevoked'))
    })

    it('NONE sees nothing, and a non-existent id in a TEAM scope is the same 404', async () => {
      await expectNotFound(visible(await resolve('hrNone', 'HR'), 'oppA'))
      await expectNotFound(service.assertVisible(await resolve('hrA', 'HR'), randomUUID()))
    })

    it('a roster change after resolve wins: the cached scope grants nothing', async () => {
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
