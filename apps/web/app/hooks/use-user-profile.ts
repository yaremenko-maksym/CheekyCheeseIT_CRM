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
        // COPY-M-13 (copy-review PR #623 round 5): this branch's own comment
        // already says a no-op resubmit can't reach here — the submit button
        // is disabled on `isNoop` (`ChangePersonalEmailDialog`) — so in
        // practice this IS the removal branch, and the generic "Сохранено"
        // (the same word an admin-note edit gets) said nothing about the
        // access that was just revoked.
        toast.success('Личный адрес удалён — вход по нему больше не работает.')
      } else if (data.delivered) {
        toast.success('Письмо отправлено на личный адрес')
      } else {
        toast.error('Письмо не ушло — почтовый сервис не ответил. Попробуйте ещё раз через пару минут.')
      }
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

/**
 * task-pending-share (position 5, design spec §4.3). The affected SENIOR
 * confirms a proposed change to their OWN base share % — self-only by
 * construction (the endpoint 404s for anyone who isn't the invited
 * approver, same as `ProjectsService.approveDraft`'s pattern), so this is
 * only ever called with the viewer's own id. Invalidates both query keys
 * `useMe`/`useUser` can be reached through — the acting SENIOR's own
 * session reads via `['user-profile', 'me']`; the `userId`-keyed one is
 * invalidated too for the same defensive reason `useUpdateMe` refreshes
 * `['auth', 'me']` alongside its own key.
 */
export function useApproveSeniorShareChange(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    // Stryker disable next-line ArrowFunction: `.then((r) => r.data)`'s resolved value is never consumed — PendingBaseShareBanner's `approveMutation.mutate()` call has no onSuccess capturing it, and nothing reads `approveMutation.data`. Verified by hand: forcing this callback to `() => undefined` still passes every test in OverviewTab.pending-share.test.tsx (the mutationFn call itself, and the toast/invalidateQueries side effects, are separately proven and DO fail without this exact line).
    mutationFn: () => api.post(`/users/${userId}/senior-share/approve`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      toast.success('Новый процент подтверждён')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

/** Rejection counterpart of `useApproveSeniorShareChange` — reason required (design spec §3 decision 3). */
export function useRejectSeniorShareChange(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (reason: string) =>
      // Stryker disable next-line ArrowFunction: same reasoning as useApproveSeniorShareChange's identical line above — the resolved value is never consumed.
      api.post(`/users/${userId}/senior-share/reject`, { reason }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      toast.success('Предложение отклонено')
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
