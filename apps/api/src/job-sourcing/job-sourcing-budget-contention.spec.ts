import { describe, expect, it, vi } from 'vitest'
import { budgetWindowStart } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import type { HrAccessService } from '../common/hr-access.service'
import type { DouRssProvider } from './dou.provider'
import {
  JobSourceBudgetContentionError,
  JobSourceBudgetExhaustedError,
} from './source-budget.error'
import { JobSourcingService, type BudgetedSource } from './job-sourcing.service'

/**
 * Backlog #61 — `chargeBudget`'s tail branch used to throw
 * `JobSourceBudgetExhaustedError` UNCONDITIONALLY once `CHARGE_BUDGET_MAX_ATTEMPTS`
 * (3, private to job-sourcing.service.ts — hence the literal `3` everywhere
 * below, not an import of it) ran out, without checking whether the row it
 * had JUST re-read actually WAS exhausted. Real contention (several writers
 * losing the compare-and-set against each other, never against a spent
 * budget) produced the exact same "бюджет исчерпан" message as a genuinely
 * spent source — an honest-looking lie that sends whoever reads the log
 * after the wrong fix.
 *
 * No real Postgres needed here (unlike the sibling
 * `job-sourcing-budget-race.integration.spec.ts`, which reproduces the
 * WINDOW-ROLLOVER race, backlog #53, against real SQL semantics): the tail
 * branch's bug is entirely about what `chargeBudget` DOES with the state it
 * already holds after the retries, not about SQL's compare-and-set
 * semantics — a mocked `DatabaseService` whose UPDATE always reports "0 rows
 * changed" (every CAS attempt lost) drives the exact same code path
 * deterministically, with the SELECT re-read standing in for "what the row
 * genuinely looks like right now".
 *
 * NO HARDCODED CALENDAR DATE (same lesson as the sibling race spec):
 * `windowStartedAt` below is always `budgetWindowStart(new Date(), 'DAY')` —
 * the REAL shared helper, computed at test run time — so the fixture is
 * always "today's window", whatever today happens to be.
 */

const SOURCE_ID = 'contention-source-0000-0000-000000000001'
const BUDGET_LIMIT = 10

function makeAlwaysLosingUpdateMock() {
  // Every attempt's compare-and-set matches nothing — `returning()` resolves
  // to an empty array, exactly what a real lost CAS produces.
  return vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  })
}

/** One `.select().from().where().limit()` call per re-read, in sequence. */
function makeSelectSequenceMock(rows: BudgetedSource[]) {
  let call = 0
  return vi.fn().mockImplementation(() => {
    const row = rows[Math.min(call, rows.length - 1)]
    call += 1
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue(Promise.resolve([row])),
        }),
      }),
    }
  })
}

function makeProviderStub(): DouRssProvider {
  return {
    type: 'DOU_RSS',
    collect: vi.fn().mockResolvedValue([]),
  } as unknown as DouRssProvider
}

function makeService(
  updateMock: ReturnType<typeof makeAlwaysLosingUpdateMock>,
  selectMock: ReturnType<typeof makeSelectSequenceMock>,
  provider: DouRssProvider,
): JobSourcingService {
  const db = {
    db: {
      update: updateMock,
      select: selectMock,
    },
  } as unknown as DatabaseService
  const hrAccess = {} as unknown as HrAccessService
  return new JobSourcingService(db, hrAccess, provider)
}

describe('Job sourcing — chargeBudget names its refusal honestly (#61)', () => {
  it('CONTENTION, not exhaustion: attempts outlived by a row that still has room throws JobSourceBudgetContentionError, NOT JobSourceBudgetExhaustedError', async () => {
    const windowStartedAt = budgetWindowStart(new Date(), 'DAY')
    // budgetUsed stays at 3/10 on EVERY re-read — the row genuinely never
    // gets close to its limit; only the compare-and-set keeps losing.
    const neverExhaustedRow: BudgetedSource = {
      id: SOURCE_ID,
      type: 'DOU_RSS',
      config: {},
      budgetLimit: BUDGET_LIMIT,
      budgetWindow: 'DAY',
      budgetUsed: 3,
      budgetWindowStartedAt: windowStartedAt,
    }

    const updateMock = makeAlwaysLosingUpdateMock()
    const selectMock = makeSelectSequenceMock([
      neverExhaustedRow,
      neverExhaustedRow,
      neverExhaustedRow,
    ])
    const provider = makeProviderStub()
    const service = makeService(updateMock, selectMock, provider)

    let caught: unknown
    try {
      await service.collectSource({ ...neverExhaustedRow })
    } catch (err) {
      caught = err
    }

    // The literal we compare against — not derived from `budget.limit` or any
    // other value the production code itself computed (AC6).
    expect(caught).toBeInstanceOf(JobSourceBudgetContentionError)
    expect(caught).not.toBeInstanceOf(JobSourceBudgetExhaustedError)
    const contentionError = caught as JobSourceBudgetContentionError
    expect(contentionError.name).toBe('JobSourceBudgetContentionError')
    expect(contentionError.sourceType).toBe('DOU_RSS')
    expect(contentionError.attempts).toBe(3)
    expect(contentionError.budgetExhausted).toBe(false)
    expect(contentionError.message).toContain('конкуренция за строку')
    expect(contentionError.message).toContain('не исчерпание лимита')

    // AC5 — still conservative: every CAS attempt was actually tried (bounded
    // retry, not an infinite loop) and the provider was NEVER reached, so no
    // extra paid request went out despite the honest cause change.
    expect(updateMock).toHaveBeenCalledTimes(3)
    expect(provider.collect).not.toHaveBeenCalled()
  })

  it('CONTROL — genuine exhaustion discovered only on the LAST re-read still throws JobSourceBudgetExhaustedError (the honest-cause check does not weaken the real refusal)', async () => {
    const windowStartedAt = budgetWindowStart(new Date(), 'DAY')
    const stillHasRoom: BudgetedSource = {
      id: SOURCE_ID,
      type: 'DOU_RSS',
      config: {},
      budgetLimit: BUDGET_LIMIT,
      budgetWindow: 'DAY',
      budgetUsed: 3,
      budgetWindowStartedAt: windowStartedAt,
    }
    const genuinelySpent: BudgetedSource = {
      ...stillHasRoom,
      budgetUsed: BUDGET_LIMIT, // 10/10 — truly nothing left
    }

    const updateMock = makeAlwaysLosingUpdateMock()
    // Re-read #1 and #2 still show room (so the loop's own mid-loop exhausted
    // check does not fire early) — only re-read #3, the one that becomes the
    // TAIL branch's `current`, is genuinely spent.
    const selectMock = makeSelectSequenceMock([stillHasRoom, stillHasRoom, genuinelySpent])
    const provider = makeProviderStub()
    const service = makeService(updateMock, selectMock, provider)

    let caught: unknown
    try {
      await service.collectSource({ ...stillHasRoom })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(JobSourceBudgetExhaustedError)
    expect(caught).not.toBeInstanceOf(JobSourceBudgetContentionError)
    const exhaustedError = caught as JobSourceBudgetExhaustedError
    expect(exhaustedError.budgetExhausted).toBe(true)
    // The literal `10` — this fixture's BUDGET_LIMIT, not a value re-derived
    // from `resolveBudget`'s own output (AC6).
    expect(exhaustedError.limit).toBe(10)

    expect(updateMock).toHaveBeenCalledTimes(3)
    expect(provider.collect).not.toHaveBeenCalled()
  })
})
