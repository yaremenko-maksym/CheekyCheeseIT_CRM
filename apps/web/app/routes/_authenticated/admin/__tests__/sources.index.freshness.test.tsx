/**
 * sources.index.tsx: relative freshness ("10 minutes ago") follows the clock.
 *
 * The React Compiler memoizes render output on the values a component reads.
 * A `Date.now()` read is not one of them, so a compiled row keeps its old
 * relative time on a re-render unless the clock read is kept out of the memo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  return {
    ...actual,
    Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
      <a data-testid={props['data-testid'] as string}>{children}</a>
    ),
  }
})

vi.mock('@/components/job-sourcing/use-source-health-labels', () => ({
  stateBadgeVariant: () => 'secondary',
  useSourceHealthLabels: () => ({
    stateLabel: () => 'state',
    reasonLabel: () => 'reason',
    profileSummaryText: () => 'profile',
  }),
}))

const T0 = new Date('2026-11-11T12:00:00Z')
const health = {
  data: {
    items: [
      {
        id: 'src-1',
        type: 'REMOTIVE',
        state: 'FULL',
        reasonCode: null,
        enabled: true,
        profileSummary: null,
        lastCollectedAt: new Date(T0.getTime() - 10 * 60_000).toISOString(),
        newestItemPublishedAt: null,
      },
    ],
  },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}
vi.mock('@/hooks/use-job-source-admin', () => ({ useJobSourceHealth: () => health }))

import { Route } from '../sources.index'

const SourcesHealthPage = Route.options.component!

describe('SourcesHealthPage — relative freshness follows the clock', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    await loadCatalog('en')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-renders with the new relative time after time passes', () => {
    const { rerender } = render(<SourcesHealthPage />, { wrapper: I18nTestProvider })
    expect(screen.getByTestId('job-source-health-row').textContent).toContain('10 minutes ago')

    vi.setSystemTime(new Date(T0.getTime() + 2 * 60 * 60_000))
    rerender(<SourcesHealthPage />)

    expect(screen.getByTestId('job-source-health-row').textContent).toContain('2 hours ago')
  })
})
