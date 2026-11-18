/**
 * A source's paused / running state is derived from the clock (`deriveSourceState(source, now)`:
 * a cooldown or host pause ends at an instant). Under the React Compiler a render-time
 * `Date.now()` is not a memo dependency, so a compiled component that re-renders with the same
 * `source` would keep the state derived at its first render. These cases pin that a re-render
 * after the pause window ended shows the source as running again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { JobSourceDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

// `useJobSources` as the query hook behaves: a store subscription whose result is replaced on a
// change, while `data` keeps its identity as long as the server data is unchanged (structural
// sharing). A refetch that fails flips `isError` and keeps the same `data`.
const sources = vi.hoisted(() => {
  type Result = { data: unknown; isLoading: boolean; isError: boolean }
  type Store = {
    result: Result
    subscribe: (listener: () => void) => () => void
    set: (patch: Partial<Result>) => void
  }
  const listeners = new Set<() => void>()
  const store: Store = {
    result: { data: undefined, isLoading: false, isError: false },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(patch: Partial<Result>) {
      store.result = { ...store.result, ...patch }
      listeners.forEach((listener) => listener())
    },
  }
  return store
})
// One object for every call: `useMutation` keeps `mutate` / `reset` (and an idle result) stable.
const mutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  isError: false,
  error: null,
  variables: undefined,
}))
vi.mock('@/hooks/use-job-sourcing', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useJobSources: () => useSyncExternalStore(sources.subscribe, () => sources.result),
    useSetJobSourceEnabled: () => mutation,
  }
})

import { SourceBudgetPanel } from '../SourceBudgetPanel'
import { SourceSwitchCard } from '../SourceSwitchCard'

const T0 = new Date('2026-11-10T12:00:00.000Z')
const HOUR = 60 * 60_000

// One object for every render, like a query result that has not changed.
const cooling: JobSourceDto = {
  id: '55555555-5555-4555-8555-555555555555',
  type: 'DOU_RSS',
  enabled: true,
  triggerMode: 'SCHEDULED',
  lastCollectedAt: T0.toISOString(),
  disabledReason: null,
  budget: {
    state: 'UNLIMITED',
    limit: null,
    window: null,
    used: 0,
    remaining: null,
    resetsAt: null,
  },
  readiness: 'VERIFIED',
  readinessReason: null,
  adminState: 'ACTIVE',
  lastAttemptAt: T0.toISOString(),
  lastSuccessAt: T0.toISOString(),
  lastNonemptyAt: T0.toISOString(),
  cooldownUntil: new Date(T0.getTime() + HOUR / 2).toISOString(),
  hostPausedUntil: null,
  hostPauseReason: null,
  lastErrorCode: null,
}

describe('source state follows the clock on a re-render', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    sources.result = { data: { items: [cooling] }, isLoading: false, isError: false }
    await loadCatalog('en')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('SourceSwitchCard: a cooldown that ended reads as running', () => {
    const { rerender } = render(<SourceSwitchCard source={cooling} showTrigger={false} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByTestId('job-source-card').textContent).toContain('Paused')

    vi.setSystemTime(new Date(T0.getTime() + HOUR))
    rerender(<SourceSwitchCard source={cooling} showTrigger={false} />)

    expect(screen.getByTestId('job-source-card').textContent).toContain('Running')
  })

  it('SourceBudgetPanel: the paused count follows the clock', () => {
    render(<SourceBudgetPanel canView collapsible />, { wrapper: I18nTestProvider })
    expect(screen.getByTestId('job-source-summary').textContent).toContain('1 paused')

    // The cooldown ends, then a background refetch fails: the panel re-renders with the same data.
    vi.setSystemTime(new Date(T0.getTime() + HOUR))
    act(() => sources.set({ isError: true }))

    expect(screen.getByTestId('job-source-summary').textContent).not.toContain('paused')
  })
})
