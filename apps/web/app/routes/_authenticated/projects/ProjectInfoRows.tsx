import { Trans, useLingui } from '@lingui/react/macro'
import type { ProjectDetailDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  CancelPendingShareButton,
  pendingShareAudience,
} from '@/components/pending-share/cancel-pending-share'
import { cn } from '@/lib/utils'

/**
 * Exported for tests only (same test-only export `ProjectEditFields` already
 * uses on this page) — `InfoRow.structure.test.tsx` mounts it directly rather
 * than rendering the whole 2000-line route to look at eight rows.
 */
export function InfoRow({
  icon,
  label,
  children,
  stackOnMobile = false,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  /**
   * task-648-fix-round-3 (COPY-H-7 / COPY-M-14). At 320 this row's icon, its
   * `min-w-[80px]` label and the gaps leave the VALUE only 107px. That is
   * enough for a number, and not enough for a control that has to state its
   * own name: measured on the live stack, the withdraw button rendered at
   * 107px with `scrollWidth` 124 — «Отменить предложение» was cut off, and
   * the pending badge (112px, `whitespace-nowrap` since COPY-H-5) spilled 5px
   * past the column. Neither showed up as document overflow, because an
   * ancestor clips; both were invisible to every assertion in rounds 1-2.
   *
   * Opt-in rather than applied to every row: this is the only row that hosts
   * an interactive control, and restacking the whole «Детали проекта» card is
   * a design decision, not a bug fix. `sm:contents` dissolves the wrapper from
   * `sm:` up, so at every width above mobile the markup this produces is
   * byte-for-byte the row it always was.
   */
  stackOnMobile?: boolean
}) {
  return (
    <div
      // task-648-fix-round-4 (CR-M-4): the handle that lets an E2E measure
      // EVERY row of «Детали проекта» at 320/375, not just the one row that
      // opts into `stackOnMobile`. The structural change this prop brought is
      // rendered for all eight of them, so all eight are what has to be
      // measured — see describe «Z» in projects-senior-share-override.spec.ts.
      data-testid="project-info-row"
      className={cn(
        'flex min-w-0 items-start gap-2 text-sm',
        stackOnMobile && 'flex-col gap-1 sm:flex-row sm:gap-2',
      )}
    >
      <span className={cn('flex shrink-0 items-start gap-2', stackOnMobile && 'sm:contents')}>
        <span className="text-muted-foreground shrink-0 mt-0.5">{icon}</span>
        <span className="text-muted-foreground shrink-0 min-w-[80px]">{label}:</span>
      </span>
      <div
        className={cn(
          'min-w-0 flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 break-words',
          stackOnMobile && 'w-full sm:w-auto',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Single source of truth for "effective SENIOR share %" display logic —
 * shows the per-project override (with the «Override» badge + tooltip)
 * or falls back to the senior's global default (with the «по умолчанию»
 * marker). Used in both the read-only Project info card and the
 * Финансы по проекту section so the two stay in lockstep.
 *
 * Set `variant="inline"` for a compact one-line look (the Финансы header)
 * — the wider variant is the default and matches the existing InfoRow.
 */
export function ProjectShareInfo({
  project,
  variant = 'block',
  testId = 'project-senior-share',
  badgeTestId = 'project-senior-share-override-badge',
  canCancelPendingShare = false,
  viewerId,
}: {
  project: Pick<
    ProjectDetailDto,
    'id' | 'seniorSharePercentOverride' | 'seniorSharePercentDefault' | 'pendingSeniorShare'
  >
  variant?: 'block' | 'inline'
  /** Override the default `data-testid` so multiple instances can coexist on the same page. */
  testId?: string
  badgeTestId?: string
  /**
   * task-648-fix-round-2 (UX-H-3(r2)). ADMIN/ACCOUNTANT — the same pair the
   * propose gate uses (`canEditOverride` at the page level) — get the
   * withdraw control next to the indicator. Defaults to `false` so a caller
   * that forgets it renders the read-only widget it always did, rather than
   * a button the backend would 403.
   */
  canCancelPendingShare?: boolean
  /**
   * task-648-fix-round-3 (COPY-H-8). Who is reading — passed in rather than
   * read from `useAuth` here so this widget stays a pure function of its
   * props (it is rendered twice on the page and unit-tested standalone).
   */
  viewerId?: string | null | undefined
}) {
  const { t } = useLingui()
  const overrideRaw = project.seniorSharePercentOverride
  const hasOverride = overrideRaw !== null && overrideRaw !== undefined
  const fallback = project.seniorSharePercentDefault ?? 26
  const effective = hasOverride ? overrideRaw : fallback
  const pending = project.pendingSeniorShare ?? null
  const audience = pendingShareAudience(viewerId, pending)
  return (
    <span
      // task-648-fix-round-3 (COPY-H-7): `min-w-0 max-w-full`. This span is a
      // flex ITEM of `InfoRow`'s content box, and a flex item defaults to
      // `min-width: auto` — it refuses to shrink below its own min-content
      // width, so at 320 the widget grew PAST the row that contains it and
      // drew the withdraw button ending at x≈339, off the edge of the screen.
      // The document itself did not scroll (an ancestor clips), which is why
      // round 2's page-level overflow checks stayed green while a control was
      // half off-screen — measured by this round's own E2E, not by eye.
      className={cn(
        'inline-flex min-w-0 max-w-full flex-wrap items-center gap-2',
        variant === 'inline' && 'text-sm',
      )}
      data-testid={testId}
    >
      {variant === 'inline' && (
        <span className="text-muted-foreground">
          <Trans>Частка сеньйора:</Trans>
        </span>
      )}
      <span className="font-medium tabular-nums">{effective}%</span>
      {hasOverride ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="text-[10px]" data-testid={badgeTestId}>
              <Trans>Override</Trans>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <Trans>Встановлено для цього проєкту; глобальна частка сеньйора: {fallback}%</Trans>
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground">{t`(за замовчуванням)`}</span>
      )}
      {/* task-pending-share (position 5): значение выше — ДЕЙСТВУЮЩЕЕ, не
          меняется пока согласование открыто (AC2). Индикатор — отдельная
          пометка рядом, а не подмена цифры. */}
      {pending && (
        // task-648-fix-round-3 (COPY-H-7): a COLUMN, not a row. The badge and
        // the withdraw control used to sit side by side; on 320 the project
        // row gives this cell 131px, the (then-longer, `whitespace-nowrap`)
        // badge wanted 160 and the 44px icon button another 44 — the page
        // scrolled sideways by ~59px. Stacking costs vertical space, which is
        // the one axis a phone has to spare.
        <span className="flex min-w-0 basis-full flex-col items-start gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* task-648-fix-round-2 (COPY-H-5): ONE text node, and
                  `tabular-nums`/`whitespace-nowrap` on the badge itself.
                  `Badge` is `inline-flex`, so the `{' '}` this used to
                  carry sat BETWEEN flex items and never rendered — the
                  screen read «Ждёт подтверждения:40%» on every width — and
                  on 320 the number broke away from its label onto a second
                  line as an independent flex item. `textContent`-based
                  assertions could not see either symptom. */}
              {/* task-648-fix-round-3 (COPY-H-7 / COPY-M-15): «Предложено N%».
                  One name for the fact — the same word the cancel toast, the
                  edit-dialog notice and the withdraw button already use,
                  where «Ждёт подтверждения: N%» attached the waiting to the
                  NUMBER instead of to the person (COPY-M-15) and cost 29
                  incompressible px the 320px column did not have (COPY-H-7).
                  `whitespace-nowrap` survives because the shorter string
                  fits: measured against the narrowest ADMIN/SENIOR column. */}
              <Badge
                variant="outline"
                className="text-[10px] border-amber-500/50 text-amber-600 dark:text-amber-400 whitespace-nowrap tabular-nums"
                data-testid="project-senior-share-pending-badge"
              >
                {t`Запропоновано ${pending.percent === null ? pending.effectivePercentAfterApproval : pending.percent}%`}
              </Badge>
            </TooltipTrigger>
            {/* task-648-fix-round-2 (UX-M-3(r2)): capped + wrapping.
                Measured at 468px (ordinary name) and 709px (long name)
                against a 320px viewport before this cap. */}
            <TooltipContent className="max-w-[calc(100vw-2rem)] whitespace-normal">
              <Trans>Діє попередній відсоток, поки новий не підтверджено.</Trans>
            </TooltipContent>
          </Tooltip>
          {/* task-648-fix-round-2 (COPY-M-12 / UX-M-3(r2)): name and the
              "prior percent still applies" fact as plain text. Radix
              Tooltip returns early on `pointerType === 'touch'` and `Badge`
              renders a non-focusable `div`, so in the tooltip these two
              facts were unreachable by touch AND by keyboard. */}
          {/* task-648-fix-round-3 (COPY-H-8): NOT shown to the person the
              proposal waits on. They get the banner above, which addresses
              them in the second person — and one screen telling one reader
              both «Вашу долю… пока вы не подтвердите» and «Подтверждает
              Oleksiy Kovalenko» was the finding. */}
          {audience === 'observer' && (
            <span className="block text-xs text-muted-foreground break-words">
              <Trans>
                Підтверджує {pending.approverName} — поки діє{' '}
                <span className="tabular-nums">{effective}%</span>
              </Trans>
            </span>
          )}
          {/* task-648-fix-round-2 (UX-H-3(r2)): the withdraw control lives
              next to the only indicator that the proposal exists at all. */}
          {canCancelPendingShare && (
            <CancelPendingShareButton
              scope="project"
              id={project.id}
              pendingPercent={
                pending.percent === null ? pending.effectivePercentAfterApproval : pending.percent
              }
            />
          )}
        </span>
      )}
    </span>
  )
}

/**
 * task-drop-share-override-and-receiver (Surface A). Read-only "Доля дропа"
 * widget — twin of `ProjectShareInfo` above for the drop's per-project share.
 * Shows the backend-resolved effective % (override → user default → 5) and an
 * «Override» badge when a project-level override is set.
 */
export function ProjectDropShareInfo({
  project,
}: {
  project: Pick<
    ProjectDetailDto,
    'dropSharePercentOverride' | 'dropSharePercentDefault' | 'effectiveDropSharePercent'
  >
}) {
  const { t } = useLingui()
  const overrideRaw = project.dropSharePercentOverride
  const hasOverride = overrideRaw !== null && overrideRaw !== undefined
  const fallback = project.dropSharePercentDefault ?? 5
  const effective = project.effectiveDropSharePercent ?? (hasOverride ? overrideRaw : fallback)
  return (
    <span className="inline-flex items-center gap-2" data-testid="project-drop-share">
      <span className="font-medium tabular-nums">{effective}%</span>
      {hasOverride ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="text-[10px]"
              data-testid="project-drop-share-override-badge"
            >
              <Trans>Override</Trans>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <Trans>Встановлено для цього проєкту; глобальна частка дропа: {fallback}%</Trans>
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground">{t`(за замовчуванням)`}</span>
      )}
    </span>
  )
}
