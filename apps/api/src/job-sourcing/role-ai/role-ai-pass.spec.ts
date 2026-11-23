import type { TechnicalRole } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import {
  decideRoleAi,
  logRoleAiError,
  ROLE_AI_BACKOFF,
  ROLE_AI_CRON,
  ROLE_AI_JEV_MAX_ITEM_FAILURES,
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
import type { Unavailable } from '../../resumes/verification/inference-clients'
import {
  ROLE_AI_PROVIDER,
  type RoleAiReply,
  type RoleClassifierInput,
} from './role-classifier.client'

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
    expect(ROLE_AI_REASON).toBe('ROLE_AI:rc.2')
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

describe('runRoleAiLoop — Jev first', () => {
  const run = (
    s: ReturnType<typeof fakeStore>,
    jev: ReturnType<typeof fakeClient>,
    hosted: ReturnType<typeof fakeClient>,
    l: ReturnType<typeof fakeLog>,
  ) =>
    runRoleAiLoop({
      store: s.store,
      jev: jev.client,
      client: hosted.client,
      log: l.log,
      now: NOW,
      limit: 7,
      dailyBudget: 50,
    })
  const down = (reason: Unavailable['reason']): RoleAiReply => ({ kind: 'unavailable', reason })
  const warns = (l: ReturnType<typeof fakeLog>) =>
    l.lines.filter((x) => x.level === 'warn').map((x) => x.line)
  const passLine = (l: ReturnType<typeof fakeLog>) =>
    l.lines.find((x) => (x.line as { event: string }).event === 'ROLE_AI_PASS')?.line

  it('a Jev answer is the terminal: no hosted call, no budget reserved, cache written', async () => {
    const s = fakeStore([candidate(1), candidate(2)])
    const jev = fakeClient((_i, n) => (n === 1 ? ok(['BACKEND_ENGINEER'], 0.9) : ok([], 0.95)))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 1))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toEqual({
      classified: 1,
      unclear: 1,
      failed: 0,
      stoppedBy: null,
    })
    expect(jev.calls[0]).toEqual({
      title: `${TITLE}-1`,
      description: `${DESCRIPTION}-1`,
      categories: ['backend'],
    })
    expect(hosted.calls).toHaveLength(0)
    expect(s.reserved).toHaveLength(0)
    expect(s.applied).toEqual([
      {
        id: candidate(1).id,
        terminal: { outcome: 'AI', roles: ['BACKEND_ENGINEER'], confidence: 0.9 },
        writeCache: true,
      },
      {
        id: candidate(2).id,
        terminal: { outcome: 'UNCLEAR', roles: [], confidence: 0.95 },
        writeCache: true,
      },
    ])
    expect(passLine(l)).toEqual({
      event: 'ROLE_AI_PASS',
      candidates: 2,
      classified: 1,
      unclear: 1,
      failed: 0,
      stoppedBy: null,
      viaJev: 2,
    })
  })

  it('Jev down -> the hosted route under the budget, one warn, and Jev is not asked again this pass', async () => {
    const s = fakeStore([candidate(1), candidate(2)])
    const jev = fakeClient(() => down('TIMEOUT'))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 0.8))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toMatchObject({ classified: 2, failed: 0 })
    expect(jev.calls).toHaveLength(1)
    expect(hosted.calls).toHaveLength(2)
    expect(s.reserved).toEqual([
      { now: NOW, limit: 50 },
      { now: NOW, limit: 50 },
    ])
    expect(warns(l)).toEqual([
      {
        event: 'ROLE_AI_JEV_FAILED',
        opportunityId: candidate(1).id,
        provider: 'jev',
        reason: 'TIMEOUT',
        status: undefined,
        fallback: ROLE_AI_PROVIDER,
      },
    ])
    expect(passLine(l)).toMatchObject({ viaJev: 0 })
  })

  it.each(['INVALID_OUTPUT', 'INVALID_INPUT'] as const)(
    'Jev %s -> the hosted route for that vacancy only; the next one asks Jev again',
    async (reason) => {
      const s = fakeStore([candidate(1), candidate(2)])
      const jev = fakeClient((_i, n) => (n === 1 ? down(reason) : ok(['DATA_ENGINEER'], 0.9)))
      const hosted = fakeClient(() => ok(['QA_ENGINEER'], 0.8))
      const l = fakeLog()
      await expect(run(s, jev, hosted, l)).resolves.toMatchObject({ classified: 2 })
      expect(jev.calls).toHaveLength(2)
      expect(hosted.calls).toHaveLength(1)
      expect(s.applied.map((a) => a.terminal.roles)).toEqual([['QA_ENGINEER'], ['DATA_ENGINEER']])
      expect(warns(l)).toHaveLength(1)
      expect(passLine(l)).toMatchObject({ viaJev: 1 })
    },
  )

  // Master decision B-2 (PR #1469): a pass with no Jev key says so once, not once per vacancy.
  it('Jev NOT_CONFIGURED -> the hosted route, one unconfigured warn per pass, and Jev is not asked again', async () => {
    const s = fakeStore([candidate(1), candidate(2), candidate(3)])
    const jev = fakeClient(() => down('NOT_CONFIGURED'))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 0.8))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toMatchObject({ classified: 3 })
    expect(jev.calls).toHaveLength(1)
    expect(hosted.calls).toHaveLength(3)
    expect(warns(l)).toEqual([
      {
        event: 'role_ai_jev_unconfigured',
        provider: 'jev',
        cause: 'JEV_API_KEY is not set or ConfigService is absent',
        fallback: ROLE_AI_PROVIDER,
      },
    ])
  })

  it('a spent hosted budget does not stop Jev', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { budgetLeft: 0 })
    const jev = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 1))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toEqual({
      classified: 2,
      unclear: 0,
      failed: 0,
      stoppedBy: null,
    })
    expect(s.reserved).toHaveLength(0)
  })

  it('Jev down and the hosted budget spent -> the DAILY_BUDGET skip, no failure written', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { budgetLeft: 0 })
    const jev = fakeClient(() => down('RATE_LIMITED'))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 1))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 0,
      stoppedBy: 'DAILY_BUDGET',
    })
    expect(hosted.calls).toHaveLength(0)
    expect(s.failures).toEqual([])
    expect(s.reserved).toHaveLength(1)
  })

  // SR-M-1 (security review on PR #1469): a per-row Jev failure gets its backoff with no hosted call.
  it('Jev INVALID_OUTPUT and the hosted budget spent -> a FAILED row with backoff, no hosted call', async () => {
    const s = fakeStore([candidate(1), candidate(2)], { budgetLeft: 0 })
    const jev = fakeClient(() => down('INVALID_OUTPUT'))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 1))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toEqual({
      classified: 0,
      unclear: 0,
      failed: 2,
      stoppedBy: 'DAILY_BUDGET',
    })
    expect(hosted.calls).toHaveLength(0)
    expect(s.failures).toEqual([
      { id: candidate(1).id, now: NOW },
      { id: candidate(2).id, now: NOW },
    ])
  })

  it('a Jev per-row failure on a row reclassified meanwhile is not counted', async () => {
    const s = fakeStore([candidate(1)], { budgetLeft: 0, failureStale: [candidate(1).id] })
    const jev = fakeClient(() => down('INVALID_INPUT'))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 1))
    await expect(run(s, jev, hosted, fakeLog())).resolves.toMatchObject({ failed: 0 })
  })

  it('3 per-row Jev failures turn Jev off for the rest of the pass', async () => {
    expect(ROLE_AI_JEV_MAX_ITEM_FAILURES).toBe(3)
    const s = fakeStore([1, 2, 3, 4, 5].map(candidate))
    const jev = fakeClient(() => down('INVALID_OUTPUT'))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 0.8))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toMatchObject({ classified: 5 })
    expect(jev.calls).toHaveLength(3)
    expect(hosted.calls).toHaveLength(5)
    expect(warns(l)).toHaveLength(3)
  })

  it('a Jev answer below the confidence gate is UNCLEAR, not a hosted retry', async () => {
    const s = fakeStore([candidate(1)])
    const jev = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.69))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 1))
    await expect(run(s, jev, hosted, fakeLog())).resolves.toMatchObject({ unclear: 1 })
    expect(hosted.calls).toHaveLength(0)
  })

  it('a stale row answered by Jev is not counted', async () => {
    const s = fakeStore([candidate(1)], { stale: [candidate(1).id] })
    const jev = fakeClient(() => ok(['BACKEND_ENGINEER'], 0.9))
    const hosted = fakeClient(() => ok(['QA_ENGINEER'], 1))
    const l = fakeLog()
    await expect(run(s, jev, hosted, l)).resolves.toMatchObject({ classified: 0, unclear: 0 })
    expect(passLine(l)).toMatchObject({ viaJev: 0 })
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
