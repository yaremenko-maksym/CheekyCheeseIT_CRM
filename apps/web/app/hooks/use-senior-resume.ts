/**
 * Senior resume queries/mutations (task-resume-base §3).
 *
 * Polling: while the server-side extraction is QUEUED or RUNNING the query
 * re-fetches every few seconds and stops the moment a terminal state
 * (READY / FAILED) arrives. That is what turns "a spinner forever" into real
 * progress the user can walk away from and come back to.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ResumeContent, SeniorResumeResponse } from '@crm/shared'
import { api } from '@/lib/axios'

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
      api.get<SeniorResumeResponse>(`/users/${userId}/resume`).then((r) => r.data ?? null),
    enabled: enabled && !!userId,
    // Personal data + a state machine that moves on the server: never serve a
    // stale snapshot from cache when the tab is re-opened.
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'QUEUED' || status === 'RUNNING' ? POLL_INTERVAL_MS : false
    },
  })
}

export function useSaveResumeContent(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['save-senior-resume', userId],
    mutationFn: (content: ResumeContent) =>
      api
        .put<SeniorResumeResponse>(`/users/${userId}/resume`, { content })
        .then((r) => r.data ?? null),
    onSuccess: (data) => {
      // Write the server's answer straight into the cache so `version` and
      // `updatedBy` are correct immediately, then revalidate.
      qc.setQueryData(resumeQueryKey(userId), data)
      void qc.invalidateQueries({ queryKey: resumeQueryKey(userId) })
      toast.success('Резюме сохранено')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUploadResumeSource(userId: string) {
  const qc = useQueryClient()
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
        .then((r) => r.data ?? null)
    },
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      toast.success('Файл загружен, распознаём резюме')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useIngestResumeText(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['ingest-senior-resume-text', userId],
    mutationFn: (text: string) =>
      api
        .post<SeniorResumeResponse>(`/users/${userId}/resume/text`, { text })
        .then((r) => r.data ?? null),
    onSuccess: (data) => {
      qc.setQueryData(resumeQueryKey(userId), data)
      toast.success('Текст принят, распознаём резюме')
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
