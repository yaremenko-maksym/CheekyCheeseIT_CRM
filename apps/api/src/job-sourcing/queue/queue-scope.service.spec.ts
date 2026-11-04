import { ForbiddenException, HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import { NONE_SCOPE, STUDIO_SCOPE } from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * Unit double for the mutation gate (it cannot run `*.integration.spec.ts`): the DB is a scripted
 * `execute`, each call answering the next queued row set. The real SQL is pinned against Postgres
 * by `queue-scope.integration.spec.ts`.
 */
const TEAM_A = '11111111-1111-4111-8111-111111111111'
const TEAM_B = '22222222-2222-4222-8222-222222222222'
const SEN_1 = '33333333-3333-4333-8333-333333333333'
const OPP = '44444444-4444-4444-8444-444444444444'
const user = (role: SessionUser['role'], id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') =>
  ({ id, role, email: 'x@example.test' }) as SessionUser

function harness(...answers: Array<Array<Record<string, unknown>> | Error>) {
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

async function expectCode(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const e: unknown = await p.then(
    () => new Error('expected a rejection'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  expect((e as HttpException).getStatus()).toBe(status)
  expect(((e as HttpException).getResponse() as { code: string }).code).toBe(code)
}

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

  it('ADMIN naming a live team gets that TEAM scope with its seniors', async () => {
    const { svc, compiled } = harness([{ id: TEAM_A }], [{ id: SEN_1 }])
    await expect(svc.resolve(user('ADMIN'), TEAM_A)).resolves.toEqual({
      kind: 'TEAM',
      teamId: TEAM_A,
      seniorIds: [SEN_1],
    })
    const team = compiled(0)
    expect(team.text).toContain('FROM teams t WHERE t.id = $1::uuid')
    expect(team.text).toContain("t.archived_at IS NULL AND t.type = 'SENIOR'")
    expect(team.params).toEqual([TEAM_A])
    const seniors = compiled(1)
    expect(seniors.text).toContain('tm.team_id = $1::uuid AND tm.left_at IS NULL')
    expect(seniors.text).toContain("u.role = 'SENIOR' AND u.archived_at IS NULL")
    expect(seniors.text).toContain('ORDER BY u.id')
    expect(seniors.params).toEqual([TEAM_A])
  })

  it('ADMIN naming an archived / unknown team is NONE, and no roster is read', async () => {
    const { svc, execute } = harness([])
    await expect(svc.resolve(user('ADMIN'), TEAM_A)).resolves.toEqual(NONE_SCOPE)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('HR without a team defaults to the first active team in stable order', async () => {
    const hr = user('HR', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const { svc, compiled } = harness([{ id: TEAM_B }, { id: TEAM_A }], [])
    await expect(svc.resolve(hr)).resolves.toEqual({ kind: 'TEAM', teamId: TEAM_B, seniorIds: [] })
    const teams = compiled(0)
    expect(teams.text).toContain('tm.user_id = $1::uuid AND tm.left_at IS NULL')
    expect(teams.text).toContain("t.archived_at IS NULL AND t.type = 'SENIOR'")
    expect(teams.text).toContain('ORDER BY t.created_at, t.id')
    expect(teams.params).toEqual([hr.id])
    expect(compiled(1).params).toEqual([TEAM_B])
  })

  it('HR naming one of their teams gets it', async () => {
    const { svc } = harness([{ id: TEAM_B }, { id: TEAM_A }], [{ id: SEN_1 }])
    await expect(svc.resolve(user('HR'), TEAM_A)).resolves.toEqual({
      kind: 'TEAM',
      teamId: TEAM_A,
      seniorIds: [SEN_1],
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

  it('fails closed with JOB_QUEUE_POLICY_UNAVAILABLE (503) when the roster cannot be read', async () => {
    await expectCode(
      harness(new Error('db down')).svc.resolve(user('HR')),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
    await expectCode(
      harness([{ id: TEAM_A }], new Error('db down')).svc.resolve(user('ADMIN'), TEAM_A),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
  })
})

describe('JobQueueScopeService.assertVisible', () => {
  const teamA = { kind: 'TEAM' as const, teamId: TEAM_A, seniorIds: [] }

  it('NONE is the 404 without a query', async () => {
    const { svc, execute } = harness()
    await expectCode(svc.assertVisible(NONE_SCOPE, OPP), 404, 'JOB_OPPORTUNITY_NOT_FOUND')
    expect(execute).not.toHaveBeenCalled()
  })

  it('no visible row is the same 404 (not mine == does not exist)', async () => {
    const { svc } = harness([])
    await expectCode(svc.assertVisible(teamA, OPP), 404, 'JOB_OPPORTUNITY_NOT_FOUND')
  })

  it('a visible row passes, and the query carries the scope predicate for that id', async () => {
    const { svc, compiled } = harness([{ visible: 1 }])
    await expect(svc.assertVisible(teamA, OPP)).resolves.toBeUndefined()
    const q = compiled(0)
    expect(q.text).toContain('FROM job_opportunities o WHERE o.id = $1::uuid AND (EXISTS')
    expect(q.text).toContain('job_opportunity_team_triage g')
    expect(q.params).toEqual([OPP, OPP, TEAM_A, OPP, TEAM_A])
  })

  it('STUDIO checks existence only', async () => {
    const { svc, compiled } = harness([{ visible: 1 }])
    await expect(svc.assertVisible(STUDIO_SCOPE, OPP)).resolves.toBeUndefined()
    expect(compiled(0).text).toContain('WHERE o.id = $1::uuid AND TRUE')
  })

  it('fails closed (503) when visibility cannot be evaluated — never "visible"', async () => {
    await expectCode(
      harness(new Error('db down')).svc.assertVisible(teamA, OPP),
      503,
      'JOB_QUEUE_POLICY_UNAVAILABLE',
    )
  })
})
