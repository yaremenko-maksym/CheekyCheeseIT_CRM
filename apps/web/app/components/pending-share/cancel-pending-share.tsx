import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { PendingSeniorShare, ProjectDetailDto, UserWithPermissionsResponse } from '@crm/shared'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/axios'
import { seniorShareErrorMessage } from '@/hooks/use-user-profile'
import { PENDING_QUERY_KEY } from '@/hooks/use-pending-items'

/**
 * task-648-fix-round-2 (SR-H-2 / SPEC-H-2 / CR-H-3 / UX-H-3(r2) / QA-HIGH-2).
 *
 * The client half of `POST …/senior-share/cancel`. Round 1 shipped the
 * endpoint and no way to reach it: five review axes independently found that
 * `cancelSeniorShareChange` had zero call sites in `apps/web`, and that the
 * only documented way to withdraw a proposal — "return the slider to the
 * active value" — was unreachable through the project form (which only sends
 * the field when it DIFFERS from the active value) and destructive on the
 * user form (which sent it unconditionally, so editing a phone killed a live
 * proposal). Round 2 removed that implicit path entirely; this is the
 * explicit one that replaces it.
 *
 * ONE module for both halves on purpose. The two surfaces differ only in the
 * URL and in which query keys go stale; everything the reviewer cared about —
 * the confirmation step, the 404/409 mapping, the toast wording, the 44px
 * touch target — is the kind of thing that drifts the moment it is written
 * twice.
 */

export type PendingShareScope = 'user' | 'project'

/**
 * `UserWithPermissionsResponse` (users half) and `ProjectDetailDto` (project
 * half) both carry the post-cancel effective percent, under different names.
 * Narrowed here rather than in each caller so the toast can name the real
 * number the server settled on — the lesson COPY-M-3 recorded in round 1
 * ("name the value the server confirmed, not the one the operator clicked").
 */
function effectivePercentOf(scope: PendingShareScope, data: unknown): number | null {
  if (scope === 'user') {
    const percent = (data as UserWithPermissionsResponse | undefined)?.user?.seniorSharePercent
    return typeof percent === 'number' ? percent : null
  }
  const percent = (data as ProjectDetailDto | undefined)?.effectiveSeniorSharePercent
  return typeof percent === 'number' ? percent : null
}

export function useCancelPendingShare(scope: PendingShareScope, id: string) {
  const qc = useQueryClient()

  const invalidate = () => {
    if (scope === 'user') {
      void qc.invalidateQueries({ queryKey: ['user-profile', id] })
      void qc.invalidateQueries({ queryKey: ['user-profile', 'me'] })
      void qc.invalidateQueries({ queryKey: ['users-admin'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
    } else {
      void qc.invalidateQueries({ queryKey: ['projects', id] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
    }
    // Scope-independent, like `useApproveSeniorShareChange`'s own matching
    // line: a cancelled proposal is gone from `GET /pending` for everyone,
    // and the /pending screen is where an ADMIN cancels it from
    // (task-pending-screen AC4 — "строка ушла из proposedByMe"). Without
    // this, the row stayed on screen until the next natural refetch —
    // measured live, that is how the E2E for that AC failed.
    void qc.invalidateQueries({ queryKey: PENDING_QUERY_KEY })
  }

  return useMutation({
    mutationFn: async () => {
      const response = await api.post<unknown>(
        scope === 'user'
          ? `/users/${id}/senior-share/cancel`
          : `/projects/${id}/senior-share/cancel`,
      )
      return response.data
    },
    onSuccess: (data) => {
      const percent = effectivePercentOf(scope, data)
      toast.success(
        percent === null
          ? 'Предложение отменено — действует прежний процент'
          : `Предложение отменено — действует ${percent}%`,
      )
      invalidate()
    },
    onError: (err: unknown) => {
      // Same 404/409 mapping the approve/reject pair uses, and the same
      // refetch-on-failure (QA-MED-5, round 1): a proposal someone else
      // already resolved must not leave a live-looking button on screen.
      toast.error(seniorShareErrorMessage(err, 'Не удалось отменить предложение'))
      invalidate()
    },
  })
}

/**
 * task-648-fix-round-3 (COPY-H-7 / COPY-M-14 / COPY-L-12).
 *
 * Round 2 shipped this as an icon-only `X` button next to the badge. Three
 * things were wrong with that at once, and one fix answers all three:
 *
 *  - it had no VISIBLE name, only `aria-label`/`title` — so on touch, where
 *    neither surfaces, the only irreversible control on the screen was an
 *    unlabelled cross (COPY-M-14);
 *  - `h-11 w-11` on 320 is 44px of horizontal space the project row does not
 *    have — with the badge beside it the row overflowed by ~59px (COPY-H-7);
 *  - one click withdrew a live proposal with no way back (COPY-M-14).
 *
 * So: a full-width text button BELOW the badge (vertical space is the one
 * axis 320px is not short of), and a confirmation step modelled on the
 * reject dialog the same feature already uses.
 *
 * `h-11` (44px) until `sm:` is the touch floor UX-H-1 set in round 1;
 * `w-full sm:w-auto` is what keeps it inside the viewport instead of beside
 * the badge.
 */
export function CancelPendingShareButton({
  scope,
  id,
  pendingPercent,
}: {
  scope: PendingShareScope
  id: string
  /**
   * The proposed percent, named in the confirmation question. Always the
   * already-resolved number (`percent === null ? effectivePercentAfterApproval
   * : percent`) — this component never re-derives it, the lesson COPY-H-2 of
   * round 1 left behind.
   */
  pendingPercent: number
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cancelMutation = useCancelPendingShare(scope, id)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 w-full sm:h-8 sm:w-auto"
        disabled={cancelMutation.isPending}
        onClick={() => setConfirmOpen(true)}
        data-testid={`cancel-pending-share-${scope}`}
      >
        {/* task-648-fix-round-3 (COPY-L-12): «Отмена…» sat one dialog away
            from «Отмена» meaning "close this dialog" — the in-flight label
            now names the process, like the other 8 in the repo. */}
        {cancelMutation.isPending ? 'Отменяем предложение…' : 'Отменить предложение'}
      </Button>
      <CancelPendingShareConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        scope={scope}
        pendingPercent={pendingPercent}
        // task-648-fix-round-3: no `setConfirmOpen(false)` here. Radix's
        // `AlertDialogAction` closes the dialog itself on click, so the
        // explicit call was dead — the mutation gate proved it by flipping it
        // to `true` and watching "the confirmation closes" stay green. Deleted
        // rather than suppressed: a line that cannot change behaviour is not a
        // line worth explaining.
        onConfirm={() => cancelMutation.mutate()}
      />
    </>
  )
}

/**
 * task-648-fix-round-3 (COPY-M-14). Shared by both withdraw buttons (the one
 * next to the indicator and the one inside the edit dialogs) so the question
 * is asked in exactly one wording.
 *
 * The second sentence answers the question the reader actually has before
 * pressing an irreversible button — "does this change what I am paid today?"
 * — rather than restating the button.
 */
function CancelPendingShareConfirm({
  open,
  onOpenChange,
  scope,
  pendingPercent,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  /**
   * Test-id discriminator, not a behavioral switch: a `user`/`project`
   * indicator button and its `…-in-dialog` twin can both be mounted on the
   * same page, and Playwright's strict mode fails on two nodes sharing a
   * test-id (playwright-patterns, "strict-mode resolution").
   */
  scope: PendingShareScope | `${PendingShareScope}-in-dialog`
  pendingPercent: number
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={`cancel-pending-share-confirm-${scope}`}>
        <AlertDialogHeader>
          <AlertDialogTitle>Отменить предложение {pendingPercent}%?</AlertDialogTitle>
          <AlertDialogDescription>Действующая доля не изменится.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* «Оставить», not «Отмена»: on a dialog whose whole subject is
              cancelling something, «Отмена» would be the same word for both
              answers. */}
          {/* manual-qa round 5 (QA-MED-6): `AlertDialogCancel`/`AlertDialogAction`
              fall back to `buttonVariants()`'s default size (`h-9` = 36px) unless
              told otherwise — measured live at 320/375 and confirmed against
              `apps/web/app/components/ui/button.tsx`. The sibling reject dialog
              (`OverviewTab.tsx`) already solved exactly this with `h-11 sm:h-9`
              on both footer buttons; this is the same fix, so the two
              irreversible-action dialogs this feature ships stop disagreeing on
              the one thing UX-H-1 (round 1) fixed everywhere else. */}
          <AlertDialogCancel
            className="h-11 sm:h-9"
            data-testid={`cancel-pending-share-keep-${scope}`}
          >
            Оставить
          </AlertDialogCancel>
          <AlertDialogAction
            className="h-11 sm:h-9"
            onClick={onConfirm}
            data-testid={`cancel-pending-share-confirm-button-${scope}`}
          >
            Отменить предложение
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * task-648-fix-round-3 (COPY-H-8). Who is READING this indicator — the person
 * the proposal waits on, or anyone else who may see it.
 *
 * The gate used to be the ROUTE (`mode === 'self'` on the profile half), so a
 * senior who reached their own profile through `/profile/$userId` — an admin
 * sends them the link, or they arrive from a team list — was told about
 * themselves in the third person and given no buttons, while the project half
 * asked the right question (`approverId === me.id`) two files away. One
 * helper, both surfaces, so the two cannot drift again.
 *
 * `null` means "nothing pending" — distinct from `'observer'`, which means
 * "something is pending and you are not the one who must answer".
 */
export type PendingShareAudience = 'approver' | 'observer'

export function pendingShareAudience(
  viewerId: string | null | undefined,
  pending: Pick<PendingSeniorShare, 'approverId'> | null | undefined,
): PendingShareAudience | null {
  if (!pending) return null
  // No `viewerId != null` guard: `approverId` is a non-nullable uuid on the
  // schema, so a null/undefined viewer already compares false. The guard was
  // a branch no legal input could distinguish — the mutation gate is what
  // said so, by flipping it and having every test still pass.
  return viewerId === pending.approverId ? 'approver' : 'observer'
}

/**
 * UX-H-3(r2), the finding's "более важное место": the edit dialogs. An ADMIN
 * who opens the form to "fix" the percent was shown a slider holding the
 * ACTIVE value and nothing at all about the proposal already awaiting an
 * answer — so the natural gesture (type a new number, save) silently
 * superseded a live proposal the operator never knew existed.
 *
 * Rendered into the hint slot both forms already have, so it appears exactly
 * where the reader is looking when they touch the field.
 */
export function PendingShareEditNotice({
  scope,
  id,
  pendingPercent,
  approverName,
  testId,
}: {
  scope: PendingShareScope
  id: string
  /** The proposed percent. Already resolved by the server for the project
   * half's "clear the override" case (`effectivePercentAfterApproval`), so
   * this component never guesses a number. */
  pendingPercent: number
  approverName: string
  testId?: string
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cancelMutation = useCancelPendingShare(scope, id)
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2"
      data-testid={testId ?? `pending-share-edit-notice-${scope}`}
    >
      {/* task-648-fix-round-4 (COPY-M-17). Round 3 moved «ждёт подтверждения»
          onto the NAME, which fixed the colon defect but opened a grammatical
          one: that slot is genitive, and the name arrives from the database in
          the nominative. On Latin script it passes unnoticed — «ждёт
          подтверждения Oleksiy Kovalenko» — and on Cyrillic it does not:
          «ждёт подтверждения Олексій Коваленко» is wrong out loud. CRM names
          are typed by a human, so that breaks when, not if.
          The indicator on the same screen already carries a frame that needs
          no case at all — «Подтверждает <имя>» — so this reuses it instead of
          inventing a second way to name one person. One fact, one frame. */}
      <p className="text-xs">
        Предложено <span className="font-medium tabular-nums">{pendingPercent}%</span>. Подтверждает{' '}
        {approverName}. Новое значение заменит предложение.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 w-full sm:h-8 sm:w-auto"
        disabled={cancelMutation.isPending}
        onClick={() => setConfirmOpen(true)}
        data-testid={`cancel-pending-share-${scope}-in-dialog`}
      >
        {cancelMutation.isPending ? 'Отменяем предложение…' : 'Отменить предложение'}
      </Button>
      {/* task-648-fix-round-3 (COPY-M-14): the same confirmation as the
          indicator's button — an irreversible action asks once, in one
          wording, wherever it is reached from. */}
      <CancelPendingShareConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        scope={`${scope}-in-dialog`}
        pendingPercent={pendingPercent}
        // task-648-fix-round-3: no `setConfirmOpen(false)` here. Radix's
        // `AlertDialogAction` closes the dialog itself on click, so the
        // explicit call was dead — the mutation gate proved it by flipping it
        // to `true` and watching "the confirmation closes" stay green. Deleted
        // rather than suppressed: a line that cannot change behaviour is not a
        // line worth explaining.
        onConfirm={() => cancelMutation.mutate()}
      />
    </div>
  )
}
