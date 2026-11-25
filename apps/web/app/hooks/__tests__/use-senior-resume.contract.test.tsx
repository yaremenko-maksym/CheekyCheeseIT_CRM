/**
 * use-senior-resume.ts — the wire contract of every write hook (PR #1336
 * mutation gate): which endpoint, which body, which mutation key, which toast,
 * and how a confirm-step error is routed (inline / stale notice / toast).
 */
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_FACTS, EMPTY_RESUME_HEADER } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import {
  resumeQueryKey,
  useConfirmResume,
  useDeleteResume,
  useEditStagedField,
  useIngestResumeText,
  useRegenerateStagedField,
  useResumePdfBlob,
  useSaveResumeFacts,
  useSaveResumeHeader,
  useSaveResumeLayout,
  useSetResumeTemplate,
  useSubmitResume,
  useUploadResumeSource,
} from '../use-senior-resume'

const EMPTY_RESPONSE = { resume: null, canEdit: true, canConfirm: false }
const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>

function Probe({ hook, arg }: { hook: () => { mutate: (v: unknown) => void }; arg: unknown }) {
  const mutation = hook()
  return (
    <button data-testid="fire" onClick={() => mutation.mutate(arg)}>
      fire
    </button>
  )
}

let qc: QueryClient

function fire(hook: () => { mutate: (v: never) => void }, arg: unknown) {
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <Probe hook={hook as () => { mutate: (v: unknown) => void }} arg={arg} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  return { invalidate, click: () => userEvent.click(screen.getByTestId('fire')) }
}

const apiError = (code: string) =>
  Object.assign(new Error(code), {
    isAxiosError: true,
    response: { status: 409, data: { statusCode: 409, code, message: code } },
  })

beforeEach(async () => {
  await loadCatalog('uk')
  vi.clearAllMocks()
})

const FILE = new File(['x'], 'resume.pdf')

describe('each write hook calls its endpoint, under its key, and toasts its text', () => {
  it.each([
    {
      name: 'layout',
      hook: () => useSaveResumeLayout('u1'),
      arg: DEFAULT_RESUME_LAYOUT,
      method: 'put',
      url: '/users/u1/resume/layout',
      body: { layout: DEFAULT_RESUME_LAYOUT },
      key: ['save-senior-resume-layout', 'u1'],
      toastText: 'Оформлення оновлено',
      invalidates: true,
    },
    {
      name: 'header',
      hook: () => useSaveResumeHeader('u1'),
      arg: EMPTY_RESUME_HEADER,
      method: 'put',
      url: '/users/u1/resume/header',
      body: { header: EMPTY_RESUME_HEADER },
      key: ['save-senior-resume-header', 'u1'],
      toastText: 'Шапку резюме оновлено',
      invalidates: true,
    },
    {
      name: 'facts',
      hook: () => useSaveResumeFacts('u1'),
      arg: { facts: EMPTY_RESUME_FACTS },
      method: 'put',
      url: '/users/u1/resume/facts',
      body: { facts: EMPTY_RESUME_FACTS },
      key: ['save-senior-resume-facts', 'u1'],
      toastText: 'Чернетку збережено',
      invalidates: true,
    },
    {
      name: 'submit',
      hook: () => useSubmitResume('u1'),
      arg: undefined,
      method: 'post',
      url: '/users/u1/resume/submit',
      body: undefined,
      key: ['submit-senior-resume', 'u1'],
      toastText: 'Резюме надіслано на перевірку',
      invalidates: true,
    },
    {
      name: 'confirm',
      hook: () => useConfirmResume('u1'),
      arg: { runId: 'r1' },
      method: 'post',
      url: '/users/u1/resume/confirm',
      body: { runId: 'r1' },
      key: ['confirm-senior-resume', 'u1'],
      toastText: 'Резюме підтверджено',
      invalidates: true,
    },
    {
      name: 'edit staged',
      hook: () => useEditStagedField('u1'),
      arg: { runId: 'r1', path: 'summary', text: 'x' },
      method: 'put',
      url: '/users/u1/resume/staged',
      body: { runId: 'r1', path: 'summary', text: 'x' },
      key: ['edit-senior-resume-staged', 'u1'],
      toastText: 'Текст збережено',
      invalidates: true,
    },
    {
      name: 'template',
      hook: () => useSetResumeTemplate('u1'),
      arg: 'modern',
      method: 'put',
      url: '/users/u1/resume/template',
      body: { templateName: 'modern' },
      key: ['set-senior-resume-template', 'u1'],
      toastText: 'Шаблон змінено',
      invalidates: true,
    },
    {
      name: 'text',
      hook: () => useIngestResumeText('u1'),
      arg: 'cv text',
      method: 'post',
      url: '/users/u1/resume/text',
      body: { text: 'cv text' },
      key: ['ingest-senior-resume-text', 'u1'],
      toastText: 'Текст прийнято, розпізнаємо резюме',
      invalidates: false,
    },
    {
      name: 'delete',
      hook: () => useDeleteResume('u1'),
      arg: undefined,
      method: 'delete',
      url: '/users/u1/resume',
      body: undefined,
      key: ['delete-senior-resume', 'u1'],
      toastText: 'Резюме видалено',
      invalidates: false,
    },
  ] as const)('$name', async ({ hook, arg, method, url, body, key, toastText, invalidates }) => {
    const send = mocked(api[method])
    send.mockResolvedValue({ data: EMPTY_RESPONSE })
    const { invalidate, click } = fire(hook, arg)
    await click()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(toastText))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe(url)
    expect(send.mock.calls[0]?.[1]).toEqual(body)
    expect(qc.getMutationCache().getAll()[0]?.options.mutationKey).toEqual(key)
    expect(qc.getQueryData(resumeQueryKey('u1'))).toEqual(EMPTY_RESPONSE)
    expect(invalidate.mock.calls).toEqual(invalidates ? [[{ queryKey: resumeQueryKey('u1') }]] : [])
  })

  it('upload posts the file as multipart to /resume/source', async () => {
    const send = mocked(api.post)
    send.mockResolvedValue({ data: EMPTY_RESPONSE })
    const { click } = fire(() => useUploadResumeSource('u1'), FILE)
    await click()
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]?.[0]).toBe('/users/u1/resume/source')
    expect((send.mock.calls[0]?.[1] as FormData).get('file')).toBeInstanceOf(File)
    expect(qc.getMutationCache().getAll()[0]?.options.mutationKey).toEqual([
      'upload-senior-resume',
      'u1',
    ])
  })

  it('regenerate posts to staged/regenerate and shows no success toast', async () => {
    const send = mocked(api.post)
    send.mockResolvedValue({ data: EMPTY_RESPONSE })
    const { invalidate, click } = fire(() => useRegenerateStagedField('u1'), {
      runId: 'r1',
      path: 'summary',
    })
    await click()
    await waitFor(() => expect(invalidate).toHaveBeenCalled())
    expect(send.mock.calls[0]?.[0]).toBe('/users/u1/resume/staged/regenerate')
    expect(send.mock.calls[0]?.[1]).toEqual({ runId: 'r1', path: 'summary' })
    expect(qc.getMutationCache().getAll()[0]?.options.mutationKey).toEqual([
      'regenerate-senior-resume-staged',
      'u1',
    ])
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a silent facts save skips the toast but still caches and refetches', async () => {
    mocked(api.put).mockResolvedValue({ data: EMPTY_RESPONSE })
    const { invalidate, click } = fire(() => useSaveResumeFacts('u1'), {
      facts: EMPTY_RESUME_FACTS,
      silent: true,
    })
    await click()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: resumeQueryKey('u1') }))
    expect(qc.getQueryData(resumeQueryKey('u1'))).toEqual(EMPTY_RESPONSE)
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('confirm-step errors', () => {
  it('a stale run refetches without a toast (ruling R52)', async () => {
    mocked(api.post).mockRejectedValue(apiError('RESUME_CONFIRM_STALE'))
    const { invalidate, click } = fire(() => useConfirmResume('u1'), { runId: 'r1' })
    await click()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: resumeQueryKey('u1') }))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a rejected staged text stays inline: no toast, no refetch', async () => {
    mocked(api.put).mockRejectedValue(apiError('RESUME_STAGED_TEXT_INVALID'))
    const { invalidate, click } = fire(() => useEditStagedField('u1'), {
      runId: 'r1',
      path: 'summary',
      text: 'x',
    })
    await click()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    // Let the rejection settle before asserting absence.
    await waitFor(() => expect(qc.getMutationCache().getAll()[0]?.state.status).toBe('error'))
    expect(toast.error).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('the inline code of one hook is a plain toast for another', async () => {
    mocked(api.post).mockRejectedValue(apiError('RESUME_STAGED_TEXT_INVALID'))
    const { invalidate, click } = fire(() => useConfirmResume('u1'), { runId: 'r1' })
    await click()
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: resumeQueryKey('u1') })
  })

  it('any other error toasts and refetches', async () => {
    mocked(api.put).mockRejectedValue(apiError('RESUME_VERIFICATION_BUSY'))
    const { invalidate, click } = fire(() => useEditStagedField('u1'), {
      runId: 'r1',
      path: 'summary',
      text: 'x',
    })
    await click()
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: resumeQueryKey('u1') })
  })
})

describe('useResumePdfBlob', () => {
  const createUrl = vi.fn(() => 'blob:x')
  beforeEach(() => {
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() })
  })
  afterEach(() => createUrl.mockClear())

  it.each([
    ['pdf', '/users/u1/resume/pdf'],
    ['staged-pdf', '/users/u1/resume/staged-pdf'],
  ] as const)('%s is fetched as a blob from %s', async (file, url) => {
    mocked(api.get).mockResolvedValue({ data: new Blob(['%PDF']) })
    const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>
    const { result } = renderHook(() => useResumePdfBlob('u1', true, 'f1', file), { wrapper })
    await waitFor(() => expect(result.current.blobUrl).toBe('blob:x'))
    expect(mocked(api.get).mock.calls[0]?.[0]).toBe(url)
    expect(mocked(api.get).mock.calls[0]?.[1]).toEqual({
      responseType: 'blob',
      signal: expect.any(AbortSignal),
    })
  })

  it('fetches the confirmed PDF when no file is named', async () => {
    mocked(api.get).mockResolvedValue({ data: new Blob(['%PDF']) })
    const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>
    const { result } = renderHook(() => useResumePdfBlob('u1', true, 'f1'), { wrapper })
    await waitFor(() => expect(result.current.blobUrl).toBe('blob:x'))
    expect(mocked(api.get).mock.calls[0]?.[0]).toBe('/users/u1/resume/pdf')
  })
})
