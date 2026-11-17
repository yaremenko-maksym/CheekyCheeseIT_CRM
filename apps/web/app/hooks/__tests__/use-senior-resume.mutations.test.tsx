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
import { DEFAULT_RESUME_LAYOUT } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: { put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import {
  resumeQueryKey,
  useSaveResumeLayout,
  useUploadResumeSource,
  useIngestResumeText,
  useDeleteResume,
  useSubmitResume,
  useSaveResumeFacts,
} from '../use-senior-resume'
import { EMPTY_RESUME_FACTS } from '@crm/shared'

/** The envelope every resume write answers; `resume: null` is the empty state. */
const EMPTY_RESPONSE = { resume: null, canEdit: true, canConfirm: false }

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

let probeClient: QueryClient

function renderProbe<TVariables>(
  hook: () => { mutate: (variables: TVariables) => void },
  arg: TVariables,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  probeClient = qc
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
    ;(api.put as ReturnType<typeof vi.fn>).mockResolvedValue({ data: EMPTY_RESPONSE })
    renderProbe(() => useSaveResumeLayout('user-1'), {
      ...DEFAULT_RESUME_LAYOUT,
      density: 'compact',
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Оформлення оновлено'))
  })
})

describe('useUploadResumeSource', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: EMPTY_RESPONSE })
    renderProbe(() => useUploadResumeSource('user-1'), new File(['x'], 'resume.pdf'))
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Файл завантажено, розпізнаємо резюме'),
    )
  })
})

describe('useIngestResumeText', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: EMPTY_RESPONSE })
    renderProbe(() => useIngestResumeText('user-1'), 'resume text')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Текст прийнято, розпізнаємо резюме'),
    )
  })
})

describe('useDeleteResume', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: EMPTY_RESPONSE })
    renderProbe(() => useDeleteResume('user-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Резюме видалено'))
  })
})

describe('a malformed response never reaches the cache (FR-W-3)', () => {
  it.each([
    ['submit', () => useSubmitResume('user-1'), undefined, api.post],
    ['facts', () => useSaveResumeFacts('user-1'), { facts: EMPTY_RESUME_FACTS }, api.put],
    ['delete', () => useDeleteResume('user-1'), undefined, api.delete],
  ] as const)('%s: an error toast, no success toast, nothing cached', async (_, hook, arg, method) => {
    ;(method as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { resume: 'oops' } })
    renderProbe(hook as () => { mutate: (v: unknown) => void }, arg)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.success).not.toHaveBeenCalled()
    expect(probeClient.getQueryData(resumeQueryKey('user-1'))).toBeUndefined()
  })
})

describe('a busy answer on upload refetches the resume (FR-W-4)', () => {
  it('409 RESUME_VERIFICATION_BUSY toasts and invalidates the resume query', async () => {
    const busy = Object.assign(new Error('busy'), {
      isAxiosError: true,
      response: { status: 409, data: { error: { code: 'RESUME_VERIFICATION_BUSY' } } },
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(busy)
    renderProbe(() => useUploadResumeSource('user-1'), new File(['x'], 'resume.pdf'))
    const invalidate = vi.spyOn(probeClient, 'invalidateQueries')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: resumeQueryKey('user-1') }),
    )
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
