import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSourceDto, JobSourceListDto } from '@crm/shared'

import { SourceBudgetPanel } from '../SourceBudgetPanel'

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
  budget: { limit: null, window: null, used: 0, remaining: null, resetsAt: null },
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
