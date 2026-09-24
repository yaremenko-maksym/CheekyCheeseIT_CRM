import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
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
// task-i18n-stage3a (Task 2) — a plain function, called from mutation
// `onError` callbacks (this file) AND from event handlers in
// `cancel-pending-share.tsx` / `SeniorShareApprovalActions.tsx` /
// `$projectId.tsx` (wave b/c, out of this PR's perimeter — see the task
// file's "Граница с параллельными задачами") that are NOT guaranteed to run
// during render, so it cannot call `useLingui()` (React Hook rule). Reads
// the global `i18n` singleton (`@lingui/core`, the same one `translateApiError`
// in `axios-utils.ts` already uses for the identical reason) instead. The
// `fallback` parameter itself stays an opaque `string`, untranslated by this
// function — it is supplied by callers outside this PR's perimeter and
// still Russian there; `useApproveSeniorShareChange`/
// `useRejectSeniorShareChange` below (inside this file, hooks) pass an
// already-`t`-resolved fallback.
export function seniorShareErrorMessage(err: unknown, fallback?: string): string {
  const status = getAxiosStatus(err)
  if (status === 404) {
    return i18n._(msg`Пропозиція недоступна: вона застаріла або адресована не вам. Оновіть сторінку.`)
  }
  if (status === 409) {
    return i18n._(msg`Рішення щодо цієї пропозиції вже прийнято. Оновіть сторінку.`)
  }
  // task-648-fix-round-2 (COPY-L-6): merging four call sites onto one helper
  // in round 1 also merged their four named fallbacks into one anonymous
  // fallback. The 404/409 mapping is genuinely shared; the last-resort
  // wording is not — each caller knows which action it was attempting and
  // now says so.
  return getApiErrorMessage(err, fallback ?? i18n._(msg`Не вдалося виконати дію`))
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
  const { t } = useLingui()
  return useMutation({
    mutationKey: ['update-me'],
    mutationFn: (data: UpdateProfileDto) =>
      api.patch('/users/me', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      // Refresh /auth/me — avatar / displayName feed the global header dropdown.
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      toast.success(t`Збережено`)
    },
    onError: (e: Error) => toast.error(t`Не вдалося зберегти: ${e.message}`),
  })
}

export function useUpdateMeRequisites() {
  const qc = useQueryClient()
  const { t } = useLingui()
  return useMutation({
    mutationKey: ['update-me-requisites'],
    mutationFn: (data: PaymentRequisites) =>
      api.patch('/users/me/requisites', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      toast.success(t`Реквізити оновлено`)
    },
    onError: (e: Error) => toast.error(t`Не вдалося оновити реквізити: ${e.message}`),
  })
}

export function useAdminSetNote(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  return useMutation({
    mutationFn: (data: SetNoteDto) =>
      api.patch(`/users/${userId}/note`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      toast.success(t`Нотатку збережено`)
    },
  })
}

export function useArchiveUser(userId: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
  return useMutation({
    mutationFn: () => api.delete(`/users/${userId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['users-admin'] })
      toast.success(t`Користувача заархівовано`)
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
  const { t } = useLingui()
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
      // return `{ ok: true }`, so this toast claimed the mail was resent
      // even when nothing was sent.
      if (data.delivered) {
        toast.success(t`Лист надіслано на особисту адресу`)
      } else {
        toast.error(t`Лист не пішов — поштовий сервіс не відповів. Спробуйте ще раз за кілька хвилин.`)
      }
    },
    onError: (e: Error) => toast.error(t`Не вдалося надіслати лист: ${e.message}`),
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
  const { t } = useLingui()
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
        // practice this IS the removal branch, and a generic "saved" toast
        // (the same word an admin-note edit gets) said nothing about the
        // access that was just revoked.
        toast.success(t`Особисту адресу видалено — вхід по ній більше не працює.`)
      } else if (data.delivered) {
        toast.success(t`Лист надіслано на особисту адресу`)
      } else {
        toast.error(t`Лист не пішов — поштовий сервіс не відповів. Спробуйте ще раз за кілька хвилин.`)
      }
    },
    onError: (e: Error) => toast.error(t`Не вдалося зберегти: ${e.message}`),
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
 * `loadForResponse`).
 *
 * COPY-M-10 (#667 fix-round 4): reads `companyName`, not `name`. Round 3
 * deliberately mirrored `PendingService`'s share-row title, which at the
 * time interpolated the project's `name` — and that title was itself the
 * defect: `name` is the internal label («AI Platform v2»), while the whole
 * product identifies a project by its company («TechCorp AI») — `ProjectRow`,
 * the project row on this very screen, `ProjectApprovalActions` and both
 * project toasts. Both halves moved together; the mirror still holds.
 *
 * Returns `null` rather than throwing on a 204/`{}`: an unnamed sentence is
 * a degradation, ««undefined»» in front of the user is a defect — and the
 * same goes for an empty or non-string value, which is why both are checked
 * here rather than left to the caller's truthiness (callers compare to
 * `null`, so an empty string WOULD have reached the user as «по проекту «»»).
 *
 * Takes no `scope`: a user-scope response has no top-level `name` to find,
 * and the user-scope sentences never interpolate one — a `scope === 'user'`
 * early return here was a branch no test could ever distinguish.
 */
function projectNameOf(data: unknown): string | null {
  const name = (data as ProjectDetailDto | undefined)?.companyName
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
  const { t } = useLingui()
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
      const projectName = projectNameOf(data)
      toast.success(
        scope === 'user'
          ? t`Частка за замовчуванням тепер ${percent}%`
          : projectName !== null
            ? t`Частка за проєктом «${projectName}» тепер ${percent}%`
            : t`Частка за проєктом тепер ${percent}%`,
      )
    },
    // task-648-fix-round-1 (QA-MED-5): refetch on failure too — a stale
    // banner/row from a proposal already resolved elsewhere (409/404) must
    // not stay clickable, showing a number that no longer means anything.
    onError: (e: unknown) => {
      toast.error(seniorShareErrorMessage(e, t`Не вдалося підтвердити`))
      invalidate()
    },
  })
}

/** Rejection counterpart of `useApproveSeniorShareChange` — reason required (design spec §3 decision 3). Same `scope` generalization, same reasoning. */
export function useRejectSeniorShareChange(scope: PendingShareScope, id: string) {
  const qc = useQueryClient()
  const { t } = useLingui()
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
      // ("previous percentage applies, admin will see the reason") is
      // unchanged in meaning (task-i18n-stage3a, Task 2 — translated to uk).
      const projectName = projectNameOf(data)
      const tail = t`відхилено — діє попередній відсоток. Адміністратор побачить причину`
      // COPY-M-9 (fix-round 4): the OBJECT leads, and the object is the
      // share — a project-level "proposal rejected" phrasing announced a
      // rejected PROJECT, which is a different decision living one section
      // above on the same screen with a toast of its own. The confirming
      // half of this pair already names the object first
      // («Частка за проєктом «X» тепер 30%»), so the pair was asymmetric on
      // top of being wrong. The unnamed fallback is untouched — that
      // sentence is #648's and still true.
      toast.success(
        scope === 'user'
          ? t`Частка за замовчуванням: пропозицію ${tail}`
          : projectName !== null
            ? t`Частка за проєктом «${projectName}»: пропозицію ${tail}`
            : t`Пропозицію ${tail}`,
      )
    },
    onError: (e: unknown) => {
      toast.error(seniorShareErrorMessage(e, t`Не вдалося відхилити`))
      invalidate()
    },
  })
}

export function useUnarchiveUser(userId: string, opts?: { isSenior?: boolean }) {
  const qc = useQueryClient()
  // Local binding named `t`/`msg` would shadow the `@lingui/react/macro` `t`
  // and `@lingui/core/macro` `msg` imports used elsewhere in this file —
  // `toastMessage` instead.
  const { t } = useLingui()
  return useMutation({
    mutationFn: () => api.post(`/users/${userId}/unarchive`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-profile', userId] })
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['users-admin'] })
      if (opts?.isSenior) {
        qc.invalidateQueries({ queryKey: ['teams'] })
      }
      const toastMessage = opts?.isSenior
        ? t`Сеньйора та команду відновлено`
        : t`Користувача відновлено з архіву`
      toast.success(toastMessage)
    },
    onError: (e: Error) => toast.error(t`Не вдалося відновити: ${e.message}`),
  })
}
