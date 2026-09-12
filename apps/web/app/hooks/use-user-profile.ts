import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  PaymentRequisites,
  ProjectDetailDto,
  SetNoteDto,
  UpdateProfileDto,
  UserWithPermissionsResponse,
} from '@crm/shared'
import { api } from '@/lib/axios'
import { getApiErrorMessage, getAxiosStatus } from '@/lib/axios-utils'
// Type-only — no runtime edge, so this does not create the ESM import cycle
// `cancel-pending-share.tsx` itself imports `seniorShareErrorMessage` FROM
// this file (see pending-share.ts's own doc for why that class of cycle is
// taken seriously here). `PendingShareScope` is the single source for the
// 'user' | 'project' branch both approve/reject below and
// `useCancelPendingShare` already share — task addendum item 2
// ("не плодить третий файл с той же scope-веткой").
import type { PendingShareScope } from '@/components/pending-share/cancel-pending-share'
// CR-M-2 (fix-round 3): the real constant, not a `['pending']` literal — a
// rename of the key must reach these two invalidations too, and a literal
// would have survived one silently (`use-project-approvals.ts` and
// `cancel-pending-share.tsx` already imported it).
import { PENDING_QUERY_KEY } from '@/hooks/use-pending-items'

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
/*
 * task-648-fix-round-4 (COPY-M-18). Both messages below used to name the fact
 * «подтверждение» / «процент» — the vocabulary of round 1, when that WAS the
 * canonical name (COPY-M-2). Round 3 chose «предложение» and carried it to
 * five surfaces, which left these two in the minority rather than settling
 * anything: the cancel button now routes through this helper as well, so a
 * reader who pressed «Отменить предложение» was answered «Подтверждение
 * недоступно» — one object, two words, one gesture apart.
 */
export function seniorShareErrorMessage(err: unknown, fallback?: string): string {
  const status = getAxiosStatus(err)
  if (status === 404) {
    return 'Предложение недоступно: оно устарело или адресовано не вам. Обновите страницу.'
  }
  if (status === 409) {
    return 'Решение по этому предложению уже принято. Обновите страницу.'
  }
  // task-648-fix-round-2 (COPY-L-6): merging four call sites onto one helper
  // in round 1 also merged their four named fallbacks into one anonymous
  // "Не удалось выполнить действие". The 404/409 mapping is genuinely shared;
  // the last-resort wording is not — each caller knows which action it was
  // attempting and now says so.
  return getApiErrorMessage(err, fallback ?? 'Не удалось выполнить действие')
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
 * task-648-fix-round-1 (COPY-M-3) + task-pending-screen addendum item 2
 * (2026-09-07: "обобщить пару из use-user-profile.ts параметром scope,
 * симметрично useCancelPendingShare"). `data` is `UserWithPermissionsResponse`
 * for `scope: 'user'`, `ProjectDetailDto` for `scope: 'project'` — narrowed
 * the same way `cancel-pending-share.tsx#effectivePercentOf` already does,
 * so the toast can always name the real number the server settled on.
 */
/**
 * COPY-L-1 (fix-round 3): the project's own name, for a toast that has to
 * survive the row it referred to disappearing. Narrowed exactly like
 * `confirmedPercentOf` below — both `approve` and `reject` return the same
 * `ProjectDetailDto` (`ProjectsService.rejectSeniorShareChange` ends in
 * `loadForResponse`), and `name` is the field `PendingService` titles the
 * share row with («Доля по проекту «{name}»»), not `companyName`. Returns
 * `null` rather than throwing on a 204/`{}`: an unnamed sentence is a
 * degradation, ««undefined»» in front of the user is a defect.
 */
function projectNameOf(scope: PendingShareScope, data: unknown): string | null {
  if (scope === 'user') return null
  const name = (data as ProjectDetailDto | undefined)?.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

function confirmedPercentOf(scope: PendingShareScope, data: unknown): number | null {
  if (scope === 'user') {
    const percent = (data as UserWithPermissionsResponse | undefined)?.user?.seniorSharePercent
    return typeof percent === 'number' ? percent : null
  }
  const percent = (data as ProjectDetailDto | undefined)?.effectiveSeniorSharePercent
  return typeof percent === 'number' ? percent : null
}

/**
 * task-pending-share (position 5, design spec §4.3), generalized by
 * task-pending-screen addendum item 2 (2026-09-07) to cover BOTH the
 * affected SENIOR confirming their own base share % (`scope: 'user'`) and a
 * SENIOR confirming a project-level override from the `/pending` screen
 * (`scope: 'project'`, the previously-inline `$projectId.tsx`
 * `PendingShareApprovalBanner` mutation's twin — see `SeniorShareApprovalActions`,
 * the new caller this generalization exists for). Self-only by construction
 * either way (the endpoint 404s for anyone who isn't the invited approver,
 * same as `ProjectsService.approveDraft`'s pattern) — the caller only ever
 * supplies the viewer's own id, never someone else's.
 */
export function useApproveSeniorShareChange(scope: PendingShareScope, id: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    if (scope === 'user') {
      qc.invalidateQueries({ queryKey: ['user-profile', id] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
    } else {
      qc.invalidateQueries({ queryKey: ['projects', id] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    }
    // Both scopes can appear on the /pending screen's `mine` list.
    qc.invalidateQueries({ queryKey: PENDING_QUERY_KEY })
  }
  return useMutation({
    // Stryker disable next-line ArrowFunction: `.then((r) => r.data)`'s resolved value IS consumed now (onSuccess reads the confirmed percent for the toast — task-648-fix-round-1 COPY-M-3), so this directive only needs to cover the narrower "the callback identity itself" mutant, not "the value is never read".
    mutationFn: () =>
      api
        .post<UserWithPermissionsResponse | ProjectDetailDto>(
          scope === 'user' ? `/users/${id}/senior-share/approve` : `/projects/${id}/senior-share/approve`,
        )
        .then((r) => r.data),
    onSuccess: (data) => {
      invalidate()
      const percent = confirmedPercentOf(scope, data)
      // task-648-fix-round-1 (COPY-M-3): names the ACTUAL confirmed value —
      // "новый процент подтверждён" stopped being new the instant it was
      // confirmed, and was outright false for a clear-override proposal.
      // COPY-L-1 (fix-round 3): name the OBJECT. Both sentences were lifted
      // verbatim from `$projectId.tsx`, a page about ONE project, where the
      // address said which one; on `/pending` several proposals sit next to
      // each other and the row acted on vanishes as the toast appears.
      // «Доля по умолчанию» is also exactly how the row is titled there.
      const projectName = projectNameOf(scope, data)
      toast.success(
        scope === 'user'
          ? `Доля по умолчанию теперь ${percent}%`
          : projectName
            ? `Доля по проекту «${projectName}» теперь ${percent}%`
            : `Доля по проекту теперь ${percent}%`,
      )
    },
    // task-648-fix-round-1 (QA-MED-5): refetch on failure too — a stale
    // banner/row from a proposal already resolved elsewhere (409/404) must
    // not stay clickable, showing a number that no longer means anything.
    onError: (e: unknown) => {
      toast.error(seniorShareErrorMessage(e, 'Не удалось подтвердить'))
      invalidate()
    },
  })
}

/** Rejection counterpart of `useApproveSeniorShareChange` — reason required (design spec §3 decision 3). Same `scope` generalization, same reasoning. */
export function useRejectSeniorShareChange(scope: PendingShareScope, id: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    if (scope === 'user') {
      qc.invalidateQueries({ queryKey: ['user-profile', id] })
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
    } else {
      qc.invalidateQueries({ queryKey: ['projects', id] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    }
    qc.invalidateQueries({ queryKey: PENDING_QUERY_KEY })
  }
  return useMutation({
    // Stryker disable next-line ArrowFunction: the mutated node here is the WHOLE `mutationFn` value — `onSuccess` below takes no argument (a rejection has no confirmed percent to name), so the resolved response body is never read by anything downstream.
    mutationFn: async (reason: string) => {
      const response = await api.post<unknown>(
        scope === 'user' ? `/users/${id}/senior-share/reject` : `/projects/${id}/senior-share/reject`,
        { reason },
      )
      return response.data
    },
    onSuccess: (data) => {
      invalidate()
      // task-648-fix-round-5 (COPY-M-20) kept ONE sentence for both scopes,
      // because the only two callers then were pages about a single subject.
      // COPY-L-1 (fix-round 3): on `/pending` the subject is no longer
      // implied — the reject endpoint returns the updated `ProjectDetailDto`,
      // so the project can be named from the same response. The tail
      // («действует прежний процент. Админ увидит причину») is unchanged.
      const projectName = projectNameOf(scope, data)
      const tail = 'отклонено — действует прежний процент. Админ увидит причину'
      toast.success(
        scope === 'user'
          ? `Предложение по доле по умолчанию ${tail}`
          : projectName
            ? `Предложение по проекту «${projectName}» ${tail}`
            : `Предложение ${tail}`,
      )
    },
    onError: (e: unknown) => {
      toast.error(seniorShareErrorMessage(e, 'Не удалось отклонить'))
      invalidate()
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
