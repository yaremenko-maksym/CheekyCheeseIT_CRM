import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trans, useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'
import type { ProjectDetailDto } from '@crm/shared'
import { api } from '@/lib/axios'
import { seniorShareErrorMessage } from '@/hooks/use-user-profile'
import {
  resolveProjectApprovalCaption,
  type ProjectApprovalCaptionInput,
} from '@/components/projects/project-approval-caption'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * task-pending-share (position 5, design spec §4.3/§8.3). Shown ONLY to the
 * person the pending proposal is actually waiting on (the affected SENIOR —
 * `pendingSeniorShare.approverId === viewerId`). Everyone else who can see
 * the share (ADMIN/ACCOUNTANT/the senior's own view) already gets the
 * informational badge from `ProjectShareInfo` above; this banner is the
 * ACTIONABLE surface, deliberately separate from that read-only indicator.
 */
/*
 * Exported for `__tests__/PendingShareApprovalBanner.copy.test.tsx` — the
 * alternative is mounting the whole project-detail route just to read a dialog
 * title. No behaviour change.
 */
export function PendingShareApprovalBanner({
  projectId,
  currentPercent,
  pending,
}: {
  projectId: string
  /** task-648-fix-round-1 (COPY-M-6): the ACTIVE override/default, shown
   * alongside the proposed value — same fallback `ProjectShareInfo` already
   * uses (`seniorSharePercentOverride ?? seniorSharePercentDefault`), so the
   * number here always agrees with the badge on the same page. */
  currentPercent: number
  pending: NonNullable<ProjectDetailDto['pendingSeniorShare']>
}) {
  const { t } = useLingui()
  const qc = useQueryClient()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['projects', projectId] })
    void qc.invalidateQueries({ queryKey: ['projects'] })
  }

  const approveMutation = useMutation({
    mutationFn: () =>
      api.post<ProjectDetailDto>(`/projects/${projectId}/senior-share/approve`).then((r) => r.data),
    onSuccess: (data) => {
      // task-648-fix-round-1 (COPY-M-3): names the ACTUAL confirmed value —
      // see the identical comment on useApproveSeniorShareChange (base-share
      // twin of this mutation) for the full reasoning.
      toast.success(t`Частка в проєкті тепер ${data.effectiveSeniorSharePercent}%`)
      invalidate()
    },
    onError: (err: unknown) => {
      // task-648-fix-round-1 (COPY-H-4, QA-MED-5): friendly 404/409 mapping
      // (not the raw backend "Подтверждение не найдено или уже закрыто" —
      // see seniorShareErrorMessage's own doc), AND refetch on failure so a
      // stale banner from a resolved-elsewhere proposal doesn't stay
      // clickable showing a number that no longer means anything.
      // task-648-fix-round-3 (COPY-L-9): a NAMED fallback, like the three
      // call sites on the profile half already had. Without it an error
      // carrying neither `.response` nor a string `.message` fell through to
      // the generic house text, and the reader could not tell which of the
      // two buttons on this banner had failed.
      toast.error(seniorShareErrorMessage(err, t`Не вдалося підтвердити`))
      invalidate()
    },
  })

  const rejectMutation = useMutation({
    mutationFn: () =>
      // Stryker disable next-line ArrowFunction: unwrapping the body here is
      // unobservable by construction — unlike its approve twin above, this
      // mutation's `onSuccess` takes no argument (the refusal has no value to
      // report; the toast names the OLD percent, which the component already
      // holds). `.then((r) => r.data)` is written for symmetry with the
      // approve mutation, not because anything reads the result, so no
      // assertion at this seam can distinguish it from `() => undefined`.
      // The route and the body ARE asserted — see
      // `PendingShareApprovalBanner.copy.test.tsx`, «POSTs the reason to the
      // reject route».
      api.post(`/projects/${projectId}/senior-share/reject`, { reason }).then((r) => r.data),
    onSuccess: () => {
      // task-648-fix-round-4 (COPY-M-18). Round 1 (COPY-M-2) called this
      // «доля» because «подтверждение» was then the canonical name and
      // «предложение» was a third one. Round 3 settled the canon the other
      // way and carried it to five surfaces; this line kept round 1's word,
      // so the same object was «предложение» on the button and «доля» in the
      // answer. It is also the more accurate of the two: the доля did not
      // move — the next clause of this very sentence says so.
      toast.success(
        t`Пропозицію відхилено — лишається попередня частка. Адміністратор побачить причину`,
      )
      setRejectOpen(false)
      setReason('')
      invalidate()
    },
    onError: (err: unknown) => {
      // task-648-fix-round-3 (COPY-L-9): reject twin of the fallback above.
      toast.error(seniorShareErrorMessage(err, t`Не вдалося відхилити`))
      invalidate()
    },
  })

  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-3"
      data-testid="pending-share-approval-banner"
    >
      {/* task-648-fix-round-1 (COPY-H-2/COPY-M-6): both branches now name
          "сейчас"/"предлагают" — the decision this banner asks for is a
          comparison, and until now only the proposed side was on screen.
          The `null` branch still never guesses the resolved fallback
          number — it comes from the server's own resolver
          (`effectivePercentAfterApproval`), same as before this fix. */}
      {/* task-648-fix-round-2 (COPY-M-11), three defects in one sentence:
          «базовый» had crept back into the null branch (the word appears
          nowhere else in the UI — the same level is labelled «(по
          умолчанию)»); «базовый ИЛИ командный» made the reader do taxonomy
          the system had already resolved one clause later; and the shared
          tail landed after TWO numbers, so which one is live was a guessing
          game. Both branches now end the same way, naming the live number —
          the wording the profile twin already used. */}
      <p className="text-sm">
        {pending.percent === null ? (
          <Trans>
            По проєкту пропонують зняти індивідуальну частку: зараз{' '}
            <span className="font-medium tabular-nums">{currentPercent}%</span>, стане{' '}
            <span className="font-medium tabular-nums">
              {pending.effectivePercentAfterApproval}%
            </span>
            .{' '}
          </Trans>
        ) : (
          <Trans>
            Вашу частку по проєкту пропонують змінити: зараз{' '}
            <span className="font-medium tabular-nums">{currentPercent}%</span>, нова —{' '}
            <span className="font-medium tabular-nums">{pending.percent}%</span>.{' '}
          </Trans>
        )}
        <Trans>
          Поки ви не підтвердите, діє{' '}
          <span className="font-medium tabular-nums">{currentPercent}%</span>.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-11 sm:h-8"
          onClick={() => approveMutation.mutate()}
          disabled={approveMutation.isPending}
          data-testid="pending-share-approve-button"
        >
          {/* task-648-fix-round-1 (COPY-M-9): same in-flight convention as
              OverviewTab.tsx's identical banner. */}
          {approveMutation.isPending ? <Trans>Підтвердження…</Trans> : <Trans>Підтвердити</Trans>}
        </Button>
        <Button
          size="sm"
          className="h-11 sm:h-8"
          variant="outline"
          onClick={() => setRejectOpen(true)}
          disabled={approveMutation.isPending}
          data-testid="pending-share-reject-button"
        >
          <Trans>Відхилити</Trans>
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <CrmDialogContent>
          <CrmDialogHeader>
            {/* task-648-fix-round-4 (COPY-M-18): same rename as the profile
                twin in OverviewTab.tsx — one object, one name, on both
                halves. */}
            <DialogTitle>
              <Trans>Відхилити пропозицію</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Причина обов’язкова і буде видна адміністратору.</Trans>
            </DialogDescription>
          </CrmDialogHeader>
          <CrmDialogBody>
            {/* task-648-fix-round-1 (COPY-M-8): same fix as
                OverviewTab.tsx's identical dialog — mirrors
                ProjectApprovalActions.tsx (#646). */}
            <Label htmlFor="pending-share-reject-reason" className="text-xs">
              <Trans>Причина відмови *</Trans>
            </Label>
            <Textarea
              id="pending-share-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              // Stryker disable next-line StringLiteral: placeholder text only, no test reads the textarea's placeholder attribute — genuinely unobservable by the unit suite.
              placeholder={t`Наприклад: домовилися про 30%`}
              maxLength={500}
              rows={3}
              data-testid="pending-share-reject-reason"
            />
            <p className="text-xs text-muted-foreground text-right tabular-nums">
              {reason.length}/500
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => setRejectOpen(false)}>
              <Trans>Скасувати</Trans>
            </Button>
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              onClick={() => rejectMutation.mutate()}
              disabled={!reason.trim() || rejectMutation.isPending}
              data-testid="pending-share-reject-confirm"
            >
              {rejectMutation.isPending ? <Trans>Відхиляємо…</Trans> : <Trans>Відхилити</Trans>}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </div>
  )
}

/**
 * task-projects-followups-web (backlog 201). The header badge
 * (`ProjectStatusBadge`) alone said only the bare status word — "Отклонён"
 * with no reason, "Ждёт решения" with no hint who it is still waiting on —
 * while the row list (`ProjectRow.tsx`) has always shown both right next to
 * the badge. This renders the same fact, in the same words: the caption
 * TEXT comes from `resolveProjectApprovalCaption` (shared with
 * `ProjectRow.tsx` — see that helper's own doc), only the layout differs
 * (no column-width budget to defend here, unlike the row's ~86px track).
 *
 * `null` (renders nothing) on `ACTIVE`, and on a `REJECTED` project whose
 * `rejectionReason` this viewer's DTO does not carry — masked to `null`
 * server-side for every non-ADMIN viewer (SR-M-5), same as the row.
 *
 * Exported for a standalone render test — same reason as
 * `PendingShareApprovalBanner` (see that banner's own doc): mounting the whole
 * project-detail route to read one <p> would be the alternative.
 */
export function ProjectHeaderApprovalNote({
  project,
  viewerId,
}: {
  project: ProjectApprovalCaptionInput & { archivedAt?: string | null }
  viewerId?: string | null | undefined
}) {
  // SR-L-1 (fix-round 2): archival is a separate axis from `status` (see
  // `resolveProjectApprovalCaption`'s own doc) — `ProjectRow.tsx` branches on
  // `archivedAt` BEFORE ever reaching the caption helper (its `isArchived`
  // priority), so a REJECTED-then-archived project shows only the "В архиве"
  // badge there, never the rejection reason. This caller reads the exact
  // same DTO shape and must not show a caption the row never would.
  if (project.archivedAt) return null

  const caption = resolveProjectApprovalCaption(project, viewerId)
  if (!caption) return null

  if (project.status === 'REJECTED') {
    return (
      // COPY-M-3 (fix-round 2): the header has no column-width budget to
      // defend (unlike the row's ~86px track this line-clamp-2 was
      // originally sized for) — `title` is a hover-only affordance and does
      // nothing on a touch screen, so clamping on mobile/tablet made the
      // tail of the reason unreachable there. Clamped only from `lg:` up,
      // where the header genuinely does share the row with other content.
      //
      // UX-H-1 / COPY-M-5 (fix-round 3): `basis-full lg:basis-auto` so this
      // paragraph always claims its own line in the badge row's flex-wrap
      // — on 640-1023 (header now stacked, badge row full-width) a long
      // reason would otherwise sit on the same line as the domain badge and
      // shove it around instead of wrapping cleanly under the status badge.
      //
      // UX-L-1 / COPY-L-3 (fix-round 3): dropped `mt-1.5` + added
      // `self-center` — the badge row is `items-center`; the old top margin
      // pushed this line below the status badge's vertical center (measured:
      // badge 142-164, caption 148-164 on 1440) instead of centering with it.
      //
      // UX-M-1 (fix-round 4): `max-w-prose` was unconditional, so on
      // ~978-1023 (header stacked since fix-round 3, badge row full-width)
      // a long (>=250 char) reason's clamped width left enough leftover
      // space on its own flex line for the domain badge to sit beside it
      // instead of wrapping below the status badge — `basis-full` alone
      // doesn't force full width once `max-width` caps the box smaller than
      // the container. Scoped the cap to `lg:` (paired with `lg:basis-auto`
      // above) so below `lg` the reason is unconstrained and always claims
      // the full row.
      <p
        className="line-clamp-none basis-full self-center text-xs text-destructive/90 lg:basis-auto lg:line-clamp-2 lg:max-w-prose"
        title={project.rejectionReason ?? undefined}
        data-testid="project-header-rejection-reason"
      >
        {caption}
      </p>
    )
  }

  return (
    <p
      className="max-w-full basis-full self-center text-xs text-amber-300/80 lg:basis-auto"
      data-testid="project-header-approval-caption"
    >
      {caption}
    </p>
  )
}
