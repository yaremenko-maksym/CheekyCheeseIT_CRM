import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeterDb } from '../metering/account-meter.store'
import { loadRoster } from '../runtime/recompute-inputs'
import type { RelevanceSenior } from './jev-relevance-grader'
import { runRelevancePass, type RelevanceStore } from './relevance-pass'
import { createRelevanceStore } from './relevance.store'

vi.mock('../runtime/recompute-inputs', async (orig) => ({
  ...(await orig<typeof import('../runtime/recompute-inputs')>()),
  loadRoster: vi.fn(),
}))
vi.mock('./relevance.store', async (orig) => ({
  ...(await orig<typeof import('./relevance.store')>()),
  createRelevanceStore: vi.fn(),
}))

const NOW = new Date('2026-11-24T10:00:00.000Z')
const S1 = '5e000000-0000-4000-8000-000000000001'
const S2 = '5e000000-0000-4000-8000-000000000002'
const DB = { marker: 'db' } as unknown as MeterDb
const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

function setup() {
  vi.mocked(loadRoster).mockResolvedValue({
    rosterSeniorIds: [S1, S2],
    profiles: [
      { seniorId: S1, teamIds: ['t'], roles: ['BACKEND_ENGINEER'], skills: ['Java'] },
      { seniorId: S2, teamIds: ['t'], roles: ['QA_ENGINEER'], skills: null },
    ],
    exclusions: [],
    // S2 has no version: it is never gradable.
    versions: new Map([[S1, { profile: 'pv-1', exclusion: 'ex-1' }]]),
  } as unknown as Awaited<ReturnType<typeof loadRoster>>)
  const store: RelevanceStore = {
    candidates: vi.fn(() =>
      Promise.resolve([
        {
          id: 'o1',
          title: 'Java lead',
          titleKey: 'java lead',
          descriptionSha256: null,
          description: '',
          categories: [],
          roles: [],
          pairs: [
            { seniorId: S1, profileVersion: 'pv-1' },
            { seniorId: S2, profileVersion: 'pv-2' },
          ],
        },
      ]),
    ),
    applyGrades: vi.fn(() => Promise.resolve(true)),
    recordFailures: vi.fn(() => Promise.resolve(0)),
  }
  vi.mocked(createRelevanceStore).mockReturnValue(store)
  const sent: (readonly RelevanceSenior[])[] = []
  const jev = {
    grade: vi.fn((_v: unknown, s: readonly RelevanceSenior[]) => {
      sent.push(s)
      return Promise.resolve({ kind: 'ok' as const, fits: s.map(() => 0.5) })
    }),
  }
  return { store, jev, sent }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('runRelevancePass (the production wiring)', () => {
  it('reads the roster once and grades only seniors with a live profile version', async () => {
    const { store, jev, sent } = setup()
    const r = await runRelevancePass({ db: DB, jev, log, now: () => NOW })
    expect(loadRoster).toHaveBeenCalledWith(DB)
    expect(createRelevanceStore).toHaveBeenCalledWith(DB)
    expect(store.candidates).toHaveBeenCalledWith(NOW, 20 * 5)
    expect(sent).toEqual([[{ roles: ['BACKEND_ENGINEER'], skills: ['Java'] }]])
    expect(store.applyGrades).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }), [
      { seniorId: S1, profileVersion: 'pv-1', fit: 0.5 },
    ])
    expect(r).toEqual({ graded: 1, failed: 0, stoppedBy: null })
  })

  it('an explicit limit replaces the default', async () => {
    const { store, jev } = setup()
    await runRelevancePass({ db: DB, jev, log, now: () => NOW, limit: 5 })
    expect(store.candidates).toHaveBeenCalledWith(NOW, 5 * 5)
  })
})
