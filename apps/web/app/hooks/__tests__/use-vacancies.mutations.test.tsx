/**
 * use-vacancies.ts mutations — mutation-gate gap-fill (task-i18n-stage3a,
 * Task 2). None of the five mutation hooks' toast text was exercised by any
 * test before this file — component tests (CandidateCard/VacancyCard/
 * VacancySheet) mock the hook module entirely. Pins the exact uk toast text
 * for each hook's success AND error path.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import {
  useCreateVacancy,
  useUpdateVacancy,
  useDeleteVacancy,
  useUpdateVacancyApplication,
  useDeleteVacancyApplication,
} from '../use-vacancies'

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

describe('useCreateVacancy', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useCreateVacancy(), {} as never)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Вакансію створено'))
  })

  it('error toast falls back to the generic message when the backend sends none', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderProbe(() => useCreateVacancy(), {} as never)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося створити вакансію'),
    )
  })
})

describe('useUpdateVacancy', () => {
  it('success toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useUpdateVacancy(), { id: 'v-1', dto: {} } as never)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Вакансію оновлено'))
  })

  it('error toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderProbe(() => useUpdateVacancy(), { id: 'v-1', dto: {} } as never)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося оновити вакансію'))
  })
})

describe('useDeleteVacancy', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useDeleteVacancy(), 'v-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Вакансію видалено'))
  })

  it('error toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderProbe(() => useDeleteVacancy(), 'v-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося видалити вакансію'),
    )
  })
})

describe('useUpdateVacancyApplication', () => {
  it('error toast (success path has no toast — list badges only)', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderProbe(() => useUpdateVacancyApplication('v-1'), { appId: 'a-1', status: 'APPLIED' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося змінити статус відгуку'),
    )
  })
})

describe('useDeleteVacancyApplication', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useDeleteVacancyApplication('v-1'), 'a-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Відгук видалено'))
  })

  it('error toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderProbe(() => useDeleteVacancyApplication('v-1'), 'a-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося видалити відгук'))
  })
})
