import { useNavigate } from '@tanstack/react-router'
import { useMutation, type QueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import type { AxiosError } from 'axios'
import type { AdminUpdateUserDto, CreateDropDto, CreateUserDto, UserProfileDto } from '@crm/shared'
import { toast } from 'sonner'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import type { WizardStep } from './useCreateWizard'

type UseUserDialogMutationsArgs = {
  queryClient: QueryClient
  createdUserId: string | null
  setCreatedUserId: (id: string | null) => void
  setCurrentStep: (step: WizardStep) => void
  setHasContract: (value: boolean) => void
  editingUser: UserProfileDto | null | undefined
  onClose: () => void
}

/**
 * The five UserDialog mutations (create user, create drop, wizard step-1
 * PATCH, mark-contract-ready, edit PATCH) plus the shared error explainer.
 * Moved verbatim from UserDialog: endpoints, payloads, cache invalidation and
 * side-effects are unchanged.
 */
export function useUserDialogMutations({
  queryClient,
  createdUserId,
  setCreatedUserId,
  setCurrentStep,
  setHasContract,
  editingUser,
  onClose,
}: UseUserDialogMutationsArgs) {
  const { t } = useLingui()
  const navigate = useNavigate()

  // ut-40: invalidate the generic `['users']` cache as well — that's the
  // key consumed by project/team dropdowns (`GET /api/users`). Without it,
  // a freshly-created SENIOR didn't appear in the «Создать проект» dropdown
  // until a manual refresh because the cached user list stayed stale.
  //
  // Drop-archive round 2 (B4): unified mutation error handler. 409 from
  // `/users` (and `/users/drops`) means "email already exists" — we show
  // a tailored toast and leave the dialog open so the operator can fix
  // the email and resubmit. Other HTTP codes surface the backend message
  // or a generic fallback. Shared between create-user, create-drop, and
  // (rarely) update — same `/users` endpoint surface.
  // task-i18n-stage4-task1: was a hardcoded `status === 409` check returning
  // a Russian literal, unconditionally — regardless of which 409 the
  // backend actually sent (userConflict/HR-floor/other 409s all read the
  // same text). `getApiErrorMessage` reads the `code` from the envelope
  // (apiError()) and translates it through the Lingui catalog; it falls
  // back to a real backend-provided message, then to `fallback`, so every
  // caller below keeps working even for a 409 (or any other status) that
  // is not `USER_EMAIL_EXISTS`.
  const explainUserMutationError = (
    err: AxiosError<{ message?: string }>,
    fallback: string,
  ): string => getApiErrorMessage(err, fallback)

  const createMutation = useMutation({
    mutationFn: (data: CreateUserDto) => api.post<UserProfileDto>('/users', data),
    onSuccess: (res, variables) => {
      const newUserId = (res.data as UserProfileDto).id
      // A3-3 wizard: store created user id and advance to step 2.
      // Do NOT close dialog — user continues to contract step.
      setCreatedUserId(newUserId)
      setCurrentStep(2)
      // Drop role - phase 1 fix (AC8): SENIOR with JOIN_DROP_TEAM gets a
      // tailored toast — show it after all 3 steps at wizard close instead.
      // For non-senior creates keep silent here (success shown at wizard end).
      const isJoinDrop = variables.role === 'SENIOR' && variables.teamMode === 'JOIN_DROP_TEAM'
      if (isJoinDrop) {
        toast.success(t`Сеньйора додано до команди дропа`, { duration: 4500 })
      }
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      // 409 → duplicate email toast, dialog stays open. See `explainUserMutationError`.
      toast.error(
        explainUserMutationError(
          err,
          t`Не вдалося створити користувача — дані залишилися у формі, спробуйте ще раз`,
        ),
      )
    },
  })

  // DROP role — separate endpoint that atomically provisions both the user
  // and the drop-team. Response shape: `{ user, team: { id, ... }, members }`
  // — we navigate to the new team detail page on success (mirrors the legacy
  // CreateDropDialog flow now folded into UserDialog).
  const createDropMutation = useMutation({
    mutationFn: (data: CreateDropDto) =>
      api.post<{ user: UserProfileDto; team: { id: string } }>('/users/drops', data),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      // Drop role - phase 1 fix (AC8): explicit duration so the toast lives
      // through the team-detail navigation (sonner defaults to 4s, but we
      // close the dialog + navigate in the same tick — the previous render
      // sometimes pruned the toast before it ever painted). 4500ms keeps it
      // within the spec «4-5 sec» band.
      toast.success(t`Дропа створено`, { duration: 4500 })
      onClose()
      const newTeamId = res.data.team?.id
      if (newTeamId) {
        void navigate({ to: '/team/$teamId', params: { teamId: newTeamId } })
      }
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      toast.error(
        explainUserMutationError(
          err,
          t`Не вдалося створити дропа — дані залишилися у формі, спробуйте ще раз`,
        ),
      )
    },
  })

  // A3-3: wizard step-1 «Далее» uses PATCH when createdUserId is already set
  // (i.e. admin went Back from step 2 and edited fields). This avoids a
  // duplicate POST /users → 409 conflict.
  const wizardUpdateMutation = useMutation({
    mutationFn: (data: AdminUpdateUserDto) =>
      api.patch<UserProfileDto>(`/users/${createdUserId}`, data),
    onSuccess: () => {
      // Advance to contract step — same outcome as initial POST success.
      setCurrentStep(2)
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      toast.error(
        explainUserMutationError(
          err,
          t`Не вдалося зберегти зміни — дані залишилися у формі, спробуйте ще раз`,
        ),
      )
    },
  })

  // A3-3: POST /api/users/:id/contract/ready — DRAFT → READY_TO_SIGN at wizard end.
  const markReadyMutation = useMutation({
    mutationFn: () => api.post(`/users/${createdUserId}/contract/ready`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success(t`Користувача створено, контракт готовий до підписання`, { duration: 4500 })
      setCurrentStep(1)
      setCreatedUserId(null)
      setHasContract(false)
      onClose()
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      toast.error(
        explainUserMutationError(err, t`Не вдалося позначити контракт готовим до підписання`),
      )
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: AdminUpdateUserDto) =>
      api.patch<UserProfileDto>(`/users/${editingUser!.id}`, data),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['user-profile', editingUser?.id] })
      // task-648-fix-round-2 (COPY-H-6): «Пользователь обновлён» is a lie for
      // the one field this whole PR exists for — the live column was NOT
      // updated, a proposal was opened. Every other field on the same form
      // did apply, so the old string was not wholly false; it was silent
      // about exactly the thing the operator needs to know. The response
      // already carries the opened proposal — no extra round-trip.
      // `AxiosResponse.data` is non-optional — an `?.` here would be dead
      // defensiveness, and the mutation gate is right to call that out.
      const pending = response.data.pendingSeniorShare
      if (pending) {
        // task-648-fix-round-4 (COPY-L-15): this is the moment the fact is
        // born, and it was the one place calling it «новая доля» — a second
        // later the same reader sees «Предложено N%» on the badge and
        // «Отменить предложение» on the button. The name is settled; this
        // line was simply written before it was.
        toast.success(
          t`Збережено. Сеньйору запропоновано ${pending.percent}% замість чинних ${response.data.seniorSharePercent}%`,
        )
      } else {
        toast.success(t`Зміни збережено`)
      }
      onClose()
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      // Edit can hit 409 too if admin changes email to an already-taken one.
      toast.error(
        explainUserMutationError(
          err,
          t`Не вдалося зберегти зміни — дані залишилися у формі, спробуйте ще раз`,
        ),
      )
    },
  })

  return {
    createMutation,
    createDropMutation,
    wizardUpdateMutation,
    markReadyMutation,
    updateMutation,
    explainUserMutationError,
  }
}
