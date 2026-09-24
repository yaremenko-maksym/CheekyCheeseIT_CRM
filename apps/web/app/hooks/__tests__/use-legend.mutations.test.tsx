/**
 * use-legend.ts mutations — mutation-gate gap-fill (task-i18n-stage3a, Task 2).
 * Neither mutation hook's toast text was exercised by any test before this
 * file — component tests mock the hook module entirely. Pins the exact uk
 * toast text for each hook's success AND error path.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { useUpsertLegend, useAddLegendEntry } from '../use-legend'

const LEGEND = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  fullName: 'Іван Петренко',
  dateOfBirth: null,
  address: null,
  presentedRole: null,
  presentedStack: null,
  backstory: null,
  hobbies: null,
  notes: null,
  entries: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

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

describe('useUpsertLegend', () => {
  it('success toast', async () => {
    ;(api.put as ReturnType<typeof vi.fn>).mockResolvedValue({ data: LEGEND })
    renderProbe(() => useUpsertLegend('22222222-2222-4222-8222-222222222222'), {
      fullName: 'Іван Петренко',
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Легенду збережено'))
  })

  it('error toast', async () => {
    ;(api.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useUpsertLegend('22222222-2222-4222-8222-222222222222'), {
      fullName: 'Іван Петренко',
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося зберегти легенду: boom'),
    )
  })
})

describe('useAddLegendEntry', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: LEGEND })
    renderProbe(() => useAddLegendEntry('22222222-2222-4222-8222-222222222222'), {
      text: 'Зустріч з клієнтом',
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Запис додано'))
  })

  it('error toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useAddLegendEntry('22222222-2222-4222-8222-222222222222'), {
      text: 'Зустріч з клієнтом',
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося додати запис: boom'),
    )
  })
})
