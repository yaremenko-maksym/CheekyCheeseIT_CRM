import { describe, expect, it, vi } from 'vitest'
import type { RelevanceReply, RelevanceSenior, RelevanceVacancy } from './jev-relevance-grader'
import {
  RELEVANCE_BACKOFF,
  RELEVANCE_CANDIDATE_OVERFETCH,
  RELEVANCE_CRON,
  RELEVANCE_JEV_MAX_ITEM_FAILURES,
  RELEVANCE_MAX_ATTEMPTS,
  RELEVANCE_PASS_LIMIT,
  type RelevanceCandidate,
  type RelevanceGrade,
  type RelevanceGrader,
  type RelevancePair,
  type RelevanceStore,
  logRelevanceError,
  runRelevanceLoop,
} from './relevance-pass'

const NOW = new Date('2026-11-24T12:00:00Z')
const TITLE = 'Secret Title Text'
const DESCRIPTION = 'Secret description body'

const seniorId = (i: number) => `5e000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const oppId = (i: number) => `0a000000-0000-4000-8000-${String(i).padStart(12, '0')}`

function candidate(i: number, pairCount: number): RelevanceCandidate {
  return {
    id: oppId(i),
    title: TITLE,
    titleKey: 'secret title text',
    descriptionSha256: 'abc',
    description: DESCRIPTION,
    categories: ['Java'],
    roles: ['BACKEND_ENGINEER'],
    pairs: Array.from({ length: pairCount }, (_, j) => ({
      seniorId: seniorId(j),
      profileVersion: `pv-${j}`,
    })),
  }
}

/** Every senior 0..199 at profile version `pv-<i>`, with roles and skills. */
const PROFILES = new Map(
  Array.from({ length: 200 }, (_, i) => [
    seniorId(i),
    { roles: ['BACKEND_ENGINEER'], skills: [`skill-${i}`], profileVersion: `pv-${i}` },
  ]),
)

function fakeStore(candidates: RelevanceCandidate[]) {
  const applied: { id: string; grades: RelevanceGrade[] }[] = []
  const failures: { id: string; pairs: RelevancePair[] }[] = []
  const store: RelevanceStore = {
    candidates: vi.fn((_now: Date, limit: number) => Promise.resolve(candidates.slice(0, limit))),
    applyGrades: vi.fn((c: RelevanceCandidate, grades: readonly RelevanceGrade[]) => {
      applied.push({ id: c.id, grades: [...grades] })
      return Promise.resolve(true)
    }),
    recordFailures: vi.fn((c: RelevanceCandidate, pairs: readonly RelevancePair[]) => {
      failures.push({ id: c.id, pairs: [...pairs] })
      return Promise.resolve(pairs.length)
    }),
  }
  return { store, applied, failures }
}

/** Answers each call with the next reply; an `ok` with no fits means "fit 0.5 for everyone". */
function fakeJev(...replies: (RelevanceReply | 'ok')[]) {
  const calls: { vacancy: RelevanceVacancy; seniors: RelevanceSenior[] }[] = []
  const grade = vi.fn((vacancy: RelevanceVacancy, seniors: readonly RelevanceSenior[]) => {
    calls.push({ vacancy, seniors: [...seniors] })
    const r = replies[Math.min(calls.length - 1, replies.length - 1)] ?? 'ok'
    return Promise.resolve<RelevanceReply>(
      r === 'ok' ? { kind: 'ok', fits: seniors.map((_, i) => (i % 2 === 0 ? 0.5 : 0.75)) } : r,
    )
  })
  return { jev: { grade }, calls }
}

const fakeLog = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() })
const unavailable = (reason: string): RelevanceReply => ({ kind: 'unavailable', reason })

const run = (
  store: RelevanceStore,
  jev: RelevanceGrader,
  log = fakeLog(),
  limit = RELEVANCE_PASS_LIMIT,
) =>
  runRelevanceLoop({
    store,
    jev,
    profiles: PROFILES,
    log,
    now: NOW,
    limit,
  })

describe('relevance pass constants', () => {
  it('pins the plan values', () => {
    expect(RELEVANCE_PASS_LIMIT).toBe(20)
    expect(RELEVANCE_CRON).toBe('5-59/10 * * * *')
    expect(RELEVANCE_MAX_ATTEMPTS).toBe(10)
    expect(RELEVANCE_JEV_MAX_ITEM_FAILURES).toBe(3)
    expect(RELEVANCE_CANDIDATE_OVERFETCH).toBe(5)
  })

  it('backs off 15 min doubled per attempt, capped at 24 h', () => {
    expect(RELEVANCE_BACKOFF(0)).toBe(15 * 60_000)
    expect(RELEVANCE_BACKOFF(1)).toBe(30 * 60_000)
    expect(RELEVANCE_BACKOFF(6)).toBe(960 * 60_000)
    expect(RELEVANCE_BACKOFF(7)).toBe(86_400_000)
    expect(RELEVANCE_BACKOFF(20)).toBe(86_400_000)
  })
})

describe('runRelevanceLoop', () => {
  it('grades every pending pair of an opportunity in one request and applies them once', async () => {
    const { store, applied, failures } = fakeStore([candidate(1, 3)])
    const { jev, calls } = fakeJev('ok')
    const r = await run(store, jev)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.seniors).toHaveLength(3)
    expect(calls[0]?.vacancy).toEqual({
      title: TITLE,
      description: DESCRIPTION,
      categories: ['Java'],
      roles: ['BACKEND_ENGINEER'],
    })
    expect(applied).toEqual([
      {
        id: oppId(1),
        grades: [
          { seniorId: seniorId(0), profileVersion: 'pv-0', fit: 0.5 },
          { seniorId: seniorId(1), profileVersion: 'pv-1', fit: 0.75 },
          { seniorId: seniorId(2), profileVersion: 'pv-2', fit: 0.5 },
        ],
      },
    ])
    expect(failures).toEqual([])
    expect(r).toEqual({ graded: 3, failed: 0, stoppedBy: null })
  })

  it('chunks 120 pairs into 50+50+20 requests and applies one combined grade set', async () => {
    const { store, applied } = fakeStore([candidate(1, 120)])
    const { jev, calls } = fakeJev('ok')
    await run(store, jev)
    expect(calls.map((c) => c.seniors.length)).toEqual([50, 50, 20])
    expect(applied).toHaveLength(1)
    expect(applied[0]?.grades.map((g) => g.seniorId)).toEqual(
      Array.from({ length: 120 }, (_, j) => seniorId(j)),
    )
    // The fit of pair 50 comes from position 0 of the second chunk, not position 50 of the first.
    expect(applied[0]?.grades[50]?.fit).toBe(0.5)
    expect(applied[0]?.grades[51]?.fit).toBe(0.75)
  })

  it('skips a pair whose live profile version differs, or whose senior left the roster', async () => {
    const c = candidate(1, 3)
    c.pairs[1] = { seniorId: seniorId(1), profileVersion: 'pv-old' }
    c.pairs.push({ seniorId: seniorId(999), profileVersion: 'pv-999' })
    const { store, applied } = fakeStore([c])
    const { jev, calls } = fakeJev('ok')
    await run(store, jev)
    expect(calls[0]?.seniors).toHaveLength(2)
    expect(applied[0]?.grades.map((g) => g.seniorId)).toEqual([seniorId(0), seniorId(2)])
  })

  it('an opportunity with no gradable pair makes no call and applies nothing', async () => {
    const c = candidate(1, 1)
    c.pairs[0] = { seniorId: seniorId(0), profileVersion: 'pv-old' }
    const { store, applied } = fakeStore([c])
    const { jev, calls } = fakeJev('ok')
    expect(await run(store, jev)).toEqual({ graded: 0, failed: 0, stoppedBy: null })
    expect(calls).toHaveLength(0)
    expect(applied).toHaveLength(0)
  })

  it('a stale apply (false) is not counted as graded', async () => {
    const { store } = fakeStore([candidate(1, 2)])
    vi.mocked(store.applyGrades).mockResolvedValue(false)
    const { jev } = fakeJev('ok')
    expect(await run(store, jev)).toEqual({ graded: 0, failed: 0, stoppedBy: null })
  })

  it('NOT_CONFIGURED: stops at the first call, records nothing', async () => {
    const { store, applied, failures } = fakeStore([candidate(1, 2), candidate(2, 2)])
    const { jev, calls } = fakeJev(unavailable('NOT_CONFIGURED'))
    const log = fakeLog()
    const r = await run(store, jev, log)
    expect(calls).toHaveLength(1)
    expect(applied).toEqual([])
    expect(failures).toEqual([])
    expect(r).toEqual({ graded: 0, failed: 0, stoppedBy: 'NOT_CONFIGURED' })
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'RELEVANCE_SKIPPED', reason: 'NOT_CONFIGURED' }),
    )
  })

  it('PROVIDER_ERROR: records failures for that chunk and makes no further Jev call in the pass', async () => {
    const { store, applied, failures } = fakeStore([candidate(1, 70), candidate(2, 2)])
    const { jev, calls } = fakeJev('ok', unavailable('PROVIDER_ERROR'))
    const r = await run(store, jev)
    expect(calls).toHaveLength(2)
    expect(failures).toEqual([{ id: oppId(1), pairs: candidate(1, 70).pairs.slice(50) }])
    // The first chunk's grades still land.
    expect(applied).toHaveLength(1)
    expect(applied[0]?.grades).toHaveLength(50)
    expect(r).toEqual({ graded: 50, failed: 20, stoppedBy: 'PROVIDER_ERROR' })
  })

  it.each(['TIMEOUT', 'RATE_LIMITED'])('%s is provider-level: stops the pass', async (code) => {
    const { store } = fakeStore([candidate(1, 1), candidate(2, 1)])
    const { jev, calls } = fakeJev(unavailable(code))
    expect((await run(store, jev)).stoppedBy).toBe(code)
    expect(calls).toHaveLength(1)
  })

  it('INVALID_OUTPUT x3 consecutive disables Jev', async () => {
    const cs = [1, 2, 3, 4].map((i) => candidate(i, 1))
    const { store, failures } = fakeStore(cs)
    const { jev, calls } = fakeJev(unavailable('INVALID_OUTPUT'))
    const r = await run(store, jev)
    expect(calls).toHaveLength(RELEVANCE_JEV_MAX_ITEM_FAILURES)
    expect(failures.map((f) => f.id)).toEqual([oppId(1), oppId(2), oppId(3)])
    expect(r).toEqual({ graded: 0, failed: 3, stoppedBy: 'INVALID_OUTPUT' })
  })

  it('INVALID_INPUT x2 does not disable Jev', async () => {
    const cs = [1, 2, 3].map((i) => candidate(i, 1))
    const { store } = fakeStore(cs)
    const { jev, calls } = fakeJev(unavailable('INVALID_INPUT'), unavailable('INVALID_INPUT'), 'ok')
    const r = await run(store, jev)
    expect(calls).toHaveLength(3)
    expect(r).toEqual({ graded: 1, failed: 2, stoppedBy: null })
  })

  it('a success in between resets the consecutive count', async () => {
    const cs = [1, 2, 3, 4, 5].map((i) => candidate(i, 1))
    const { store } = fakeStore(cs)
    const bad = unavailable('INVALID_OUTPUT')
    const { jev, calls } = fakeJev(bad, bad, 'ok', bad, bad)
    const r = await run(store, jev)
    expect(calls).toHaveLength(5)
    expect(r).toEqual({ graded: 1, failed: 4, stoppedBy: null })
  })

  it('the grader receives no seniorId, only roles and skills', async () => {
    const { store } = fakeStore([candidate(1, 2)])
    const { jev, calls } = fakeJev('ok')
    await run(store, jev)
    expect(calls[0]?.seniors).toEqual([
      { roles: ['BACKEND_ENGINEER'], skills: ['skill-0'] },
      { roles: ['BACKEND_ENGINEER'], skills: ['skill-1'] },
    ])
    expect(JSON.stringify(calls)).not.toContain(seniorId(0))
    expect(JSON.stringify(calls)).not.toContain('pv-0')
  })

  it('never logs title/description', async () => {
    const { store } = fakeStore([candidate(1, 1), candidate(2, 1)])
    const { jev } = fakeJev('ok', unavailable('INVALID_OUTPUT'))
    const log = fakeLog()
    await run(store, jev, log)
    const all = JSON.stringify([log.log.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    expect(all).not.toContain('Secret')
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'RELEVANCE_JEV_FAILED',
        opportunityId: oppId(2),
        reason: 'INVALID_OUTPUT',
        pairs: 1,
      }),
    )
    expect(log.log).toHaveBeenCalledWith({
      event: 'RELEVANCE_PASS',
      candidates: 2,
      skipped: 0,
      graded: 1,
      failed: 1,
      stoppedBy: null,
    })
  })

  it('respects the limit', async () => {
    const { store } = fakeStore([1, 2, 3].map((i) => candidate(i, 1)))
    const { jev, calls } = fakeJev('ok')
    await run(store, jev, fakeLog(), 2)
    expect(store.candidates).toHaveBeenCalledWith(NOW, 2 * RELEVANCE_CANDIDATE_OVERFETCH)
    expect(calls).toHaveLength(2)
  })

  it('ungradable opportunities do not take a limit slot (CR-M-2)', async () => {
    const stale = (i: number) => ({
      ...candidate(i, 1),
      pairs: [{ seniorId: seniorId(0), profileVersion: 'pv-old' }],
    })
    const cs = [...Array.from({ length: 20 }, (_, i) => stale(i + 1)), candidate(21, 1)]
    const { store, applied } = fakeStore(cs)
    const { jev, calls } = fakeJev('ok')
    const log = fakeLog()
    const r = await run(store, jev, log, 20)
    expect(calls).toHaveLength(1)
    expect(applied.map((a) => a.id)).toEqual([oppId(21)])
    expect(r).toEqual({ graded: 1, failed: 0, stoppedBy: null })
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'RELEVANCE_PASS', candidates: 21, skipped: 20 }),
    )
  })

  it('stops at the limit of gradable opportunities, never sends the over-fetched rest', async () => {
    const { store } = fakeStore([1, 2, 3, 4].map((i) => candidate(i, 1)))
    const { jev, calls } = fakeJev('ok')
    expect(await run(store, jev, fakeLog(), 1)).toEqual({ graded: 1, failed: 0, stoppedBy: null })
    expect(calls).toHaveLength(1)
  })

  it('a thrown apply records a backoff for the pairs it lost (CR-M-1)', async () => {
    const { store, failures } = fakeStore([candidate(1, 2)])
    vi.mocked(store.applyGrades).mockRejectedValue(new Error('lock'))
    const { jev } = fakeJev('ok')
    const r = await run(store, jev)
    expect(failures).toEqual([{ id: oppId(1), pairs: candidate(1, 2).pairs }])
    expect(r).toEqual({ graded: 0, failed: 2, stoppedBy: null })
  })

  it('a throw after a recorded chunk backs off only the pairs not yet recorded', async () => {
    const { store, failures } = fakeStore([candidate(1, 70)])
    const { jev } = fakeJev(unavailable('INVALID_OUTPUT'))
    vi.mocked(jev.grade)
      .mockResolvedValueOnce(unavailable('INVALID_OUTPUT'))
      .mockRejectedValueOnce(new Error('socket'))
    const r = await run(store, jev)
    expect(failures.map((f) => f.pairs)).toEqual([
      candidate(1, 70).pairs.slice(0, 50),
      candidate(1, 70).pairs.slice(50),
    ])
    expect(r).toEqual({ graded: 0, failed: 70, stoppedBy: null })
  })

  it('a thrown backoff write stops the pass: the store is down', async () => {
    const { store } = fakeStore([candidate(1, 1), candidate(2, 1)])
    vi.mocked(store.applyGrades).mockRejectedValue(new Error('lock'))
    vi.mocked(store.recordFailures).mockRejectedValue(new Error('down'))
    const { jev, calls } = fakeJev('ok')
    const log = fakeLog()
    const r = await run(store, jev, log)
    expect(calls).toHaveLength(1)
    expect(r).toEqual({ graded: 0, failed: 0, stoppedBy: 'ERROR' })
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('failed counts the rows actually written, not the chunk (CR-L-1)', async () => {
    const { store } = fakeStore([candidate(1, 3)])
    vi.mocked(store.recordFailures).mockResolvedValue(1)
    const { jev } = fakeJev(unavailable('PROVIDER_ERROR'))
    expect(await run(store, jev)).toEqual({ graded: 0, failed: 1, stoppedBy: 'PROVIDER_ERROR' })
  })

  it('a stop ends the candidate loop: no later candidate is read (CR-L-2)', async () => {
    const second = candidate(2, 1)
    const pairs = second.pairs
    let reads = 0
    Object.defineProperty(second, 'pairs', {
      get: () => {
        reads += 1
        return pairs
      },
    })
    const { store } = fakeStore([candidate(1, 1), second])
    const { jev } = fakeJev(unavailable('NOT_CONFIGURED'))
    await run(store, jev)
    expect(reads).toBe(0)
  })

  it('a thrown candidates read is logged and stops the pass, never thrown', async () => {
    const { store } = fakeStore([])
    vi.mocked(store.candidates).mockRejectedValue(new TypeError('db down'))
    const log = fakeLog()
    const { jev } = fakeJev('ok')
    expect(await run(store, jev, log)).toEqual({ graded: 0, failed: 0, stoppedBy: 'ERROR' })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'RELEVANCE_ERROR', error: 'TypeError' }),
      expect.any(String),
    )
  })

  it('a thrown apply is logged per opportunity; three in a row stop the pass', async () => {
    const { store } = fakeStore([1, 2, 3, 4].map((i) => candidate(i, 1)))
    vi.mocked(store.applyGrades).mockRejectedValue(new Error('lock'))
    const log = fakeLog()
    const { jev, calls } = fakeJev('ok')
    const r = await run(store, jev, log)
    expect(calls).toHaveLength(3)
    expect(r.stoppedBy).toBe('ERROR')
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'RELEVANCE_ERROR', opportunityId: oppId(1) }),
      expect.any(String),
    )
  })

  it('a thrown apply followed by a success resets the thrown count', async () => {
    const { store } = fakeStore([1, 2, 3, 4].map((i) => candidate(i, 1)))
    vi.mocked(store.applyGrades)
      .mockRejectedValueOnce(new Error('lock'))
      .mockRejectedValueOnce(new Error('lock'))
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('lock'))
    const { jev, calls } = fakeJev('ok')
    const r = await run(store, jev)
    expect(calls).toHaveLength(4)
    expect(r).toEqual({ graded: 1, failed: 3, stoppedBy: null })
  })
})

describe('runRelevanceLoop: chunk and stop boundaries', () => {
  it('exactly 50 pairs is one request, never a second empty one', async () => {
    const { store, applied } = fakeStore([candidate(1, 50)])
    const { jev, calls } = fakeJev('ok')
    await run(store, jev)
    expect(calls.map((c) => c.seniors.length)).toEqual([50])
    expect(applied[0]?.grades).toHaveLength(50)
  })

  it('PROVIDER_ERROR on the first chunk: no second chunk is sent, nothing applied', async () => {
    const { store, applied, failures } = fakeStore([candidate(1, 120)])
    const { jev, calls } = fakeJev(unavailable('PROVIDER_ERROR'))
    const r = await run(store, jev)
    expect(calls).toHaveLength(1)
    expect(failures.map((f) => f.pairs.length)).toEqual([50])
    expect(applied).toEqual([])
    expect(r).toEqual({ graded: 0, failed: 50, stoppedBy: 'PROVIDER_ERROR' })
  })

  it('a candidate with no gradable pair does not reset the thrown streak', async () => {
    const stale = { ...candidate(3, 1), pairs: [{ seniorId: seniorId(0), profileVersion: 'old' }] }
    const cs = [candidate(1, 1), candidate(2, 1), stale, candidate(4, 1), candidate(5, 1)]
    const { store } = fakeStore(cs)
    vi.mocked(store.applyGrades).mockRejectedValue(new Error('boom'))
    const { jev, calls } = fakeJev('ok')
    const r = await run(store, jev)
    // 1, 2 and 4 throw: three attempted opportunities in a row; 5 is never sent.
    expect(calls).toHaveLength(3)
    expect(r.stoppedBy).toBe('ERROR')
  })
})

describe('logRelevanceError', () => {
  it('without an opportunity id the line has no opportunityId key', () => {
    const log = fakeLog()
    logRelevanceError(log, new TypeError('x'))
    expect(log.error.mock.calls[0]?.[0]).toStrictEqual({
      event: 'RELEVANCE_ERROR',
      error: 'TypeError',
      db: '',
    })
  })

  it('a db error carries the shared pg fragment, trimmed; the stack drops the message', () => {
    const log = fakeLog()
    const err = Object.assign(new Error('VALUE-MARKER'), { code: '23505', severity: 'ERROR' })
    logRelevanceError(log, err, oppId(1))
    const line = log.error.mock.calls[0]?.[0] as { db: string; opportunityId: string }
    expect(line.opportunityId).toBe(oppId(1))
    expect(line.db).toContain('23505')
    expect(line.db.startsWith('db_error db_state=23505')).toBe(true)
    expect(line).not.toHaveProperty('message')
    expect(String(log.error.mock.calls[0]?.[1])).not.toContain('VALUE-MARKER')
  })
})
