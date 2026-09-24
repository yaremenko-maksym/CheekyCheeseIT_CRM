/**
 * use-senior-resume.ts mutations — mutation-gate gap-fill (task-i18n-stage3a,
 * Task 2). None of the five mutation hooks' success toast text was
 * exercised by any test before this file. Pins the exact uk text; these
 * hooks' `onError` forwards the raw `e.message` (not a Lingui string) and
 * is outside this wave's perimeter.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import {
  useSaveResumeLayout,
  useSaveResumeContent,
  useUploadResumeSource,
  useIngestResumeText,
  useDeleteResume,
} from '../use-senior-resume'

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

describe('useSaveResumeLayout', () => {
  it('success toast', async () => {
    ;(api.put as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useSaveResumeLayout('user-1'), { density: 'compact' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Оформлення оновлено'))
  })
})

describe('useSaveResumeContent', () => {
  it('success toast', async () => {
    ;(api.put as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useSaveResumeContent('user-1'), {})
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Резюме збережено'))
  })
})

describe('useUploadResumeSource', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useUploadResumeSource('user-1'), new File(['x'], 'resume.pdf'))
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Файл завантажено, розпізнаємо резюме'),
    )
  })
})

describe('useIngestResumeText', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useIngestResumeText('user-1'), 'resume text')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Текст прийнято, розпізнаємо резюме'),
    )
  })
})

describe('useDeleteResume', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useDeleteResume('user-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Резюме видалено'))
  })
})
