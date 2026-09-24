/**
 * use-job-sourcing.ts — `useUpdateJobSuggestionStatus` / `useDeleteJobExclusion`
 * mutation-gate gap-fill (task-i18n-stage3a, Task 2).
 * `use-job-sourcing.test.tsx` covers `useCreateJobExclusion` only — these two
 * hooks' toast text (and the APPLIED/other status branch) were never
 * exercised.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { useUpdateJobSuggestionStatus, useDeleteJobExclusion } from '../use-job-sourcing'

function MutationProbe<TVariables>({
  hook,
  arg,
}: {
  hook: () => { mutate: (variables: TVariables) => void }
  arg: TVariables
}) {
  const mutation = hook()
  return (
    <button data-testid="fire" onClick={() => mutation.mutate(arg)}>
      fire
    </button>
  )
}

function renderProbe<TVariables>(
  hook: () => { mutate: (variables: TVariables) => void },
  arg: TVariables,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <MutationProbe hook={hook} arg={arg} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  vi.clearAllMocks()
})

function makeSuggestion(status: 'APPLIED' | 'REJECTED') {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    seniorId: '22222222-2222-4222-8222-222222222222',
    status,
    statusChangedAt: null,
    statusChangedByName: null,
    createdAt: '2026-08-07T09:00:00.000Z',
    posting: {
      id: '33333333-3333-4333-8333-333333333333',
      sourceType: 'DOU_RSS',
      externalId: 'ext-1',
      url: 'https://jobs.dou.ua/companies/epam/vacancies/12345/',
      title: 'Node.js Developer',
      companyName: 'EPAM',
      location: 'Remote',
      descriptionMd: 'A job.',
      publishedAt: null,
      collectedAt: '2026-08-07T09:00:00.000Z',
    },
    matchScore: null,
    matchedKeywords: [],
  }
}

describe('useUpdateJobSuggestionStatus', () => {
  it('APPLIED status → "marked: applied" toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: makeSuggestion('APPLIED') })
    renderProbe(() => useUpdateJobSuggestionStatus(undefined), { id: 's-1', status: 'APPLIED' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Позначено: відгукнулися'))
  })

  it('any OTHER status (e.g. REJECTED) → the "vacancy hidden" toast, not the APPLIED one', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: makeSuggestion('REJECTED') })
    renderProbe(() => useUpdateJobSuggestionStatus(undefined), { id: 's-1', status: 'REJECTED' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Вакансію приховано'))
  })
})

describe('useDeleteJobExclusion', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useDeleteJobExclusion(undefined), 'excl-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Виняток видалено'))
  })

  it('error toast surfaces a user-facing message', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network Error'))
    renderProbe(() => useDeleteJobExclusion(undefined), 'excl-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const shown = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(shown).not.toBe('Network Error')
  })
})
