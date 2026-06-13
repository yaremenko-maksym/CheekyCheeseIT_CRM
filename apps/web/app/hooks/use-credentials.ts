import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createCredentialSchema,
  projectCredentialSchema,
  revealResponseSchema,
  updateCredentialSchema,
  type CreateCredentialDto,
  type ProjectCredential,
  type UpdateCredentialDto,
} from '@crm/shared'
import { z } from 'zod'
import { api } from '@/lib/axios'
import { getAxiosStatus } from '@/lib/axios-utils'

const credentialListSchema = z.array(projectCredentialSchema)

/** React Query key prefix — list cache per project. */
const credentialsKey = (projectId: string) => ['credentials', projectId] as const

/**
 * Fetch credentials for a project.
 *
 * - 403 → viewer lacks access → returns null silently (component hides itself).
 *   This mirrors useHrContact / useLegend: 403 is "no access", not an error toast.
 * - All other errors propagate (retry policy below skips 400/403/404).
 *
 * NOTE: the list NEVER contains plaintext — reveal is a separate manual call.
 */
export function useCredentials(projectId: string | undefined, enabled = true) {
  return useQuery<ProjectCredential[] | null>({
    queryKey: credentialsKey(projectId ?? ''),
    queryFn: async () => {
      try {
        const res = await api.get<unknown>(`/projects/${projectId}/credentials`)
        return credentialListSchema.parse(res.data)
      } catch (err: unknown) {
        // 403 = no permission → hide the section (not an error state).
        if (getAxiosStatus(err) === 403) return null
        throw err
      }
    },
    enabled: enabled && !!projectId,
    staleTime: 30_000,
    retry: (failureCount, error: unknown) => {
      const status = getAxiosStatus(error)
      if (status === 403 || status === 404 || status === 400) return false
      return failureCount < 2
    },
  })
}

export function useCreateCredential(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateCredentialDto) => {
      const dto = createCredentialSchema.parse(data)
      return api
        .post<unknown>(`/projects/${projectId}/credentials`, dto)
        .then((r) => projectCredentialSchema.parse(r.data))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: credentialsKey(projectId) })
      toast.success('Пароль добавлен')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useUpdateCredential(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCredentialDto }) => {
      const dto = updateCredentialSchema.parse(data)
      return api
        .patch<unknown>(`/projects/${projectId}/credentials/${id}`, dto)
        .then((r) => projectCredentialSchema.parse(r.data))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: credentialsKey(projectId) })
      toast.success('Изменения сохранены')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useDeleteCredential(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/credentials/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: credentialsKey(projectId) })
      toast.success('Пароль удалён')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

/**
 * Manual reveal trigger — NOT an auto-fetch query.
 *
 * Returns a mutation; the caller invokes `.mutateAsync(credentialId)` on the
 * eye-click and keeps the plaintext in LOCAL component state only. The plaintext
 * is intentionally NOT written to the QueryClient cache (design §15 anti-pattern:
 * never cache plaintext). On 403/429/network the caller renders an inline error
 * — no toast here so the component owns the messaging.
 */
export function useRevealCredential(projectId: string) {
  return useMutation<string, unknown, string>({
    mutationFn: (credentialId: string) =>
      api
        .get<unknown>(`/projects/${projectId}/credentials/${credentialId}/reveal`)
        .then((r) => revealResponseSchema.parse(r.data).password),
  })
}

// ── User-scoped surface (task-junior-ut-round2 §6) ──────────────────────────
// Credentials of a JUNIOR's projects, viewed from that junior's profile by
// ADMIN / HR. Backend: GET/PATCH /api/users/:userId/credentials[/:id[/reveal]].
// Same security contract: list never carries plaintext; reveal is manual.

const userCredentialsKey = (userId: string) => ['user-credentials', userId] as const

export function useUserCredentials(userId: string | undefined, enabled = true) {
  return useQuery<ProjectCredential[] | null>({
    queryKey: userCredentialsKey(userId ?? ''),
    queryFn: async () => {
      try {
        const res = await api.get<unknown>(`/users/${userId}/credentials`)
        return credentialListSchema.parse(res.data)
      } catch (err: unknown) {
        // 403 = no access → hide the section (not an error state).
        if (getAxiosStatus(err) === 403) return null
        throw err
      }
    },
    enabled: enabled && !!userId,
    staleTime: 30_000,
    retry: (failureCount, error: unknown) => {
      const status = getAxiosStatus(error)
      if (status === 403 || status === 404 || status === 400) return false
      return failureCount < 2
    },
  })
}

export function useUpdateUserCredential(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCredentialDto }) => {
      const dto = updateCredentialSchema.parse(data)
      return api
        .patch<unknown>(`/users/${userId}/credentials/${id}`, dto)
        .then((r) => projectCredentialSchema.parse(r.data))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: userCredentialsKey(userId) })
      toast.success('Изменения сохранены')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useRevealUserCredential(userId: string) {
  return useMutation<string, unknown, string>({
    mutationFn: (credentialId: string) =>
      api
        .get<unknown>(`/users/${userId}/credentials/${credentialId}/reveal`)
        .then((r) => revealResponseSchema.parse(r.data).password),
  })
}
