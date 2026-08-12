import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSourceDto, JobSourceListDto } from '@crm/shared'

import { SourceBudgetPanel, formatResetAt } from '../SourceBudgetPanel'

/**
 * task-vacancy-matching AC7 — "остаток бюджета виден в интерфейсе".
 *
 * The defect these tests exist to prevent is not a missing number but a
 * MISLEADING silence: when an allowance runs out the collector refuses to fetch,
 * and from the outside that looks exactly like a quiet day. So the panel must
 * say the remainder BEFORE it runs out, and say WHEN it returns after it does —
 * the same shape ResumeStatusPanel uses for the model's daily quota.
 */

let mockSources: JobSourceListDto = { items: [] }
let mockState = { isLoading: false, isError: false }

vi.mock('@/hooks/use-job-sourcing', () => ({
  useJobSources: (enabled: boolean) => ({
    data: enabled ? mockSources : undefined,
    isLoading: mockState.isLoading,
    isError: mockState.isError,
  }),
}))

const source = (over: Partial<JobSourceDto> = {}): JobSourceDto => ({
  id: '55555555-5555-4555-8555-555555555555',
  type: 'DOU_RSS',
  enabled: true,
  triggerMode: 'SCHEDULED',
  lastCollectedAt: '2026-08-12T05:00:00.000Z',
  budget: {
    state: 'UNLIMITED',
    limit: null,
    window: null,
    used: 0,
    remaining: null,
    resetsAt: null,
  },
  ...over,
})

function renderPanel(canView = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SourceBudgetPanel canView={canView} />
    </QueryClientProvider>,
  )
}

describe('SourceBudgetPanel (AC7)', () => {
  beforeEach(() => {
    mockSources = { items: [source()] }
    mockState = { isLoading: false, isError: false }
  })

  it('renders nothing for a viewer who may not see budgets', () => {
    renderPanel(false)
    expect(screen.queryByTestId('job-source-budgets')).toBeNull()
  })

  it('shows the remaining allowance and the limit it counts against', async () => {
    mockSources = {
      items: [
        source({
          budget: {
            state: 'ACTIVE',
            limit: 200,
            window: 'MONTH',
            used: 153,
            remaining: 47,
            resetsAt: '2026-09-01T00:00:00.000Z',
          },
        }),
      ],
    }
    renderPanel()

    expect(await screen.findByTestId('job-source-budget-remaining')).toHaveTextContent(
      'Осталось 47 из 200 в месяц',
    )
  })

  it('names the reset moment, not just the fact that it is spent', async () => {
    // "Лимит исчерпан" on its own gives an operator nothing to plan around.
    mockSources = {
      items: [
        source({
          budget: {
            state: 'EXHAUSTED',
            limit: 200,
            window: 'MONTH',
            used: 200,
            remaining: 0,
            resetsAt: '2026-09-01T00:00:00.000Z',
          },
        }),
      ],
    }
    renderPanel()

    const remaining = await screen.findByTestId('job-source-budget-remaining')
    expect(remaining).toHaveTextContent('Лимит исчерпан')
    expect(remaining).toHaveTextContent('обновится')
  })

  it('says a source has no limit rather than showing a blank remainder', async () => {
    renderPanel()
    expect(await screen.findByTestId('job-source-budget-unlimited')).toHaveTextContent(
      'Без лимита запросов',
    )
  })

  it('names how each source may be triggered', async () => {
    mockSources = {
      items: [
        source({
          triggerMode: 'MANUAL',
          budget: {
            state: 'ACTIVE',
            limit: 200,
            window: 'MONTH',
            used: 0,
            remaining: 200,
            resetsAt: '2026-09-01T00:00:00.000Z',
          },
        }),
      ],
    }
    renderPanel()

    expect(await screen.findByTestId('job-source-budget-row')).toHaveTextContent('по кнопке')
  })

  /**
   * Code review MED-4 — a broken limiter must LOOK broken.
   *
   * The panel used to infer "unlimited" from `limit === null || window === null`,
   * so a source whose cap the collector cannot use — and which therefore refuses
   * every request — was shown as "без лимита запросов". That is the restriction
   * presenting as WEAKER than it is, which is the one direction this codebase
   * treats as never acceptable.
   */
  it('shows a misconfigured limit as broken, NOT as "без лимита"', async () => {
    mockSources = {
      items: [
        source({
          budget: {
            state: 'MISCONFIGURED',
            limit: 0,
            window: null,
            used: 0,
            remaining: 0,
            resetsAt: null,
          },
        }),
      ],
    }
    renderPanel()

    expect(await screen.findByTestId('job-source-budget-broken')).toHaveTextContent(
      'Лимит настроен неверно',
    )
    // The exact confusion this fixes: it must NOT read as an unrestricted source.
    expect(screen.queryByTestId('job-source-budget-unlimited')).toBeNull()
  })

  it('still names the source and its trigger while it is broken', async () => {
    mockSources = {
      items: [
        source({
          triggerMode: 'MANUAL',
          budget: {
            state: 'MISCONFIGURED',
            limit: 0,
            window: 'MONTH',
            used: 0,
            remaining: 0,
            resetsAt: null,
          },
        }),
      ],
    }
    renderPanel()

    expect(await screen.findByTestId('job-source-budget-row')).toHaveTextContent('по кнопке')
  })

  /**
   * The rendering branches, asserted one by one.
   *
   * Raised by the mutation gate: every label, every `&&` and every fallback in
   * this component could be flipped or blanked with the suite still green — a
   * panel whose whole job is to say WHICH state a budget is in was asserting
   * almost none of the states it can render.
   */
  describe('each label and branch renders its own text', () => {
    const withBudget = (
      over: Partial<JobSourceDto['budget']>,
      triggerMode?: JobSourceDto['triggerMode'],
    ) => {
      mockSources = {
        items: [
          source({
            ...(triggerMode ? { triggerMode } : {}),
            budget: {
              state: 'ACTIVE',
              limit: 200,
              window: 'MONTH',
              used: 10,
              remaining: 190,
              resetsAt: '2026-09-01T00:00:00.000Z',
              ...over,
            },
          }),
        ],
      }
    }

    it('names a DAY window differently from a MONTH one', async () => {
      withBudget({ window: 'DAY', limit: 250, used: 3, remaining: 247 })
      renderPanel()
      expect(await screen.findByTestId('job-source-budget-remaining')).toHaveTextContent(
        'Осталось 247 из 250 в сутки',
      )
    })

    it('names each trigger mode', async () => {
      for (const [mode, label] of [
        ['SCHEDULED', 'по расписанию'],
        ['MANUAL', 'по кнопке'],
        ['BOTH', 'по расписанию и по кнопке'],
      ] as const) {
        withBudget({}, mode)
        const { unmount } = renderPanel()
        expect(await screen.findByTestId('job-source-budget-row')).toHaveTextContent(label)
        unmount()
      }
    })

    it('announces the spend to screen readers only while there is some', async () => {
      withBudget({ used: 47, remaining: 153 })
      renderPanel()
      expect(await screen.findByTestId('job-source-budget-remaining')).toHaveTextContent(
        'израсходовано 47',
      )
    })

    it('says nothing about spend on an untouched budget', async () => {
      withBudget({ used: 0, remaining: 200 })
      renderPanel()
      expect(await screen.findByTestId('job-source-budget-remaining')).not.toHaveTextContent(
        'израсходовано',
      )
    })

    it('omits the reset clause when there is no reset instant', async () => {
      withBudget({ resetsAt: null })
      renderPanel()
      expect(await screen.findByTestId('job-source-budget-remaining')).not.toHaveTextContent(
        'обновится',
      )
    })

    it('shows a loading line instead of an empty list while fetching', async () => {
      mockState = { isLoading: true, isError: false }
      renderPanel()
      expect(await screen.findByTestId('job-source-budgets')).toHaveTextContent('Загрузка…')
      expect(screen.queryByTestId('job-source-budget-row')).toBeNull()
    })

    it('does not show the error line while still loading', async () => {
      mockState = { isLoading: true, isError: true }
      renderPanel()
      await screen.findByTestId('job-source-budgets')
      expect(screen.queryByTestId('job-source-budgets-error')).toBeNull()
    })

    it('marks an exhausted budget urgently and a healthy one quietly', async () => {
      // The colour is the signal an operator scans for, so it is asserted like
      // any other output: destructive when spent, muted while there is room.
      withBudget({ used: 200, remaining: 0 })
      mockSources.items[0]!.budget.state = 'EXHAUSTED'
      const { unmount } = renderPanel()
      expect(await screen.findByTestId('job-source-budget-remaining')).toHaveClass(
        'text-destructive',
      )
      unmount()

      withBudget({ used: 10, remaining: 190 })
      renderPanel()
      const healthy = await screen.findByTestId('job-source-budget-remaining')
      expect(healthy).toHaveClass('text-muted-foreground')
      expect(healthy).not.toHaveClass('text-destructive')
    })

    it('does not claim "не настроены" while sources are listed', async () => {
      withBudget({})
      renderPanel()
      await screen.findByTestId('job-source-budget-row')
      expect(screen.getByTestId('job-source-budgets')).not.toHaveTextContent(
        'Источники не настроены',
      )
    })

    it('survives a response that carries no items array at all', async () => {
      // `data` is undefined for a viewer whose query never ran; the optional
      // chaining is what keeps that from throwing mid-render.
      mockSources = undefined as unknown as JobSourceListDto
      renderPanel()
      expect(await screen.findByTestId('job-source-budgets')).toHaveTextContent(
        'Источники не настроены',
      )
    })
  })

  describe('formatResetAt', () => {
    it('renders a human date for a real instant', () => {
      expect(formatResetAt('2026-09-01T00:00:00.000Z')).toContain('сентября')
    })

    it('returns an empty string for null or an unparseable value', () => {
      expect(formatResetAt(null)).toBe('')
      expect(formatResetAt('not-a-date')).toBe('')
    })
  })

  it('reports a failure to load instead of showing an empty list', async () => {
    mockState = { isLoading: false, isError: true }
    renderPanel()

    expect(await screen.findByTestId('job-source-budgets-error')).toBeInTheDocument()
    expect(screen.queryByTestId('job-source-budget-row')).toBeNull()
  })

  it('says so when no sources are configured', async () => {
    mockSources = { items: [] }
    renderPanel()

    expect(await screen.findByTestId('job-source-budgets')).toHaveTextContent(
      'Источники не настроены',
    )
  })
})
