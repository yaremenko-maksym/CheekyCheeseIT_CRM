/**
 * Senior resume queries/mutations (task-resume-base §3).
 *
 * Polling: while the server-side extraction is QUEUED or RUNNING the query
 * re-fetches every few seconds and stops the moment a terminal state
 * (READY / FAILED) arrives. That is what turns "a spinner forever" into real
 * progress the user can walk away from and come back to.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useLingui } from '@lingui/react/macro'
import type {
  ConfirmResumeInput,
  EditStagedFieldInput,
  RegenerateStagedFieldInput,
  ResumeFacts,
  ResumeLayoutOptions,
  SeniorResumeResponse,
} from '@crm/shared'
import { api } from '@/lib/axios'
import { getApiErrorCode, getUserFacingErrorMessage } from '@/lib/axios-utils'

/** Same base the axios client uses — needed for plain <a href> downloads. */
export const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? '/api'

const POLL_INTERVAL_MS = 2500

export function resumeQueryKey(userId: string): [string, string] {
  return ['senior-resume', userId]
}

export function useSeniorResume(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: resumeQueryKey(userId ?? ''),
    queryFn: () =>
      api.get<SeniorResumeResponse>(`/users/${userId}/resume`).then((r) => r.data),
    enabled: enabled && !!userId,
    // Personal data + a state machine that moves on the server: never serve a
    // stale snapshot from cache when the tab is re-opened.
    staleTime: 0,
    refetchInterval: (query) => {
      const resume = query.state.data?.resume
      const extracting = resume?.status === 'QUEUED' || resume?.status === 'RUNNING'
      // The PDF is built by a job too, so the same polling rule has to cover
      // it — otherwise the preview sits on "готовим" until the user reloads by
      // hand, which is the failure the extraction polling already exists to
      // avoid.
      const rendering = resume?.renderStatus === 'QUEUED' || resume?.renderStatus === 'RUNNING'
      // A check run moves the row on the server too (QUEUED → CHECKING → result).
      const checking = resume?.verificationBusy === true
      return extracting || rendering || checking ? POLL_INTERVAL_MS : false
    },
  })
}

/**
 * Save the layout switches.
 *
 * A separate mutation from the content save on purpose: they are different
 * kinds of change (what the resume SAYS vs how it is SET), they have different
 * endpoints, and mixing them would mean flipping a density toggle re-submits
 * every field the user happens to have open.
 */
/**
 * The rendered PDF as a blob URL, for inline preview.
 *
 * WHY A BLOB AND NOT THE URL DIRECTLY. `GET /users/:id/resume/pdf` answers with
 * `Content-Disposition: attachment` — correct for the download button, and fatal
 * for an embedded viewer: pointing an `<object>`/`<iframe>` at that URL renders
 * a blank frame in every browser, at every width, in both themes. The element is
 * present the whole time and simply shows nothing, which is exactly why "the
 * preview works" cannot be asserted by finding the element in the markup.
 *
 * `fetch`/XHR ignores `Content-Disposition` entirely, so reading the response
 * into a Blob and handing the viewer an object URL sidesteps the header without
 * the API needing a second, inline-serving route. Same shape as
 * `fetchContractPdfBlob` and `useDocumentBlob` — a pattern that exists in this
 * repository precisely because of this header.
 *
 * Refetches when `fingerprint` changes: that is how a fresh render reaches the
 * screen, since the server moves it whenever content, layout or template do.
 */
export function useResumePdfBlob(
  userId: string,
  enabled: boolean,
  fingerprint: string | null,
  /** `staged-pdf` = the check run's PDF awaiting Confirm (same headers, same reason). */
  file: 'pdf' | 'staged-pdf' = 'pdf',
): { blobUrl: string | null; isLoading: boolean; hasError: boolean } {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const revokeRef = useRef<(() => void) | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort()
      revokeRef.current?.()
      revokeRef.current = null
      setBlobUrl(null)
      setIsLoading(false)
      setHasError(false)
      return
    }

    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setIsLoading(true)
    setHasError(false)

    void api
      .get<Blob>(`/users/${userId}/resume/${file}`, {
        responseType: 'blob',
        signal: controller.signal,
      })
      .then((res) => {
        if (controller.signal.aborted) return
        // Release the previous document before replacing it, or every layout
        // change leaks a PDF's worth of memory for the tab's lifetime.
        revokeRef.current?.()
        const url = URL.createObjectURL(res.data)
        revokeRef.current = () => URL.revokeObjectURL(url)
        setBlobUrl(url)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof Error && err.name === 'CanceledError') return
        setHasError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })

    return () => controller.abort()
  }, [userId, enabled, fingerprint, file])

  useEffect(() => {
    const revoke = revokeRef
    const abort = abortRef
    return () => {
      abort.current?.abort()
      revoke.current?.()
      revoke.current = null
    }
  }, [])

  return { blobUrl, isLoading, hasError }
}

export function useSaveResumeLayout(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  return useMutation({
    mutationKey: ['save-senior-resume-layout', userId],
    mutationFn: (layout: ResumeLayoutOptions) =>
      api.put<SeniorResumeResponse>(`/users/${userId}/resume/layout`, { layout }).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      void qc.invalidateQueries({ queryKey: resumeQueryKey(userId) })
      toast.success(t`Оформлення оновлено`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

/**
 * A facts or submit write failed. Every error toasts its catalog text (409
 * RESUME_VERIFICATION_BUSY, 422 RESUME_INCOMPLETE / RESUME_CUSTOM_TEMPLATE) and
 * refetches: a busy answer means the server state moved, and the UI must
 * become that state rather than keep guessing.
 */
function useResumeWriteError(userId: string) {
  const qc = useQueryClient()
  return (e: unknown) => {
    toast.error(getUserFacingErrorMessage(e))
    void qc.invalidateQueries({ queryKey: resumeQueryKey(userId) })
  }
}

/** `PUT facts`. `silent` skips the "saved" toast when Submit saves first. */
export function useSaveResumeFacts(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  const onError = useResumeWriteError(userId)
  return useMutation({
    mutationKey: ['save-senior-resume-facts', userId],
    mutationFn: ({ facts }: { facts: ResumeFacts; silent?: boolean }) =>
      api
        .put<SeniorResumeResponse>(`/users/${userId}/resume/facts`, { facts })
        .then((r) => r.data),
    onSuccess: (data, { silent }) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      void qc.invalidateQueries({ queryKey: resumeQueryKey(userId) })
      if (!silent) toast.success(t`Чернетку збережено`)
    },
    onError,
  })
}

/** `POST submit` — starts the check run. */
export function useSubmitResume(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  const onError = useResumeWriteError(userId)
  return useMutation({
    mutationKey: ['submit-senior-resume', userId],
    mutationFn: () =>
      api.post<SeniorResumeResponse>(`/users/${userId}/resume/submit`).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      void qc.invalidateQueries({ queryKey: resumeQueryKey(userId) })
      toast.success(t`Резюме надіслано на перевірку`)
    },
    onError,
  })
}

/**
 * A confirm-step write (`POST confirm`, `PUT staged`, `POST staged/regenerate`).
 * Each carries `staged.runId`; a stale runId or version answers 409
 * (RESUME_CONFIRM_STALE), which shows the confirm step's inline notice instead
 * of a toast (ruling R52) and refetches. Every other error toasts.
 * `inlineCode` is an error the caller shows next to its field instead of a toast.
 */
function useStagedAction<TInput>(
  userId: string,
  key: string,
  send: (input: TInput) => Promise<{ data: SeniorResumeResponse }>,
  successText?: () => string,
  inlineCode?: string,
) {
  const qc = useQueryClient()
  const onWriteError = useResumeWriteError(userId)
  return useMutation({
    mutationKey: [key, userId],
    mutationFn: (input: TInput) => send(input).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      void qc.invalidateQueries({ queryKey: resumeQueryKey(userId) })
      if (successText) toast.success(successText())
    },
    onError: (e: unknown) => {
      const code = getApiErrorCode(e)
      if (inlineCode !== undefined && code === inlineCode) return
      // Ruling R52: the confirm step's inline notice is the only message for a stale run.
      if (code === 'RESUME_CONFIRM_STALE') {
        void qc.invalidateQueries({ queryKey: resumeQueryKey(userId) })
        return
      }
      onWriteError(e)
    },
  })
}

/** `POST confirm` — ADMIN/HR only; the server promotes the staged result. */
export function useConfirmResume(userId: string) {
  const { t } = useLingui()
  return useStagedAction(
    userId,
    'confirm-senior-resume',
    (input: ConfirmResumeInput) => api.post(`/users/${userId}/resume/confirm`, input),
    () => t`Резюме підтверджено`,
  )
}

/** `PUT staged` — one staged text rewritten by hand; a rejected text shows under its field. */
export function useEditStagedField(userId: string) {
  const { t } = useLingui()
  return useStagedAction(
    userId,
    'edit-senior-resume-staged',
    (input: EditStagedFieldInput) => api.put(`/users/${userId}/resume/staged`, input),
    () => t`Текст збережено`,
    'RESUME_STAGED_TEXT_INVALID',
  )
}

/** `POST staged/regenerate` — the model rewrites one staged path. */
export function useRegenerateStagedField(userId: string) {
  return useStagedAction(
    userId,
    'regenerate-senior-resume-staged',
    (input: RegenerateStagedFieldInput) =>
      api.post(`/users/${userId}/resume/staged/regenerate`, input),
  )
}

export function useUploadResumeSource(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  return useMutation({
    mutationKey: ['upload-senior-resume', userId],
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file, file.name)
      return api
        .post<SeniorResumeResponse>(`/users/${userId}/resume/source`, form, {
          // Let axios set the multipart boundary automatically — same cast as
          // useUploadDocument (axios types forbid an explicit `undefined`
          // under exactOptionalPropertyTypes, but it is what clears the
          // client's default JSON Content-Type).
          headers: { 'Content-Type': undefined as unknown as string },
        })
        .then((r) => r.data)
    },
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      toast.success(t`Файл завантажено, розпізнаємо резюме`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useIngestResumeText(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  return useMutation({
    mutationKey: ['ingest-senior-resume-text', userId],
    mutationFn: (text: string) =>
      api
        .post<SeniorResumeResponse>(`/users/${userId}/resume/text`, { text })
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      toast.success(t`Текст прийнято, розпізнаємо резюме`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

/**
 * Erase the resume — record and stored original alike.
 *
 * The server answers with the same envelope as every other endpoint, so the
 * cache is written straight from the response and the tab falls back to its
 * empty state without a refetch round-trip. The source-file query is dropped
 * too: its presigned URL now points at an object that no longer exists.
 */
export function useDeleteResume(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  return useMutation({
    mutationKey: ['delete-senior-resume', userId],
    mutationFn: () =>
      api.delete<SeniorResumeResponse>(`/users/${userId}/resume`).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      qc.removeQueries({ queryKey: ['senior-resume-source', userId] })
      toast.success(t`Резюме видалено`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

/**
 * Presigned link to the ORIGINAL uploaded file.
 *
 * Fetched EAGERLY (as soon as the tab knows a file exists) rather than on
 * click: the presigned URL only arrives after a round-trip, and calling
 * `window.open` after an `await` is outside the user-gesture chain — mobile
 * browsers block it as a popup, which is exactly the "tap does nothing on a
 * phone" defect fixed in the candidate-resume card. Having the URL in hand
 * lets the button be a plain `<a href>`, which no browser blocks.
 *
 * `staleTime` stays under the 30-minute presign TTL for RESUME objects so a
 * cached URL can never outlive its signature.
 */
export function useResumeSourceUrl(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['senior-resume-source', userId],
    queryFn: () =>
      api
        .get<{ url: string; expiresAt: string; fileName: string }>(`/users/${userId}/resume/source`)
        .then((r) => r.data),
    enabled: enabled && !!userId,
    staleTime: 20 * 60 * 1000,
    retry: false,
  })
}

/**
 * URL of the rendered PDF. A direct same-origin GET, so the button can be a
 * plain link: the session cookie rides along and `Content-Disposition:
 * attachment` makes the browser download it without navigating away — no
 * popup, no blob juggling, works on mobile.
 */
export function resumePdfUrl(userId: string): string {
  return `${API_BASE_URL}/users/${userId}/resume/pdf`
}
