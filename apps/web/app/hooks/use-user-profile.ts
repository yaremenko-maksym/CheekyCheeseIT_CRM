import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  PaymentRequisites,
  SetNoteDto,
  UpdateProfileDto,
  UserWithPermissionsResponse,
} from '@crm/shared'
import { api } from '@/lib/axios'
import { getApiErrorMessage, getAxiosStatus } from '@/lib/axios-utils'

/**
 * task-648-fix-round-1 (COPY-H-4). `ApprovalsService.assertRespondable`'s two
 * generic exceptions — 404 "нет живой строки" / 409 "уже получила ответ" —
 * are shared across every subject type (project drafts, senior-share
 * proposals, …), so their message is necessarily generic Russian, not
 * senior-share-specific. This maps the STATUS to a message that names the
 * actual next step for a caller sitting on a stale share-confirmation
 * banner, rather than surfacing the backend's generic wording verbatim
 * (`getApiErrorMessage`'s Priority 1 would otherwise do exactly that —
 * `extractBackendMessage` treats it as a genuine business message, not a
 * generic HTTP reason phrase). Exported so `$projectId.tsx`'s identical
 * project-level mutations use the SAME two messages — one concept, one
 * wording, on both surfaces.
 */
export function seniorShareErrorMessage(err: unknown): string {
  const status = getAxiosStatus(err)
  if (status === 404) {
    return 'Подтверждение недоступно: оно устарело или адресовано не вам. Обновите страницу.'
  }
  if (status === 409) {
    return 'Решение по этому проценту уже принято. Обновите страницу.'
  }
  return getApiErrorMessage(err, 'Не удалось выполнить действие')
}

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
    // Stryker disable next-line ArrowFunction: `.then((r) => r.data)`'s resolved value IS consumed now (onSuccess reads `data.user.seniorSharePercent` for the toast — task-648-fix-round-1 COPY-M-3), so this directive now only needs to cover the narrower "the callback identity itself" mutant, not "the value is never read" — kept because forcing the WHOLE `mutationFn` to `() => undefined` still independently fails the toast-text assertion in OverviewTab.pending-share.test.tsx.
    mutationFn: () =>
      api
        .post<UserWithPermissionsResponse>(`/users/${userId}/senior-share/approve`)
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      // task-648-fix-round-1 (COPY-M-3): names the ACTUAL confirmed value
      // ("новый процент подтверждён" stopped being new the instant it was
      // confirmed, and was outright false for a clear-override proposal —
      // nothing "new" was confirmed there) and uses "доля" as the primary
      // noun (COPY-M-4 — CONTEXT.md's "Доля синьора" entry).
      toast.success(`Ваша доля теперь ${data.user.seniorSharePercent}%`)
    },
    // task-648-fix-round-1 (QA-MED-5): refetch on failure too — the OverviewTab
    // twin of $projectId.tsx's identical fix. Without this a stale banner from
    // a proposal already resolved elsewhere (409/404) stayed fully clickable,
    // showing a number that no longer meant anything.
    onError: (e: unknown) => {
      toast.error(seniorShareErrorMessage(e))
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
    },
  })
}

/** Rejection counterpart of `useApproveSeniorShareChange` — reason required (design spec §3 decision 3). */
export function useRejectSeniorShareChange(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    // Stryker disable next-line ArrowFunction: the mutated node here is the
    // WHOLE `mutationFn` value (Stryker replaces it outright with
    // `() => undefined`, not just the inner `.then()` callback) — same
    // reasoning as useApproveSeniorShareChange's identical directive above,
    // whose comment sits in the equivalent position (immediately before
    // `mutationFn:`, not before the inner `.then()`). Unlike approve,
    // reject's `onSuccess` never reads the resolved value at all (no
    // confirmed-percent to name — see its own comment below), so this one
    // covers the whole "value never consumed" case, not just "callback
    // identity" — mutationFn resolving to `undefined` instead of the real
    // response body is genuinely unobservable by any test here.
    mutationFn: (reason: string) =>
      api
        .post<UserWithPermissionsResponse>(`/users/${userId}/senior-share/reject`, { reason })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      // task-648-fix-round-1 (COPY-M-2): "предложение" was a third name for
      // what the rest of this screen calls "подтверждение" — see
      // CONTEXT.md's glossary rule; names what happens to the money AND
      // that the reason is visible, matching the dialog's own promise.
      toast.success('Доля отклонена — действует прежний процент. Админ увидит причину')
    },
    // task-648-fix-round-1 (QA-MED-5): same refetch-on-failure fix as
    // useApproveSeniorShareChange above.
    onError: (e: unknown) => {
      toast.error(seniorShareErrorMessage(e))
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
    },
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
