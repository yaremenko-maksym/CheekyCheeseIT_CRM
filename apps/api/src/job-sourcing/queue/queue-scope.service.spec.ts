import { ForbiddenException, HttpException, Logger } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exclusionVersion, profileVersion } from '../runtime/recompute-inputs'
import type { SqlExecutor } from '../scheduling/host-state'
import { triagePolicyVersion } from './queue-read-sql'
import {
  type JobQueueScope,
  type JobQueueViewScope,
  type LiveSeniorVersion,
  NONE_SCOPE,
  STUDIO_SCOPE,
  type TeamScope,
} from './queue-scope'
import { describeFailure, JobQueueScopeService } from './queue-scope.service'

/**
 * Unit double for the mutation gate (it cannot run `*.integration.spec.ts`): the DB is a scripted
 * `execute`, each call answering the next queued row set; an unscripted call FAILS the test. The
 * real SQL is pinned against Postgres by `queue-scope.integration.spec.ts`.
 */
const TEAM_A = '11111111-1111-4111-8111-111111111111'
const TEAM_B = '22222222-2222-4222-8222-222222222222'
const SEN_1 = '33333333-3333-4333-8333-333333333333'
const SEN_2 = '55555555-5555-4555-8555-555555555555'
const OPP = '44444444-4444-4444-8444-444444444444'
const user = (role: SessionUser['role'], id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') =>
  ({ id, role, email: 'x@example.test' }) as SessionUser

type Rows = Array<Record<string, unknown>>

/** The service with its required executor defaulted to one scripted `execute`. */
function bound(execute: unknown) {
  const pool = { execute } as unknown as SqlExecutor
  const real = new JobQueueScopeService()
  return {
    resolve: (u: SessionUser, teamId?: string, db: SqlExecutor = pool) =>
      real.resolve(u, teamId, db),
    assertVisible: (scope: JobQueueScope, id: string, db: SqlExecutor = pool) =>
      real.assertVisible(scope, id, db),
    resolveView: (u: SessionUser, teamId?: string, db: SqlExecutor = pool) =>
      real.resolveView(u, teamId, db),
    resolveWrite: (
      u: SessionUser,
      pick: (teams: readonly TeamScope[]) => Promise<TeamScope>,
      teamId?: string,
      db: SqlExecutor = pool,
    ) => real.resolveWrite(u, teamId, db, pick),
    liveVersions: (scope: JobQueueViewScope, db: SqlExecutor = pool) =>
      real.liveVersions(scope, db),
    triagePolicyVersion: (versions: readonly LiveSeniorVersion[], db: SqlExecutor = pool) =>
      real.triagePolicyVersion(versions, db),
    dismissalOwner: (teams: readonly TeamScope[], id: string, db: SqlExecutor = pool) =>
      real.dismissalOwner(teams, id, db),
  }
}

function harness(...answers: Array<Rows | Error>) {
  const execute = vi.fn(async () => {
    const next = answers.shift()
    if (next === undefined) throw new Error('unexpected query')
    if (next instanceof Error) throw next
    return { rows: next }
  })
  const svc = bound(execute)
  const compiled = (call: number) => {
    const arg = (execute.mock.calls[call] as unknown as [SQL])[0]
    const q = new PgDialect().sqlToQuery(arg)
    return { text: q.sql.replace(/\s+/g, ' '), params: q.params }
  }
  return { svc, execute, compiled }
}

/** A stub whose ANY query fails the test (the malformed-id paths must not reach SQL). */
function noQueryHarness() {
  const execute = vi.fn(async () => {
    expect.fail('no query may run for a malformed id')
  })
  return {
    svc: bound(execute),
    execute,
  }
}

/**
 * `loadRoster`'s three answers: the roster (SEN_1 in team A, SEN_2 in team B), then no manual
 * exclusions and no projects.
 */
const ROSTER: Array<Rows> = [
  [
    { id: SEN_1, technical_roles: ['BACKEND_ENGINEER'], team_ids: [TEAM_A], skills: ['Go'] },
    { id: SEN_2, technical_roles: ['DATA_ENGINEER'], team_ids: [TEAM_B], skills: null },
  ],
  [],
  [],
]
const SEN_1_VERSIONS = {
  seniorId: SEN_1,
  profile: profileVersion({
    seniorId: SEN_1,
    roles: ['BACKEND_ENGINEER'],
    teamIds: [TEAM_A],
    skills: ['Go'],
  }),
  exclusion: exclusionVersion([]),
}
const teamAScope: JobQueueScope = {
  kind: 'TEAM',
  teamId: TEAM_A,
  seniorIds: [SEN_1],
  versions: [SEN_1_VERSIONS],
  // opportunityInputsVersion of no studio keyword at 'eval.2+l1.1+rf.3' (SR-M-1).
  inputsVersion: 'dd02431ea7372350c25afdc278d40766',
  // The same at 'eval.2+l1.1+rf.2' (the previous record format under the live rule, CR-M-2).
  previousInputsVersion: 'dac620afd016fc7d93d75786bb94155b',
}

async function expectCode(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const e: unknown = await p.then(
    () => new Error('expected a rejection'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  expect((e as HttpException).getStatus()).toBe(status)
  expect(((e as HttpException).getResponse() as { code: string }).code).toBe(code)
}

describe('JobQueueScopeService.liveVersions', () => {
  it('a TEAM scope answers from its own resolve, with no query', async () => {
    const { svc, execute } = harness()
    await expect(svc.liveVersions(teamAScope)).resolves.toEqual([SEN_1_VERSIONS])
    expect(execute).not.toHaveBeenCalled()
  })

  it('a NONE scope has none, with no query', async () => {
    const { svc, execute } = harness()
    await expect(svc.liveVersions(NONE_SCOPE)).resolves.toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })

  it('STUDIO reads every roster senior', async () => {
    const { svc, execute } = harness(...ROSTER)
    const versions = await svc.liveVersions(STUDIO_SCOPE)
    expect(versions.map((v) => v.seniorId)).toEqual([SEN_1, SEN_2])
    expect(versions[0]).toEqual(SEN_1_VERSIONS)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('STUDIO fails closed when the roster cannot be read', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { svc } = harness(new Error('connection lost'))
    await expectCode(svc.liveVersions(STUDIO_SCOPE), 503, 'JOB_QUEUE_POLICY_UNAVAILABLE')
  })
})

describe('JobQueueScopeService.triagePolicyVersion (backlog 425)', () => {
  it("folds the versions with the live SENIOR teams' active membership digest", async () => {
    const { svc, compiled } = harness([{ digest: 'abc' }])
    const version = await svc.triagePolicyVersion([SEN_1_VERSIONS])
    expect(version).toBe(triagePolicyVersion([SEN_1_VERSIONS], 'abc'))
    expect(compiled(0).text).toContain(
      "WHERE tm.left_at IS NULL AND t.archived_at IS NULL AND t.type = 'SENIOR'",
    )
    expect(compiled(0).text).toContain('ORDER BY tm.team_id, tm.user_id')
  })

  it('fails closed when the membership cannot be read', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { svc } = harness(new Error('connection lost'))
    await expectCode(svc.triagePolicyVersion([]), 503, 'JOB_QUEUE_POLICY_UNAVAILABLE')
  })

  it('fails closed when the aggregate answers no digest', async () => {
    await expectCode(harness([]).svc.triagePolicyVersion([]), 503, 'JOB_QUEUE_POLICY_UNAVAILABLE')
    await expectCode(
      harness([{ digest: null }]).svc.triagePolicyVersion([]),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('JobQueueScopeService.resolve', () => {
  it.each(['SENIOR', 'JUNIOR', 'ACCOUNTANT', 'DROP'] as const)(
    '%s is a 403 and touches no data',
    async (role) => {
      const { svc, execute } = harness()
      await expect(svc.resolve(user(role))).rejects.toBeInstanceOf(ForbiddenException)
      await expect(svc.resolve(user(role), TEAM_A)).rejects.toBeInstanceOf(ForbiddenException)
      expect(execute).not.toHaveBeenCalled()
    },
  )

  it('ADMIN without a team is the STUDIO scope, without a query', async () => {
    const { svc, execute } = harness()
    await expect(svc.resolve(user('ADMIN'))).resolves.toEqual(STUDIO_SCOPE)
    expect(execute).not.toHaveBeenCalled()
  })

  it('ADMIN naming a live team gets that TEAM scope with its seniors and their live versions', async () => {
    const { svc, compiled, execute } = harness([{ id: TEAM_A }], ...ROSTER)
    await expect(svc.resolve(user('ADMIN'), TEAM_A)).resolves.toEqual(teamAScope)
    const team = compiled(0)
    expect(team.text).toContain('FROM teams t WHERE t.id = $1::uuid')
    expect(team.text).toContain("t.archived_at IS NULL AND t.type = 'SENIOR'")
    expect(team.params).toEqual([TEAM_A])
    // team lookup + loadRoster's roster, exclusions, projects
    expect(execute).toHaveBeenCalledTimes(4)
  })

  it('ADMIN naming a team in uppercase gets the same (canonical) team', async () => {
    const { svc, compiled } = harness([{ id: TEAM_A }], ...ROSTER)
    await expect(svc.resolve(user('ADMIN'), TEAM_A.toUpperCase())).resolves.toEqual(teamAScope)
    expect(compiled(0).params).toEqual([TEAM_A])
  })

  it('ADMIN naming a malformed team id is NONE, and no query runs (PANEL-GLM-1/5)', async () => {
    const { svc, execute } = noQueryHarness()
    await expect(svc.resolve(user('ADMIN'), 'not-a-uuid')).resolves.toEqual(NONE_SCOPE)
    expect(execute).not.toHaveBeenCalled()
  })

  it('HR naming a malformed team id is NONE, and no query runs', async () => {
    const { svc, execute } = noQueryHarness()
    await expect(svc.resolve(user('HR'), "x'; DROP TABLE teams; --")).resolves.toEqual(NONE_SCOPE)
    expect(execute).not.toHaveBeenCalled()
  })

  it('ADMIN naming an archived / unknown team is NONE, and no roster is read', async () => {
    const { svc, execute } = harness([])
    await expect(svc.resolve(user('ADMIN'), TEAM_A)).resolves.toEqual(NONE_SCOPE)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('HR without a team defaults to the first active team in stable order', async () => {
    const hr = user('HR', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const { svc, compiled } = harness([{ id: TEAM_B }, { id: TEAM_A }], ...ROSTER)
    const scope = await svc.resolve(hr)
    expect(scope).toMatchObject({ kind: 'TEAM', teamId: TEAM_B, seniorIds: [SEN_2] })
    const teams = compiled(0)
    expect(teams.text).toContain('tm.user_id = $1::uuid AND tm.left_at IS NULL')
    expect(teams.text).toContain("t.archived_at IS NULL AND t.type = 'SENIOR'")
    expect(teams.text).toContain('ORDER BY t.created_at, t.id')
    expect(teams.params).toEqual([hr.id])
  })

  it('HR naming one of their teams (any case) gets it, with only that team’s seniors', async () => {
    const { svc } = harness([{ id: TEAM_B }, { id: TEAM_A }], ...ROSTER)
    await expect(svc.resolve(user('HR'), TEAM_A.toUpperCase())).resolves.toEqual(teamAScope)
  })

  it('a team with no matchable senior has empty seniors and versions', async () => {
    const { svc, execute } = harness([{ id: TEAM_A }], [], [], [])
    await expect(svc.resolve(user('HR'), TEAM_A)).resolves.toEqual({
      kind: 'TEAM',
      teamId: TEAM_A,
      seniorIds: [],
      versions: [],
      inputsVersion: 'dd02431ea7372350c25afdc278d40766',
      previousInputsVersion: 'dac620afd016fc7d93d75786bb94155b',
    })
    // The team lookup, then loadRoster's three reads: it no longer stops early on an empty roster.
    expect(execute).toHaveBeenCalledTimes(4)
  })

  it('SR-M-1: the scope carries the live inputs version of the studio keywords, even with no senior', async () => {
    const studioPhp = {
      id: 'x1',
      senior_id: null,
      kind: 'KEYWORD',
      value: 'php',
      normalized_value: 'php',
      created_at: '2026-01-01T00:00:00.000Z',
    }
    const { svc } = harness([{ id: TEAM_A }], [], [studioPhp], [])
    await expect(svc.resolve(user('HR'), TEAM_A)).resolves.toMatchObject({
      kind: 'TEAM',
      seniorIds: [],
      // opportunityInputsVersion of the keyword 'php' at 'eval.2+l1.1+rf.3'.
      inputsVersion: '58f9e61b8c2607d99acfc2f494e07588',
      // The same keyword at 'eval.2+l1.1+rf.2' (CR-M-2).
      previousInputsVersion: '6591cd61d2c4323d7546115c807bca4f',
    })
  })

  it('HR naming a foreign team is NONE (not 403/404), and no roster is read', async () => {
    const { svc, execute } = harness([{ id: TEAM_B }])
    await expect(svc.resolve(user('HR'), TEAM_A)).resolves.toEqual(NONE_SCOPE)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('HR with no active team is NONE', async () => {
    const { svc } = harness([])
    await expect(svc.resolve(user('HR'))).resolves.toEqual(NONE_SCOPE)
  })

  it('answers JOB_QUEUE_POLICY_UNAVAILABLE (503) and logs when the roster cannot be read', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await expectCode(
      harness(new Error('db down')).svc.resolve(user('HR')),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
    expect(log).toHaveBeenCalledWith('queue policy evaluation failed: Error')
    await expectCode(
      harness([{ id: TEAM_A }], new TypeError('roster gone')).svc.resolve(user('ADMIN'), TEAM_A),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
    expect(log).toHaveBeenLastCalledWith('queue policy evaluation failed: TypeError')
  })

  it('a deadlock passes through unlogged, for the writer to rerun: it says nothing about policy', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const deadlock = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    })
    await expect(harness(deadlock).svc.resolve(user('HR'))).rejects.toBe(deadlock)
    expect(log).not.toHaveBeenCalled()
  })

  it('a non-Error rejection is still logged (its type only) and answered 503', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const execute = vi.fn(async () => Promise.reject('boom'))
    const svc = bound(execute)
    await expectCode(svc.resolve(user('HR')), 503, 'JOB_QUEUE_POLICY_UNAVAILABLE')
    expect(log).toHaveBeenCalledWith('queue policy evaluation failed: string')
  })

  it('a drizzle query error logs classes and SQLSTATE, never its SQL / params message (SR-L-3)', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const failure = new DrizzleQueryError(
      `Failed query: SELECT t.id FROM teams t WHERE t.id = $1\nparams: ${TEAM_A},${SEN_1}`,
      Object.assign(new DatabaseError('invalid input syntax for type uuid'), { code: '22P02' }),
    )
    await expectCode(
      harness([{ id: TEAM_A }], failure).svc.resolve(user('HR'), TEAM_A),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
    expect(log).toHaveBeenCalledWith(
      'queue policy evaluation failed: DrizzleQueryError, cause DatabaseError, cause code 22P02',
    )
    const line = String(log.mock.calls[0]?.[0])
    expect(line).not.toContain('params:')
    expect(line).not.toContain(TEAM_A)
    expect(line).not.toContain(SEN_1)
  })
})

class DrizzleQueryError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause })
  }
}
class DatabaseError extends Error {}

describe('JobQueueScopeService.resolveView / resolveWrite (task-hr-queue-all-teams)', () => {
  const hr = user('HR', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const teamBScope = { kind: 'TEAM', teamId: TEAM_B, seniorIds: [SEN_2] }

  it('an HR of two live teams who names none reads the union of both, in their team order', async () => {
    const { svc, execute, compiled } = harness([{ id: TEAM_A }, { id: TEAM_B }], ...ROSTER)
    const scope = await svc.resolveView(hr)
    expect(scope.kind).toBe('TEAMS')
    const teams = (scope as Extract<JobQueueViewScope, { kind: 'TEAMS' }>).teams
    expect(teams[0]).toEqual(teamAScope)
    expect(teams[1]).toMatchObject(teamBScope)
    expect(teams).toHaveLength(2)
    expect(compiled(0).params).toEqual([hr.id])
    // the HR's teams once, then loadRoster's three reads: no second resolve
    expect(execute).toHaveBeenCalledTimes(4)
  })

  it('an HR of one live team reads that TEAM scope, never a union', async () => {
    const { svc } = harness([{ id: TEAM_A }], [{ id: TEAM_A }], ...ROSTER)
    await expect(svc.resolveView(hr)).resolves.toEqual(teamAScope)
  })

  it('an HR who names a team reads only that team, without asking for a union', async () => {
    const { svc, execute } = harness([{ id: TEAM_A }, { id: TEAM_B }], ...ROSTER)
    await expect(svc.resolveView(hr, TEAM_A)).resolves.toEqual(teamAScope)
    expect(execute).toHaveBeenCalledTimes(4)
  })

  it('an ADMIN without a team is STUDIO, without a query: a union is for an HR only', async () => {
    const { svc, execute } = noQueryHarness()
    await expect(svc.resolveView(user('ADMIN'))).resolves.toEqual(STUDIO_SCOPE)
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['SENIOR', 'JUNIOR', 'ACCOUNTANT'] as const)(
    '%s is still a 403 from the union entry points, touching no data',
    async (role) => {
      const { svc, execute } = harness()
      await expect(svc.resolveView(user(role))).rejects.toBeInstanceOf(ForbiddenException)
      const pick = vi.fn()
      await expect(svc.resolveWrite(user(role), pick)).rejects.toBeInstanceOf(ForbiddenException)
      expect(pick).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    },
  )

  it('a write from the union names the one team its pick chooses', async () => {
    const { svc } = harness([{ id: TEAM_A }, { id: TEAM_B }], ...ROSTER)
    const pick = vi.fn(async (teams: readonly TeamScope[]) => teams[1] as TeamScope)
    const scope = await svc.resolveWrite(hr, pick)
    expect(scope).toMatchObject(teamBScope)
    expect(pick.mock.calls[0]?.[0].map((t) => t.teamId)).toEqual([TEAM_A, TEAM_B])
  })

  it('a write by an HR of one team, or naming a team, never asks the pick', async () => {
    const pick = vi.fn()
    const one = harness([{ id: TEAM_A }], [{ id: TEAM_A }], ...ROSTER)
    await expect(one.svc.resolveWrite(hr, pick)).resolves.toEqual(teamAScope)
    const named = harness([{ id: TEAM_A }, { id: TEAM_B }], ...ROSTER)
    await expect(named.svc.resolveWrite(hr, pick, TEAM_A)).resolves.toEqual(teamAScope)
    expect(pick).not.toHaveBeenCalled()
  })

  it('a union answers the live versions of all its teams, with no query', async () => {
    const { svc, execute } = harness()
    const sen2 = { seniorId: SEN_2, profile: 'p2', exclusion: 'e2' }
    const union: JobQueueViewScope = {
      kind: 'TEAMS',
      teams: [
        teamAScope as TeamScope,
        { ...(teamAScope as TeamScope), teamId: TEAM_B, seniorIds: [SEN_2], versions: [sen2] },
      ],
    }
    await expect(svc.liveVersions(union)).resolves.toEqual([SEN_1_VERSIONS, sen2])
    expect(execute).not.toHaveBeenCalled()
  })

  it('a union lists each senior once, sorted by senior id whatever the team order', async () => {
    const { svc } = harness()
    const sen2 = { seniorId: SEN_2, profile: 'p2', exclusion: 'e2' }
    const teamA = teamAScope as TeamScope
    const union: JobQueueViewScope = {
      kind: 'TEAMS',
      teams: [
        { ...teamA, teamId: TEAM_B, seniorIds: [SEN_2], versions: [sen2] },
        { ...teamA, seniorIds: [SEN_1, SEN_2], versions: [SEN_1_VERSIONS, sen2] },
      ],
    }
    await expect(svc.liveVersions(union)).resolves.toEqual([SEN_1_VERSIONS, sen2])
  })
})

describe('describeFailure', () => {
  it.each([
    [new Error('secret'), 'Error'],
    [new Error('x', { cause: new TypeError('y') }), 'Error, cause TypeError'],
    // wrapper with a cause code (drizzle over pg); the SQL / params message never appears
    [
      new DrizzleQueryError(
        'Failed query: x\nparams: secret',
        Object.assign(new DatabaseError('m'), { code: '22P02' }),
      ),
      'DrizzleQueryError, cause DatabaseError, cause code 22P02',
    ],
    [new Error('x', { cause: { code: '57P01' } }), 'Error, cause code 57P01'],
    // raw pg error with its own code (SR-L-5)
    [
      Object.assign(new DatabaseError('duplicate key value (secret)'), { code: '23505' }),
      'DatabaseError, code 23505',
    ],
    // own code and cause code both present
    [
      Object.assign(new Error('x', { cause: { code: '40001' } }), { code: '08006' }),
      'Error, code 08006, cause code 40001',
    ],
    // both absent / not strings
    [new Error('x', { cause: { code: 57 } }), 'Error'],
    [Object.assign(new Error('x'), { code: 23505 }), 'Error'],
    // SR-L-6: only a SQLSTATE / errno shape is logged, a free-text `code` is not
    [Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'Error, code ECONNRESET'],
    [Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_01' }), 'Error, code ERR_TLS_CERT_01'],
    [Object.assign(new Error('x'), { code: 'A'.repeat(32) }), `Error, code ${'A'.repeat(32)}`],
    [Object.assign(new Error('x'), { code: 'A'.repeat(33) }), 'Error'],
    [Object.assign(new Error('x'), { code: '' }), 'Error'],
    [Object.assign(new Error('x'), { code: 'secret@example.test' }), 'Error'],
    [Object.assign(new Error('x'), { code: 'lowercase' }), 'Error'],
    [Object.assign(new Error('x'), { code: ' 23505' }), 'Error'],
    [Object.assign(new Error('x'), { code: '23505 ' }), 'Error'],
    [Object.assign(new Error('x'), { code: '23505\nparams: secret' }), 'Error'],
    [new Error('x', { cause: { code: 'params: secret' } }), 'Error'],
    [new Error('x', { cause: null }), 'Error'],
    [new Error('x', { cause: 'text' }), 'Error'],
    [42, 'number'],
    [undefined, 'undefined'],
  ])('%#: %s -> %j', (err, expected) => {
    expect(describeFailure(err)).toBe(expected)
  })
})

describe('JobQueueScopeService.assertVisible', () => {
  it('NONE is the 404 without a query', async () => {
    const { svc, execute } = noQueryHarness()
    await expectCode(svc.assertVisible(NONE_SCOPE, OPP), 404, 'JOB_OPPORTUNITY_NOT_FOUND')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['not-a-uuid', '', `${OPP}'`])(
    'a malformed opportunity id %j is the same 404, and no query runs (CR-M-1)',
    async (bad) => {
      const { svc, execute } = noQueryHarness()
      await expectCode(svc.assertVisible(teamAScope, bad), 404, 'JOB_OPPORTUNITY_NOT_FOUND')
      await expectCode(svc.assertVisible(STUDIO_SCOPE, bad), 404, 'JOB_OPPORTUNITY_NOT_FOUND')
      expect(execute).not.toHaveBeenCalled()
    },
  )

  it('no visible row is the same 404 (not mine == does not exist)', async () => {
    const { svc } = harness([])
    await expectCode(svc.assertVisible(teamAScope, OPP), 404, 'JOB_OPPORTUNITY_NOT_FOUND')
  })

  it('a visible row passes, and the query carries the scope predicate for that id', async () => {
    const { svc, compiled } = harness([{ visible: 1 }])
    await expect(svc.assertVisible(teamAScope, OPP)).resolves.toBeUndefined()
    const q = compiled(0)
    expect(q.text).toContain('FROM job_opportunities o WHERE o.id = $1::uuid AND ((((EXISTS')
    expect(q.text).toContain('job_opportunity_team_triage g')
    expect(q.params[0]).toBe(OPP)
    expect(q.params).toContain(TEAM_A)
  })

  it('r5 Task 6.4: the check refuses a suppressed opportunity, bound to the same id', async () => {
    const { svc, compiled } = harness([{ visible: 1 }])
    await svc.assertVisible(teamAScope, OPP)
    const q = compiled(0)
    const n = q.params.length
    expect(q.text.replace(/\s+/g, ' ')).toContain(
      `AND NOT EXISTS (SELECT 1 FROM job_queue_actions sup WHERE sup.opportunity_id = $${n}::uuid AND sup.kind = 'SUPPRESSED'))`,
    )
    expect(q.params[n - 1]).toBe(OPP)
  })

  it('an uppercase opportunity id is queried in canonical lowercase', async () => {
    const { svc, compiled } = harness([{ visible: 1 }])
    await expect(svc.assertVisible(STUDIO_SCOPE, OPP.toUpperCase())).resolves.toBeUndefined()
    expect(compiled(0).params).toEqual([OPP])
  })

  it('STUDIO checks existence only', async () => {
    const { svc, compiled } = harness([{ visible: 1 }])
    await expect(svc.assertVisible(STUDIO_SCOPE, OPP)).resolves.toBeUndefined()
    expect(compiled(0).text).toContain('WHERE o.id = $1::uuid AND TRUE')
  })

  it('answers 503 and logs when visibility cannot be evaluated — never "visible"', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await expectCode(
      harness(new Error('db down')).svc.assertVisible(teamAScope, OPP),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('JobQueueScopeService read inside a write transaction (r5 Task 6.3)', () => {
  it('resolve runs every query on the executor it is given, none on the pool', async () => {
    const { svc, execute: pool } = noQueryHarness()
    const answers: Rows[] = [[{ id: TEAM_A }], ...ROSTER]
    const tx = { execute: vi.fn(async () => ({ rows: answers.shift() ?? [] })) }
    const scope = await svc.resolve(user('ADMIN'), TEAM_A, tx)
    expect(scope).toMatchObject({ kind: 'TEAM', teamId: TEAM_A, seniorIds: [SEN_1] })
    expect(tx.execute).toHaveBeenCalledTimes(4)
    expect(pool).not.toHaveBeenCalled()
  })

  it('resolve for an HR reads the active teams on that executor too', async () => {
    const { svc, execute: pool } = noQueryHarness()
    const answers: Rows[] = [[{ id: TEAM_A }], ...ROSTER]
    const tx = { execute: vi.fn(async () => ({ rows: answers.shift() ?? [] })) }
    await svc.resolve(user('HR'), undefined, tx)
    expect(tx.execute).toHaveBeenCalledTimes(4)
    expect(pool).not.toHaveBeenCalled()
  })

  it('assertVisible asks the executor it is given', async () => {
    const { svc, execute: pool } = noQueryHarness()
    const tx = { execute: vi.fn(async () => ({ rows: [{ visible: 1 }] })) }
    await svc.assertVisible(STUDIO_SCOPE, OPP, tx)
    expect(tx.execute).toHaveBeenCalledTimes(1)
    expect(pool).not.toHaveBeenCalled()
  })
})

describe('JobQueueScopeService.dismissalOwner (task-hr-queue-all-teams)', () => {
  const teamA = teamAScope as TeamScope
  const teamB: TeamScope = { ...teamA, teamId: TEAM_B, seniorIds: [SEN_2] }

  it('the team holding a live TEAM dismissal of the item, asked only among the union teams', async () => {
    const { svc, execute, compiled } = harness([{ team_id: TEAM_B }])
    await expect(svc.dismissalOwner([teamA, teamB], OPP)).resolves.toBe(teamB)
    expect(execute).toHaveBeenCalledTimes(1)
    const q = compiled(0)
    expect(q.text).toContain(
      "FROM job_queue_dismissals d WHERE d.opportunity_id = $1::uuid AND d.scope_kind = 'TEAM' AND d.undone_at IS NULL AND (d.team_id = $2::uuid OR d.team_id = $3::uuid)",
    )
    expect(q.params).toEqual([OPP, TEAM_A, TEAM_B])
  })

  it('no live dismissal: the first team that sees the item', async () => {
    const { svc, execute } = harness([], [], [{ visible: 1 }])
    await expect(svc.dismissalOwner([teamA, teamB], OPP)).resolves.toBe(teamB)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('a malformed id runs no query and names the first team', async () => {
    const { svc, execute } = noQueryHarness()
    await expect(svc.dismissalOwner([teamA, teamB], 'not-a-uuid')).resolves.toBe(teamA)
    expect(execute).not.toHaveBeenCalled()
  })
})
