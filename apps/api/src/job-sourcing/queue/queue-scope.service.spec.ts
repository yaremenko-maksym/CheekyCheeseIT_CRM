import { ForbiddenException, HttpException, Logger } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import { exclusionVersion, profileVersion } from '../runtime/recompute-inputs'
import { type JobQueueScope, NONE_SCOPE, STUDIO_SCOPE } from './queue-scope'
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

function harness(...answers: Array<Rows | Error>) {
  const execute = vi.fn(async () => {
    const next = answers.shift()
    if (next === undefined) throw new Error('unexpected query')
    if (next instanceof Error) throw next
    return { rows: next }
  })
  const svc = new JobQueueScopeService({ db: { execute } } as unknown as DatabaseService)
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
    svc: new JobQueueScopeService({ db: { execute } } as unknown as DatabaseService),
    execute,
  }
}

/**
 * `loadRoster`'s three answers: the roster (SEN_1 in team A, SEN_2 in team B), then no manual
 * exclusions and no projects.
 */
const ROSTER: Array<Rows> = [
  [
    { id: SEN_1, tech_stack: ['Go'], team_ids: [TEAM_A] },
    { id: SEN_2, tech_stack: ['Java'], team_ids: [TEAM_B] },
  ],
  [],
  [],
]
const SEN_1_VERSIONS = {
  seniorId: SEN_1,
  profile: profileVersion({ seniorId: SEN_1, techStack: ['Go'], teamIds: [TEAM_A] }),
  exclusion: exclusionVersion([]),
}
const teamAScope: JobQueueScope = {
  kind: 'TEAM',
  teamId: TEAM_A,
  seniorIds: [SEN_1],
  versions: [SEN_1_VERSIONS],
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
    })
    // The team lookup, then loadRoster's three reads: it no longer stops early on an empty roster.
    expect(execute).toHaveBeenCalledTimes(4)
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

  it('a non-Error rejection is still logged (its type only) and answered 503', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const execute = vi.fn(async () => Promise.reject('boom'))
    const svc = new JobQueueScopeService({ db: { execute } } as unknown as DatabaseService)
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
    expect(q.text).toContain('FROM job_opportunities o WHERE o.id = $1::uuid AND (EXISTS')
    expect(q.text).toContain('job_opportunity_team_triage g')
    expect(q.params[0]).toBe(OPP)
    expect(q.params).toContain(TEAM_A)
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
