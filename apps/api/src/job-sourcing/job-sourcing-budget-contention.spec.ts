import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/**
 * `collectAll`'s FIRST `select()` is a different shape from `chargeBudget`'s
 * re-read: `collectAll` does `.select().from(jobSources).where(...)` and awaits
 * the result of `.where()` directly (no `.limit()`), returning the full list of
 * enabled sources. Every call AFTER that first one is `chargeBudget`'s re-read
 * (`.select().from().where().limit()`, one row). Modelling both shapes on the
 * SAME mock is what lets a test drive `collectAll` end to end instead of only
 * `collectSource`/`chargeBudget` directly — needed for the H1 regression test
 * below, which asserts on `collectAll`'s own classification branch.
 */
function makeCollectAllSelectMock(listRows: BudgetedSource[], rereadRows: BudgetedSource[]) {
  let call = 0
  return vi.fn().mockImplementation(() => {
    const isListCall = call === 0
    const rereadIndex = call - 1
    call += 1
    if (isListCall) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(listRows),
        }),
      }
    }
    const row = rereadRows[Math.min(rereadIndex, rereadRows.length - 1)]
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
    // Round 3 (PR #544 review): each of these covers a DIFFERENT template-literal
    // chunk of the constructor. Mutation gate proved the two checks below were
    // missing — deleting either chunk to `''` left the CONTENTION/"не исчерпание
    // лимита" assertions above still green, because they only ever read the
    // MIDDLE chunk. The source names, the source type and the attempt count on
    // purpose (task-vacancy-matching honest-cause requirement) — an empty
    // opening or closing chunk must fail here.
    expect(contentionError.message).toContain(
      'Источник DOU_RSS: не удалось начислить бюджет за 3 попыток',
    )
    expect(contentionError.message).toContain('конкуренция за строку')
    expect(contentionError.message).toContain('не исчерпание лимита')
    expect(contentionError.message).toContain('провайдеру не выполнялся); попробуйте ещё раз.')

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
    // Round 3 (PR #544 review, item 4): the sibling CONTENTION test's message
    // gap ("survives when a template-literal chunk is emptied") turned out to
    // have no test AT ALL on this side before this round — `.message` was never
    // read here. Three assertions, one per template-literal chunk in
    // JobSourceBudgetExhaustedError's constructor: the opening sentence, the
    // "Обновится …" reset clause (resetsAt is a real Date here — window 'DAY' —
    // so this branch is exercised, not the null one), and the closing sentence.
    // No exact ISO timestamp asserted — same "no hardcoded calendar date" rule
    // as the fixtures above, `resetsAt` is computed at test run time.
    expect(exhaustedError.message).toContain(
      'Источник DOU_RSS: бюджет запросов исчерпан (лимит 10, остаток 0).',
    )
    expect(exhaustedError.message).toContain('Обновится ')
    expect(exhaustedError.message).toContain('Сбор не выполнялся.')

    expect(updateMock).toHaveBeenCalledTimes(3)
    expect(provider.collect).not.toHaveBeenCalled()
  })
})

/**
 * PR #544 review, H1: the sibling suite above proves `chargeBudget` throws the
 * right ERROR TYPE. It does NOT prove `collectAll` — the only caller that
 * decides what happens to that error — treats it correctly. Before this fix,
 * `collectAll` classified failures with `err instanceof
 * JobSourceBudgetExhaustedError` alone, which does NOT match
 * `JobSourceBudgetContentionError` (a deliberately separate class): contention
 * fell through to the `logger.error` + stack-trace branch, i.e. exactly the
 * "this looks like an incident" outcome backlog #61 exists to prevent. This
 * suite drives `collectAll` itself (via `makeCollectAllSelectMock`, not
 * `collectSource` directly) so the classification branch is actually exercised.
 *
 * PROVEN TO CATCH THE REGRESSION: reverting `collectAll`'s
 * `JobSourceDeliberateStopError` branch back to
 * `err instanceof JobSourceBudgetExhaustedError` alone turns the CONTENTION
 * test below red — `errorSpy` gets called (stack-trace incident path) and
 * `warnSpy` does not, which is precisely the bug H1 reports. Restoring the fix
 * turns it green again. The CONTROL test stays green in both cases — a real
 * `Error` from a broken provider must keep going to `logger.error` regardless.
 */
describe('Job sourcing — collectAll classifies budget refusals honestly (H1, PR #544 review)', () => {
  // Restored unconditionally, even when an assertion above throws mid-test —
  // a spy left dangling after a failed assertion would silently pollute the
  // NEXT test's call count, masking the very regression this suite exists to
  // catch.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('CONTENTION: collectAll logs it as warn+continue (never logger.error/stack), and budgetExhausted stays false in the DTO', async () => {
    const windowStartedAt = budgetWindowStart(new Date(), 'DAY')
    const neverExhaustedRow: BudgetedSource & { triggerMode: 'SCHEDULED'; enabled: true } = {
      id: SOURCE_ID,
      type: 'DOU_RSS',
      config: {},
      budgetLimit: BUDGET_LIMIT,
      budgetWindow: 'DAY',
      budgetUsed: 3,
      budgetWindowStartedAt: windowStartedAt,
      triggerMode: 'SCHEDULED',
      enabled: true,
    }

    const updateMock = makeAlwaysLosingUpdateMock()
    const selectMock = makeCollectAllSelectMock(
      [neverExhaustedRow],
      [neverExhaustedRow, neverExhaustedRow, neverExhaustedRow],
    )
    const provider = makeProviderStub()
    const service = makeService(updateMock, selectMock, provider)

    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    const { results, failures } = await service.collectAll('SCHEDULED')

    expect(results).toHaveLength(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.sourceType).toBe('DOU_RSS')
    // The literal `false` — contention is NOT exhaustion; the DTO must not
    // lie about which one happened (this is what M1 asked to keep true after
    // H1's fix: the flag is read straight off the error instance below, not
    // re-derived from a second `instanceof` check).
    expect(failures[0]?.budgetExhausted).toBe(false)

    // THE REGRESSION THIS TEST CATCHES: a deliberate stop must never reach
    // logger.error (stack-trace incident path).
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('конкуренция за строку')

    expect(provider.collect).not.toHaveBeenCalled()
  })

  it('CONTROL — a genuine provider failure (not a budget stop) still goes to logger.error, not warn', async () => {
    const windowStartedAt = budgetWindowStart(new Date(), 'DAY')
    // Budget has plenty of room and the CAS wins immediately — chargeBudget
    // returns normally, so the failure below can only come from the provider.
    const roomyRow: BudgetedSource & { triggerMode: 'SCHEDULED'; enabled: true } = {
      id: SOURCE_ID,
      type: 'DOU_RSS',
      config: {},
      budgetLimit: BUDGET_LIMIT,
      budgetWindow: 'DAY',
      budgetUsed: 0,
      budgetWindowStartedAt: windowStartedAt,
      triggerMode: 'SCHEDULED',
      enabled: true,
    }

    const updateMock = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SOURCE_ID }]), // CAS wins
        }),
      }),
    })
    const selectMock = makeCollectAllSelectMock([roomyRow], [])
    const provider = {
      type: 'DOU_RSS',
      collect: vi.fn().mockRejectedValue(new Error('feed timed out')),
    } as unknown as DouRssProvider
    const service = makeService(updateMock, selectMock, provider)

    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    const { results, failures } = await service.collectAll('SCHEDULED')

    expect(results).toHaveLength(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.budgetExhausted).toBe(false)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
