import { ForbiddenException, HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const assertSeniorEligible = vi.fn()
const loadOpportunity = vi.fn()
const loadSeniorsExclusions = vi.fn()
vi.mock('../job-sourcing/queue/senior-eligibility', async (orig) => ({
  ...(await orig<object>()),
  assertSeniorEligible: (...a: unknown[]) => assertSeniorEligible(...a),
}))
vi.mock('../job-sourcing/runtime/recompute-inputs', async (orig) => ({
  ...(await orig<object>()),
  loadOpportunity: (...a: unknown[]) => loadOpportunity(...a),
  loadSeniorsExclusions: (...a: unknown[]) => loadSeniorsExclusions(...a),
}))

const { authorizeSenior, visibleSeniors } = await import('./tailored-access')

const OPP = '0b5e0000-0000-4000-8000-0000000000a1'
const S1 = '0b5e0000-0000-4000-8000-000000000001'
const S2 = '0b5e0000-0000-4000-8000-000000000002'
const S3 = '0b5e0000-0000-4000-8000-000000000003'
const TEAM = { kind: 'TEAM', teamId: 't', seniorIds: [S1, S2], versions: [] } as const
const hr = { id: 'h', role: 'HR' } as SessionUser
const tx = { execute: vi.fn() }

function scopesFake(scope: unknown = TEAM) {
  const scopes = {
    resolve: vi.fn(async (_u?: unknown, _t?: unknown, _d?: unknown) => scope),
    // single-team fake: the union entry points answer exactly what `resolve` answers
    resolveView: vi.fn((u?: unknown, t?: unknown, d?: unknown) => scopes.resolve(u, t, d)),
    resolveWrite: vi.fn((u?: unknown, t?: unknown, d?: unknown) => scopes.resolve(u, t, d)),
    assertVisible: vi.fn(async () => undefined),
    liveVersions: vi.fn(async () => [{ seniorId: S1 }, { seniorId: S2 }, { seniorId: S3 }]),
    policy: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  }
  return scopes
}

const status = (fn: () => Promise<unknown>) =>
  fn().then(
    () => 'ok',
    (e: unknown) => (e instanceof HttpException ? e.getStatus() : String(e)),
  )

beforeEach(() => vi.clearAllMocks())

describe('authorizeSenior', () => {
  it('resolves the scope in the tx, checks visibility then eligibility, and returns the scope', async () => {
    const scopes = scopesFake()
    const got = await authorizeSenior(scopes as never, hr, OPP, S1, 'team-1', tx as never)
    expect(got).toBe(TEAM)
    expect(scopes.resolve).toHaveBeenCalledWith(hr, 'team-1', tx)
    expect(scopes.assertVisible).toHaveBeenCalledWith(TEAM, OPP, tx)
    expect(assertSeniorEligible).toHaveBeenCalledWith(scopes, tx, TEAM, S1, OPP)
  })

  it('a NONE scope is the uniform 404 before visibility or eligibility', async () => {
    const scopes = scopesFake({ kind: 'NONE' })
    const err = await authorizeSenior(scopes as never, hr, OPP, S1, undefined, tx as never).catch(
      (e: unknown) => e,
    )
    expect((err as HttpException).getStatus()).toBe(404)
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'JOB_OPPORTUNITY_NOT_FOUND',
    })
    expect(scopes.assertVisible).not.toHaveBeenCalled()
    expect(assertSeniorEligible).not.toHaveBeenCalled()
  })

  it('a malformed senior id is the 404 before any eligibility query; an upper-case id is canonical', async () => {
    const scopes = scopesFake()
    expect(
      await status(() => authorizeSenior(scopes as never, hr, OPP, 'x', undefined, tx as never)),
    ).toBe(404)
    expect(assertSeniorEligible).not.toHaveBeenCalled()
    await authorizeSenior(scopes as never, hr, OPP, S1.toUpperCase(), undefined, tx as never)
    expect(assertSeniorEligible).toHaveBeenCalledWith(scopes, tx, TEAM, S1, OPP)
  })

  it('a role refusal from resolve passes through as 403', async () => {
    const scopes = scopesFake()
    scopes.resolve.mockRejectedValueOnce(new ForbiddenException())
    expect(
      await status(() => authorizeSenior(scopes as never, hr, OPP, S1, undefined, tx as never)),
    ).toBe(403)
  })
})

describe('visibleSeniors', () => {
  const posting = { canonical: { companyName: 'Globex', fields: { title: 'Dev' } } }

  it('keeps live seniors only, drops the stop-listed one, and reads exclusions once for the set', async () => {
    const scopes = scopesFake()
    loadOpportunity.mockResolvedValueOnce(posting)
    loadSeniorsExclusions.mockResolvedValueOnce([
      { seniorId: S2, kind: 'COMPANY', normalizedValue: 'globex', value: 'Globex' },
    ])
    const outside = '0b5e0000-0000-4000-8000-000000000009'
    const got = await visibleSeniors(
      scopes as never,
      TEAM as never,
      OPP,
      [S1, S2, outside],
      tx as never,
    )
    expect(got).toEqual([S1])
    expect(loadSeniorsExclusions).toHaveBeenCalledTimes(1)
    expect(loadSeniorsExclusions).toHaveBeenCalledWith(tx, [S1, S2])
    expect(loadOpportunity).toHaveBeenCalledWith(tx, OPP)
  })

  it('answers [] without reading the opportunity when no id is live', async () => {
    const scopes = scopesFake()
    const got = await visibleSeniors(
      scopes as never,
      TEAM as never,
      OPP,
      ['0b5e0000-0000-4000-8000-00000000000f'],
      tx as never,
    )
    expect(got).toEqual([])
    expect(loadOpportunity).not.toHaveBeenCalled()
  })

  it('answers [] when the opportunity is gone', async () => {
    const scopes = scopesFake()
    loadOpportunity.mockResolvedValueOnce(null)
    expect(await visibleSeniors(scopes as never, TEAM as never, OPP, [S1], tx as never)).toEqual([])
  })

  it('a senior with an exclusion that does not match the posting stays visible', async () => {
    const scopes = scopesFake()
    loadOpportunity.mockResolvedValueOnce(posting)
    loadSeniorsExclusions.mockResolvedValueOnce([
      { seniorId: S1, kind: 'COMPANY', normalizedValue: 'initech', value: 'Initech' },
    ])
    expect(await visibleSeniors(scopes as never, TEAM as never, OPP, [S1], tx as never)).toEqual([
      S1,
    ])
  })
})
