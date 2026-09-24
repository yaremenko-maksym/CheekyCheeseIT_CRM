/**
 * use-invoices.ts's useSignInvoice — mutation-gate gap-fill
 * (task-i18n-stage3a, Task 2). `use-invoices.test.ts` covers query keys /
 * cache constants only; the mutation's toast text was never exercised.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { post: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { useSignInvoice } from '../use-invoices'

function MutationProbe() {
  const mutation = useSignInvoice()
  return (
    <button data-testid="fire" onClick={() => mutation.mutate('tx-1')}>
      fire
    </button>
  )
}

function renderProbe() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <MutationProbe />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  vi.clearAllMocks()
})

describe('useSignInvoice', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe()
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Рахунок підписано'))
  })

  it('error toast is a single sentence with a fallback, no doubled backend text', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({})
    renderProbe()
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося підписати рахунок. Спробуйте ще раз'),
    )
  })
})
