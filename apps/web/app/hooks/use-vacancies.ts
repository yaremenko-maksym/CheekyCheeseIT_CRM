/**
 * TanStack Query hooks for task-crm-vacancies-ui — admin (ADMIN | HR) CRUD
 * surface over `/api/vacancies/**`. Public landing endpoints (`/api/public/
 * vacancies/**`) are a SEPARATE surface (apps/landing) and have no hooks here.
 *
 * There is no `GET /vacancies/:id` admin endpoint (see vacancies.controller.ts
 * — only `list()`/`create()`/`update()`/`remove()` + applications sub-routes).
 * `useVacancy()` therefore derives a single vacancy from the SAME list query
 * (shared `queryKey`/`queryFn` with `useVacancies()`) via `select` — one
 * network fetch backs both the list page and the detail page.
 *
 * PII: vacancy applications carry candidate email/telegram/links — NEVER
 * added to the persist-query allow-list (project_persist_query_allowlist).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  CreateVacancy,
  UpdateVacancy,
  UpdateVacancyApplication,
  Vacancy,
  VacancyApplication,
  VacancyApplicationResumeUrl,
} from '@crm/shared'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'

// ---------------------------------------------------------------------------
// Query: list (admin) — also backs useVacancy() below
// ---------------------------------------------------------------------------

export const VACANCIES_QUERY_KEY = ['vacancies'] as const

async function fetchVacancies(): Promise<Vacancy[]> {
  const res = await api.get<Vacancy[]>('/vacancies')
  return res.data
}

export function useVacancies(): UseQueryResult<Vacancy[], Error> {
  return useQuery<Vacancy[], Error>({
    queryKey: VACANCIES_QUERY_KEY,
    queryFn: fetchVacancies,
  })
}

/**
 * Single vacancy, derived from the list cache. `data` is `undefined` while
 * loading and `null` once loaded if no vacancy with this id exists (deleted
 * concurrently / bad deep link) — callers render a "not found" state for the
 * latter, a skeleton for the former.
 */
export function useVacancy(vacancyId: string): UseQueryResult<Vacancy | null, Error> {
  return useQuery<Vacancy[], Error, Vacancy | null>({
    queryKey: VACANCIES_QUERY_KEY,
    queryFn: fetchVacancies,
    select: (vacancies) => vacancies.find((v) => v.id === vacancyId) ?? null,
  })
}

// ---------------------------------------------------------------------------
// Mutations: create / update (incl. status transitions) / delete
// ---------------------------------------------------------------------------

export function useCreateVacancy(): UseMutationResult<Vacancy, Error, CreateVacancy> {
  const qc = useQueryClient()
  return useMutation<Vacancy, Error, CreateVacancy>({
    mutationFn: async (dto) => {
      const res = await api.post<Vacancy>('/vacancies', dto)
      return res.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: VACANCIES_QUERY_KEY })
      toast.success('Вакансия создана')
    },
    onError: (e) => toast.error(getApiErrorMessage(e, 'Не удалось создать вакансию')),
  })
}

export function useUpdateVacancy(): UseMutationResult<
  Vacancy,
  Error,
  { id: string; dto: UpdateVacancy }
> {
  const qc = useQueryClient()
  return useMutation<Vacancy, Error, { id: string; dto: UpdateVacancy }>({
    mutationFn: async ({ id, dto }) => {
      const res = await api.patch<Vacancy>(`/vacancies/${id}`, dto)
      return res.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: VACANCIES_QUERY_KEY })
      toast.success('Вакансия обновлена')
    },
    onError: (e) => toast.error(getApiErrorMessage(e, 'Не удалось обновить вакансию')),
  })
}

export function useDeleteVacancy(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await api.delete(`/vacancies/${id}`)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: VACANCIES_QUERY_KEY })
      toast.success('Вакансия удалена')
    },
    // §7: backend ConflictException already carries a ready Russian message —
    // just forward it (defensive fallback for a race the UI guard missed).
    onError: (e) => toast.error(getApiErrorMessage(e, 'Не удалось удалить вакансию')),
  })
}

// ---------------------------------------------------------------------------
// Query: applications (admin, per vacancy)
// ---------------------------------------------------------------------------

export function applicationsQueryKey(vacancyId: string) {
  return ['vacancies', vacancyId, 'applications'] as const
}

export function useVacancyApplications(
  vacancyId: string,
): UseQueryResult<VacancyApplication[], Error> {
  return useQuery<VacancyApplication[], Error>({
    queryKey: applicationsQueryKey(vacancyId),
    queryFn: async () => {
      const res = await api.get<VacancyApplication[]>(`/vacancies/${vacancyId}/applications`)
      return res.data
    },
    enabled: Boolean(vacancyId),
  })
}

// ---------------------------------------------------------------------------
// Mutations: application status / delete
// ---------------------------------------------------------------------------

export function useUpdateVacancyApplication(
  vacancyId: string,
): UseMutationResult<VacancyApplication, Error, { appId: string; status: UpdateVacancyApplication['status'] }> {
  const qc = useQueryClient()
  return useMutation<
    VacancyApplication,
    Error,
    { appId: string; status: UpdateVacancyApplication['status'] }
  >({
    mutationFn: async ({ appId, status }) => {
      const res = await api.patch<VacancyApplication>(
        `/vacancies/${vacancyId}/applications/${appId}`,
        { status },
      )
      return res.data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: applicationsQueryKey(vacancyId) })
      // Vacancy list carries `applicationsCount`/new-count badges — keep in sync.
      void qc.invalidateQueries({ queryKey: VACANCIES_QUERY_KEY })
    },
    onError: (e) => toast.error(getApiErrorMessage(e, 'Не удалось изменить статус отклика')),
  })
}

export function useDeleteVacancyApplication(
  vacancyId: string,
): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (appId) => {
      await api.delete(`/vacancies/${vacancyId}/applications/${appId}`)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: applicationsQueryKey(vacancyId) })
      void qc.invalidateQueries({ queryKey: VACANCIES_QUERY_KEY })
      toast.success('Отклик удалён')
    },
    onError: (e) => toast.error(getApiErrorMessage(e, 'Не удалось удалить отклик')),
  })
}

// ---------------------------------------------------------------------------
// Query: presigned resume download URL
// ---------------------------------------------------------------------------

/**
 * §6: TTL is 600s (RESUME_PRESIGN_TTL_SEC) — much shorter than documents'
 * 24h presign, so we do NOT copy DOCUMENT_URL_STALE_MS. staleTime 0 means
 * every `refetch()` call gets a fresh URL; the query result is only ever
 * consumed once (immediately `window.open`ed), so there is no benefit to
 * caching a URL that might already be half-expired by the time it's reused.
 */
export function useApplicationResumeUrl(
  vacancyId: string,
  appId: string | undefined,
  options?: { enabled?: boolean },
): UseQueryResult<VacancyApplicationResumeUrl, Error> {
  return useQuery<VacancyApplicationResumeUrl, Error>({
    queryKey: ['vacancies', vacancyId, 'applications', appId, 'resume-url'],
    queryFn: async () => {
      const res = await api.get<VacancyApplicationResumeUrl>(
        `/vacancies/${vacancyId}/applications/${appId}/resume-url`,
      )
      return res.data
    },
    enabled: Boolean(appId) && (options?.enabled ?? true),
    staleTime: 0,
    retry: 1,
  })
}

/**
 * task-candidate-card-resume (AC2) — inline-disposition presigned URL for
 * the in-CRM resume preview dialog. Same `staleTime: 0` as the sibling
 * download hook above (deliberately — every open re-fetches a fresh URL, so
 * the client-side query cache can never outlive the server's presign TTL;
 * see the task's "клиентский кеш не должен переживать подпись" AC).
 */
export function useApplicationResumePreviewUrl(
  vacancyId: string,
  appId: string | undefined,
  options?: { enabled?: boolean },
): UseQueryResult<VacancyApplicationResumeUrl, Error> {
  return useQuery<VacancyApplicationResumeUrl, Error>({
    queryKey: ['vacancies', vacancyId, 'applications', appId, 'resume-preview-url'],
    queryFn: async () => {
      const res = await api.get<VacancyApplicationResumeUrl>(
        `/vacancies/${vacancyId}/applications/${appId}/resume-preview-url`,
      )
      return res.data
    },
    enabled: Boolean(appId) && (options?.enabled ?? true),
    staleTime: 0,
    retry: 1,
  })
}
