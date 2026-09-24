/**
 * use-documents.ts mutations — mutation-gate gap-fill (task-i18n-stage3a,
 * Task 2). `use-documents.test.ts` covers `presignStaleTime` only; the four
 * mutation hooks' toast text was never exercised — component tests mock the
 * hook module entirely. Pins the exact uk toast text for each hook's
 * success AND error path.
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
  useUploadDocument,
  useDeleteDocument,
  useRestoreDocument,
  useHardDeleteDocument,
} from '../use-documents'

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

describe('useUploadDocument', () => {
  const input = { file: new File(['x'], 'a.pdf'), category: 'RESUME' as const }

  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'doc-1' } })
    renderProbe(() => useUploadDocument(), input)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Документ завантажено'))
  })

  it('error toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useUploadDocument(), input)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося завантажити документ: boom'),
    )
  })
})

describe('useDeleteDocument', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useDeleteDocument(), 'doc-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Документ переміщено в кошик'),
    )
  })

  it('error toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useDeleteDocument(), 'doc-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося видалити документ: boom'),
    )
  })
})

describe('useRestoreDocument', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'doc-1' } })
    renderProbe(() => useRestoreDocument(), 'doc-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Документ відновлено'))
  })

  it('error toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useRestoreDocument(), 'doc-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося відновити документ: boom'),
    )
  })
})

describe('useHardDeleteDocument', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useHardDeleteDocument(), 'doc-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Документ видалено назавжди'),
    )
  })

  it('error toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useHardDeleteDocument(), 'doc-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося видалити документ: boom'),
    )
  })
})
