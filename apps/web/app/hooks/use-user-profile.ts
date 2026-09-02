import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  PaymentRequisites,
  SetNoteDto,
  UpdateProfileDto,
  UserWithPermissionsResponse,
} from '@crm/shared'
import { api } from '@/lib/axios'

export function useUser(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['user-profile', userId],
    queryFn: () =>
      api.get<UserWithPermissionsResponse>(`/users/${userId}`).then((r) => r.data),
    enabled: enabled && !!userId,
    staleTime: 30_000,
  })
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ['user-profile', 'me'],
    queryFn: () =>
      api.get<UserWithPermissionsResponse>('/users/me').then((r) => r.data),
    enabled,
    staleTime: 30_000,
  })
}

export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['update-me'],
    mutationFn: (data: UpdateProfileDto) =>
      api.patch('/users/me', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      // Refresh /auth/me — avatar / displayName feed the global header dropdown.
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      toast.success('Сохранено')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useUpdateMeRequisites() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['update-me-requisites'],
    mutationFn: (data: PaymentRequisites) =>
      api.patch('/users/me/requisites', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      toast.success('Реквизиты обновлены')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useAdminSetNote(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: SetNoteDto) =>
      api.patch(`/users/${userId}/note`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      toast.success('Заметка сохранена')
    },
  })
}

export function useArchiveUser(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete(`/users/${userId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['users-admin'] })
      toast.success('Пользователь архивирован')
    },
  })
}

/**
 * task-user-emails-invite (spec §5 — "Админ должен уметь выслать
 * приглашение заново"). Mirrors `useAdminSetNote`'s shape — invalidates the
 * profile query so `personalEmailCanLogin`/`personalContactVisible` (unlikely
 * to change here, but the row's `updatedAt` does) stay fresh, no optimistic
 * update (the action has no visible field to flip locally — a toast is the
 * whole UI signal).
 */
export function useResendPersonalEmailInvite(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api
        .post<{ ok: true; delivered: boolean }>(`/users/${userId}/personal-email/resend-invite`)
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      // COPY-M-1 (copy-review PR #623 round 4): the API now reports whether
      // the mail actually left the process — `sendInvite` swallows delivery
      // failures (no API key, exhausted retries) and used to unconditionally
      // return `{ ok: true }`, so this toast claimed «отправлено повторно»
      // even when nothing was sent.
      if (data.delivered) {
        toast.success('Письмо отправлено на личный адрес')
      } else {
        toast.error('Письмо не ушло — почтовый сервис не ответил. Попробуйте ещё раз через пару минут.')
      }
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

/**
 * ADMIN action (security-review PR #623 round 4, owner decision — see
 * `changePersonalEmailSchema`'s doc, `@crm/shared`). Changes or removes a
 * user's personal address; the backend revokes login on whatever address
 * was there before, unconditionally — see `UsersService.changePersonalEmail`.
 * `personalEmail: null` removes it.
 */
export function useChangePersonalEmail(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (personalEmail: string | null) =>
      api
        .patch<{ ok: true; delivered: boolean | null }>(`/users/${userId}/personal-email`, {
          personalEmail,
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      if (data.delivered === null) {
        // Removal, or a no-op resubmit of the same value — nothing was
        // mailed, nothing to report as sent/failed.
        toast.success('Сохранено')
      } else if (data.delivered) {
        toast.success('Письмо отправлено на личный адрес')
      } else {
        toast.error('Письмо не ушло — почтовый сервис не ответил. Попробуйте ещё раз через пару минут.')
      }
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useUnarchiveUser(userId: string, opts?: { isSenior?: boolean }) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post(`/users/${userId}/unarchive`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['users-admin'] })
      if (opts?.isSenior) {
        qc.invalidateQueries({ queryKey: ['teams'] })
      }
      const msg = opts?.isSenior
        ? 'Синьор и команда восстановлены'
        : 'Пользователь восстановлен из архива'
      toast.success(msg)
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}
