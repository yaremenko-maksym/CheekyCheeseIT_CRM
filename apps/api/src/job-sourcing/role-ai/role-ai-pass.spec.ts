import type { TechnicalRole } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import {
  decideRoleAi,
  logRoleAiError,
  ROLE_AI_BACKOFF,
  ROLE_AI_CRON,
  ROLE_AI_MAX_ATTEMPTS,
  ROLE_AI_MAX_CONSECUTIVE_ERRORS,
  ROLE_AI_MIN_CONFIDENCE,
  ROLE_AI_PASS_LIMIT,
  ROLE_AI_REASON,
  type RoleAiCandidate,
  type RoleAiStore,
  type RoleAiTerminal,
  runRoleAiLoop,
} from './role-ai-pass'
import type { RoleAiReply, RoleClassifierInput } from './role-classifier.client'

const MIN = 60_000
const NOW = new Date('2026-11-17T10:00:00Z')
const TITLE = 'TITLE-MARKER-wizard'
const DESCRIPTION = 'DESCRIPTION-MARKER-text'

const candidate = (n: number, extra: Partial<RoleAiCandidate> = {}): RoleAiCandidate => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  title: `${TITLE}-${n}`,
  titleKey: `${TITLE.toLowerCase()}-${n}`,
  descriptionSha256: `sha-${n}`,
  description: `${DESCRIPTION}-${n}`,
  categories: ['backend'],
  ...extra,
})

type Applied = { id: string; terminal: RoleAiTerminal; writeCache: boolean }

function fakeStore(
  rows: readonly RoleAiCandidate[],
  opts: {
    cached?: Record<string, RoleAiTerminal>
    stale?: string[]
    candidatesThrow?: Error
    /** Calls the day's budget still admits; unlimited when absent. */
    budgetLeft?: number
    /** Rows recordFailure finds reclassified (returns false). */
    failureStale?: string[]
    failureThrows?: Error
  } = {},
) {
  const applied: Applied[] = []
  const failures: { id: string; now: Date }[] = []
  const asked: { now: Date; limit: number }[] = []
  const reserved: { now: Date; limit: number }[] = []
  const released: Date[] = []
  let left = opts.budgetLeft ?? Number.POSITIVE_INFINITY
  const store: RoleAiStore = {
    async candidates(now, limit) {
      asked.push({ now, limit })
      if (opts.candidatesThrow) throw opts.candidatesThrow
      return rows
    },
    async cached(c) {
      return opts.cached?.[c.id] ?? null
    },
    async applyTerminal(c, terminal, writeCache) {
      if (opts.stale?.includes(c.id)) return false
      applied.push({ id: c.id, terminal, writeCache })
      return true
    },
    async recordFailure(c, now) {
      if (opts.failureThrows) throw opts.failureThrows
      if (opts.failureStale?.includes(c.id)) return false
      failures.push({ id: c.id, now })
      return true
    },
    async reserveCall(now, limit) {
      reserved.push({ now, limit })
      if (left <= 0) return false
      left -= 1
      return true
    },
    async releaseCall(now) {
      released.push(now)
    },
  }
  return { store, applied, failures, asked, reserved, released }
}

function fakeClient(answer: (input: RoleClassifierInput, call: number) => RoleAiReply | Error) {
  const calls: RoleClassifierInput[] = []
  return {
    calls,
    client: {
      async classify(input: RoleClassifierInput): Promise<RoleAiReply> {
        calls.push(input)
        const r = answer(input, calls.length)
        if (r instanceof Error) throw r
        return r
      },
    },
  }
}

function fakeLog() {
  const lines: { level: string; line: unknown; stack?: string }[] = []
  return {
    lines,
    log: {
      log: (line: object) => lines.push({ level: 'log', line }),
      warn: (line: object) => lines.push({ level: 'warn', line }),
      error: (line: object, stack?: string) =>
        lines.push({ level: 'error', line, ...(stack === undefined ? {} : { stack }) }),
    },
  }
}

const ok = (roles: readonly TechnicalRole[], confidence: number): RoleAiReply => ({
  kind: 'ok',
  roles,
  confidence,
})

describe('role AI pass — constants', () => {
  it('bounds the pass and names its dirty reason', () => {
    expect(ROLE_AI_PASS_LIMIT).toBe(20)
    expect(ROLE_AI_MIN_CONFIDENCE).toBe(0.7)
    expect(ROLE_AI_CRON).toBe('*/10 * * * *')
    expect(ROLE_AI_REASON).toBe('ROLE_AI:rc.1')
  })

  it('caps attempts per key', () => {
    expect(ROLE_AI_MAX_ATTEMPTS).toBe(10)
  })

  it('ROLE_AI_BACKOFF doubles from 15 minutes and caps at 24 hours', () => {
    expect(ROLE_AI_BACKOFF(0)).toBe(15 * MIN)
    expect(ROLE_AI_BACKOFF(1)).toBe(30 * MIN)
    expect(ROLE_AI_BACKOFF(6)).toBe(960 * MIN)
    expect(ROLE_AI_BACKOFF(7)).toBe(1440 * MIN)
    expect(ROLE_AI_BACKOFF(40)).toBe(1440 * MIN)
  })
})

describe('decideRoleAi', () => {
  it('ok + confidence 0.7 with roles -> AI', () => {
    expect(decideRoleAi(ok(['BACKEND_ENGINEER', 'DEVOPS_ENGINEER'], 0.7))).toEqual({
      kind: 'terminal',
      terminal: { outcome: 'AI', roles: ['BACKEND_ENGINEER', 'DEVOPS_ENGINEER'], confidence: 0.7 },
    })
  })

  it('AI roles are written in the canonical order, not the model order', () => {
    expect(decideRoleAi(ok(['FRONTEND_ENGINEER', 'BACKEND_ENGINEER'], 0.9))).toMatchObject({
      terminal: { roles: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER'] },
    })
  })

  it('ok + confidence 0.69 -> UNCLEAR with no roles', () => {
    expect(decideRoleAi(ok(['BACKEND_ENGINEER'], 0.69))).toEqual({
      kind: 'terminal',
      terminal: { outcome: 'UNCLEAR', roles: [], confidence: 0.69 },
    })
  })

  it('ok + empty roles -> UNCLEAR, whatever the confidence', () => {
    expect(decideRoleAi(ok([], 0.99))).toEqual({
      kind: 'terminal',
      terminal: { outcome: 'UNCLEAR', roles: [], confidence: 0.99 },
    })
  })

  it('NOT_CONFIGURED stops without a failure', () => {
    expect(decideRoleAi({ kind: 'unavailable', reason: 'NOT_CONFIGURED' }).kind).toBe(
      'not-configured',
    )
  })

  it.each(['INVALID_OUTPUT', 'INVALID_INPUT'] as const)(
    '%s fails and the pass continues',
    (reason) => {
      expect(decideRoleAi({ kind: 'unavailable', reason })).toMatchObject({
        kind: 'failed',
        stop: false,
      })
    },
  )

  it.each(['PROVIDER_ERROR', 'TIMEOUT', 'RATE_LIMITED'] as const)(
    '%s fails and stops the pass (the circuit)',
    (reason) => {
      expect(decideRoleAi({ kind: 'unavailable', reason })).toMatchObject({
        kind: 'failed',
        stop: true,
      })
    },
  )
})

describe('runRoleAiLoop', () => {
  const run = (
    s: ReturnType<typeof fakeStore>,
    c: ReturnType<typeof fakeClient>,
    l: ReturnType<typeof fakeLog>,
    dailyBudget = 50,
  ) =>
    runRoleAiLoop({
      store: s.store,
      client: c.client,
      log: l.log,
      now: NOW,
      limit: 7,
      dailyBudget,
    })

  it('asks the store for candidates at the pass clock and limit', async () => {
    const s = fakeStore([])
    await run(
      s,
      fakeClient(() => ok([], 1)),
      fakeLog(),
    )
    expect(s.asked).toEqual([{ now: NOW, limit: 7 }])
  })

  it('classifies each candidate and writes the cache with the answer', async () => {
    const s = fakeStore([candidate(1), candidate(2)])
    const c = fakeClient((_i, n) => (n === 1 ? ok(['BACKEND_ENGINEER'], 0.9) : ok([], 0.4)))
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 1,
      unclear: 1,
      failed: 0,
      stoppedBy: null,
    })
    expect(c.calls[0]).toEqual({
      title: `${TITLE}-1`,
      description: `${DESCRIPTION}-1`,
      categories: ['backend'],
    })
    expect(s.applied).toEqual([
      {
        id: candidate(1).id,
        terminal: { outcome: 'AI', roles: ['BACKEND_ENGINEER'], confidence: 0.9 },
        writeCache: true,
      },
      {
        id: candidate(2).id,
        terminal: { outcome: 'UNCLEAR', roles: [], confidence: 0.4 },
        writeCache: true,
      },
    ])
    expect(l.lines).toContainEqual({
      level: 'log',
      line: {
        event: 'ROLE_AI_PASS',
        candidates: 2,
        classified: 1,
        unclear: 1,
        failed: 0,
        stoppedBy: null,
      },
    })
  })

  it('a terminal cache row is applied without a model call and without a cache write', async () => {
    const cachedAnswer: RoleAiTerminal = { outcome: 'AI', roles: ['QA_ENGINEER'], confidence: null }
    const s = fakeStore([candidate(1)], { cached: { [candidate(1).id]: cachedAnswer } })
    const c = fakeClient(() => ok([], 1))
    await expect(run(s, c, fakeLog())).resolves.toMatchObject({ classified: 1 })
    expect(c.calls).toHaveLength(0)
    expect(s.applied).toEqual([{ id: candidate(1).id, terminal: cachedAnswer, writeCache: false }])
  })

  it('a cached UNCLEAR counts as unclear', async () => {
    const cachedAnswer: RoleAiTerminal = { outcome: 'UNCLEAR', roles: [], confidence: null }
    const s = fakeStore([candidate(1)], { cached: { [candidate(1).id]: cachedAnswer } })
    await expect(
      run(
        s,
        fakeClient(() => ok([], 1)),
        fakeLog(),
      ),
    ).resolves.toMatchObject({
      classified: 0,
      unclear: 1,
    })
  })

  it('a row that moved on before the lock (stale) is not counted', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { stale: [candidate(1).id] })
    const c = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
    await expect(run(s, c, fakeLog())).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
  })

  it('a stale row behind a cached answer is not counted either', async () => {
    const cachedAnswer: RoleAiTerminal = { outcome: 'UNCLEAR', roles: [], confidence: null }
    const s = fakeStore([candidate(1)], {
      cached: { [candidate(1).id]: cachedAnswer },
      stale: [candidate(1).id],
    })
    await expect(
      run(
        s,
        fakeClient(() => ok([], 1)),
        fakeLog(),
      ),
    ).resolves.toMatchObject({
      unclear: 0,
    })
  })

  it('NOT_CONFIGURED -> no writes, stoppedBy NOT_CONFIGURED, one skip line', async () => {
    const s = fakeStore([candidate(1), candidate(2)])
    const c = fakeClient(() => ({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
      transport: 'unset',
    }))
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: 'NOT_CONFIGURED',
    })
    expect(c.calls).toHaveLength(1)
    expect(s.applied).toHaveLength(0)
    expect(s.failures).toHaveLength(0)
    expect(
      l.lines.filter(
        (x) => x.level !== 'log' || (x.line as { event: string }).event !== 'ROLE_AI_PASS',
      ),
    ).toEqual([{ level: 'log', line: { event: 'ROLE_AI_SKIPPED', reason: 'NOT_CONFIGURED' } }])
  })

  it('PROVIDER_ERROR on item 1 -> FAILED with backoff, items 2..n untouched, warn has provider and reason', async () => {
    const s = fakeStore([candidate(1), candidate(2), candidate(3)])
    const c = fakeClient(() => ({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
      status: 503,
      transport: 'http',
    }))
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 1,
      stoppedBy: 'PROVIDER_ERROR',
    })
    expect(c.calls).toHaveLength(1)
    expect(s.failures).toEqual([{ id: candidate(1).id, now: NOW }])
    expect(s.applied).toHaveLength(0)
    expect(l.lines).toContainEqual({
      level: 'warn',
      line: {
        event: 'ROLE_AI_FAILED',
        opportunityId: candidate(1).id,
        provider: 'extraction-worker:/classify-roles',
        reason: 'PROVIDER_ERROR:http',
        status: 503,
      },
    })
  })

  it.each(['TIMEOUT', 'RATE_LIMITED'] as const)(
    '%s stops the pass after one failure',
    async (reason) => {
      const s = fakeStore([candidate(1), candidate(2)])
      const c = fakeClient(() => ({ kind: 'unavailable', reason }))
      await expect(run(s, c, fakeLog())).resolves.toMatchObject({ failed: 1, stoppedBy: reason })
      expect(c.calls).toHaveLength(1)
    },
  )

  it('INVALID_OUTPUT -> FAILED with backoff, the pass continues', async () => {
    const s = fakeStore([candidate(1), candidate(2)])
    const c = fakeClient((_i, n) =>
      n === 1
        ? { kind: 'unavailable', reason: 'INVALID_OUTPUT', transport: 'reply' }
        : ok(['QA_ENGINEER'], 0.8),
    )
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 1,
      stoppedBy: null,
    })
    expect(s.failures).toEqual([{ id: candidate(1).id, now: NOW }])
    expect(s.applied.map((a) => a.id)).toEqual([candidate(2).id])
    expect(l.lines).toContainEqual({
      level: 'warn',
      line: {
        event: 'ROLE_AI_FAILED',
        opportunityId: candidate(1).id,
        provider: 'extraction-worker:/classify-roles',
        reason: 'INVALID_OUTPUT:reply',
        status: undefined,
      },
    })
  })

  it('the pass never throws: a rejection is logged, its failure recorded, and the pass continues', async () => {
    const s = fakeStore([candidate(1), candidate(2)])
    const c = fakeClient((_, call) =>
      call === 1 ? new Error(`boom ${TITLE}-1 ${DESCRIPTION}-1`) : ok(['QA_ENGINEER'], 0.9),
    )
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 1,
      stoppedBy: null,
    })
    expect(c.calls).toHaveLength(2)
    // The poison row gets its backoff: it cannot take the head of every pass.
    expect(s.failures).toEqual([{ id: candidate(1).id, now: NOW }])
    expect(l.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        line: { event: 'ROLE_AI_ERROR', opportunityId: candidate(1).id, error: 'Error', db: '' },
      }),
    )
    expect(JSON.stringify(l.lines)).not.toContain(TITLE)
  })

  it('a throw whose failure cannot be recorded either stops the pass with ERROR, counting no failure', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { failureThrows: new Error('db down') })
    const c = fakeClient(() => new Error('boom'))
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: 'ERROR',
    })
    expect(c.calls).toHaveLength(1)
    expect(l.lines.filter((x) => x.level === 'error')).toHaveLength(2)
  })

  it('a throw on a row reclassified meanwhile counts no failure and the pass goes on', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { failureStale: [candidate(1).id] })
    const c = fakeClient((_, call) => (call === 1 ? new Error('boom') : ok(['QA_ENGINEER'], 0.9)))
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
    expect(c.calls).toHaveLength(2)
    expect(s.applied.map((a) => a.id)).toEqual([candidate(2).id])
    expect(l.lines.filter((x) => x.level === 'error')).toHaveLength(1)
  })

  it(`${ROLE_AI_MAX_CONSECUTIVE_ERRORS} throws on reclassified rows in a row still stop with ERROR, counting no failure`, async () => {
    const rows = [1, 2, 3, 4].map((n) => candidate(n))
    const s = fakeStore(rows, { failureStale: rows.map((c) => c.id) })
    const c = fakeClient(() => new Error('boom'))
    await expect(run(s, c, fakeLog())).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: 'ERROR',
    })
    expect(c.calls).toHaveLength(ROLE_AI_MAX_CONSECUTIVE_ERRORS)
  })

  it(`stops with ERROR after ${ROLE_AI_MAX_CONSECUTIVE_ERRORS} consecutive throws`, async () => {
    expect(ROLE_AI_MAX_CONSECUTIVE_ERRORS).toBe(3)
    const s = fakeStore([1, 2, 3, 4].map((n) => candidate(n)))
    const c = fakeClient(() => new Error('boom'))
    await expect(run(s, c, fakeLog())).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 3,
      stoppedBy: 'ERROR',
    })
    expect(c.calls).toHaveLength(3)
    expect(s.failures.map((f) => f.id)).toEqual([1, 2, 3].map((n) => candidate(n).id))
  })

  it('an answered row resets the consecutive-throw count', async () => {
    const s = fakeStore([1, 2, 3, 4, 5].map((n) => candidate(n)))
    const c = fakeClient((_, call) => (call === 3 ? ok(['QA_ENGINEER'], 0.9) : new Error('boom')))
    await expect(run(s, c, fakeLog())).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 4,
      stoppedBy: null,
    })
    expect(c.calls).toHaveLength(5)
  })

  it('a failure on a row reclassified meanwhile is neither counted nor warned; the stop rule holds', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { failureStale: [candidate(1).id] })
    const c = fakeClient(() => ({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
      status: 502,
      transport: 'http',
    }))
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: 'PROVIDER_ERROR',
    })
    expect(c.calls).toHaveLength(1)
    expect(l.lines.filter((x) => x.level === 'warn')).toEqual([])
  })

  it('a per-item failure on a row reclassified meanwhile is not counted and the pass continues', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { failureStale: [candidate(1).id] })
    const c = fakeClient((_, call) =>
      call === 1 ? { kind: 'unavailable', reason: 'INVALID_OUTPUT' } : ok(['QA_ENGINEER'], 0.9),
    )
    await expect(run(s, c, fakeLog())).resolves.toEqual({
      classified: 1,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
  })

  it('reserves one call of the daily budget before each model call, at the pass clock', async () => {
    const s = fakeStore([candidate(1), candidate(2)])
    await run(
      s,
      fakeClient(() => ok(['QA_ENGINEER'], 0.9)),
      fakeLog(),
      12,
    )
    expect(s.reserved).toEqual([
      { now: NOW, limit: 12 },
      { now: NOW, limit: 12 },
    ])
  })

  it('a spent budget makes no call, logs one DAILY_BUDGET skip, and still applies cached answers', async () => {
    const cachedAnswer: RoleAiTerminal = { outcome: 'AI', roles: ['QA_ENGINEER'], confidence: 0.9 }
    const s = fakeStore([candidate(1), candidate(2), candidate(3), candidate(4)], {
      budgetLeft: 1,
      cached: { [candidate(4).id]: cachedAnswer },
    })
    const c = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
    const l = fakeLog()
    await expect(run(s, c, l)).resolves.toEqual({
      classified: 2,
      unclear: 0,
      failed: 0,
      stoppedBy: 'DAILY_BUDGET',
    })
    expect(c.calls.map((x) => x.title)).toEqual([candidate(1).title])
    // Once spent, the budget is not asked again in this pass.
    expect(s.reserved).toHaveLength(2)
    expect(s.applied.map((a) => a.id)).toEqual([candidate(1).id, candidate(4).id])
    expect(s.failures).toEqual([])
    expect(
      l.lines.filter((x) => (x.line as { event: string }).event === 'ROLE_AI_SKIPPED'),
    ).toEqual([{ level: 'log', line: { event: 'ROLE_AI_SKIPPED', reason: 'DAILY_BUDGET' } }])
  })

  it('NOT_CONFIGURED gives the reserved call back: no model ran', async () => {
    const s = fakeStore([candidate(1)])
    await run(
      s,
      fakeClient(() => ({ kind: 'unavailable', reason: 'NOT_CONFIGURED', transport: 'unset' })),
      fakeLog(),
    )
    expect(s.released).toEqual([NOW])
  })

  it('an answered call keeps its reservation', async () => {
    const s = fakeStore([candidate(1)])
    await run(
      s,
      fakeClient(() => ok(['QA_ENGINEER'], 0.9)),
      fakeLog(),
    )
    expect(s.released).toEqual([])
  })

  it('a candidate query failure is logged, never thrown', async () => {
    const s = fakeStore([], { candidatesThrow: new Error(`query ${TITLE}`) })
    const l = fakeLog()
    await expect(
      run(
        s,
        fakeClient(() => ok([], 1)),
        l,
      ),
    ).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: 'ERROR',
    })
    expect(l.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        line: { event: 'ROLE_AI_ERROR', error: 'Error', db: '' },
      }),
    )
    expect(JSON.stringify(l.lines)).not.toContain(TITLE)
  })

  it('logs never contain the title or description', async () => {
    const s = fakeStore([candidate(1), candidate(2), candidate(3)])
    const c = fakeClient((_i, n) =>
      n === 1
        ? ok(['BACKEND_ENGINEER'], 0.9)
        : n === 2
          ? { kind: 'unavailable', reason: 'INVALID_OUTPUT' }
          : { kind: 'unavailable', reason: 'TIMEOUT', transport: 'timeout' },
    )
    const l = fakeLog()
    await run(s, c, l)
    expect(l.lines.length).toBeGreaterThan(2)
    const text = JSON.stringify(l.lines)
    expect(text).not.toContain(TITLE)
    expect(text).not.toContain(TITLE.toLowerCase())
    expect(text).not.toContain(DESCRIPTION)
  })
})

describe('logRoleAiError', () => {
  it('logs a pg error by its SQLSTATE with no leading space, and no opportunityId key when none is given', () => {
    const l = fakeLog()
    const err = Object.assign(new Error(`denied ${TITLE}`), {
      code: '42501',
      severity: 'ERROR',
    })
    logRoleAiError(l.log, err)
    const line = l.lines[0]?.line as Record<string, unknown>
    expect(Object.keys(line).sort()).toEqual(['db', 'error', 'event'])
    expect(line['db']).toMatch(/^\S/)
    expect(line['db']).toContain('42501')
    expect(JSON.stringify(l.lines)).not.toContain(TITLE)
  })
})
