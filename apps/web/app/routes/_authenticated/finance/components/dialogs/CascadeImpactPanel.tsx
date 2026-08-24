/**
 * task-cascade-preview-ui (task 5) — what editing a PAID row's amount will do
 * to the money that already moved, shown BEFORE the operator commits to it.
 *
 * Spec: `docs/design/cascade-preview.md` §4. The server-side cascade shipped in
 * #598–#608 and was, until this component, unreachable from the interface: the
 * client never asked for a preview and never sent the version token back, so
 * every edit of a paid amount was refused.
 *
 * ONE TEXT, NOT TWO DESCRIPTIONS. Every sentence about MONEY here — why a row
 * is blocked, why a warning fired, why a save was rejected — is rendered
 * verbatim from the server (`warning.message`,
 * `CASCADE_BLOCKED_REASON_MESSAGES`, the 400/409 body). This component writes
 * only field labels. A second, friendlier phrasing of a refusal on the client
 * is how the two descriptions drift, and on a money path the drift is silent.
 *
 * LAYOUT. One data source, two renders: a table from `sm:` up, cards below it.
 * The breakpoint is 640px rather than the module's usual 768px on purpose —
 * five short columns are denser and more scannable than five stacked cards at
 * tablet width, and density is the whole tone of this module. At 320px a table
 * would mean a horizontal scroll inside a dialog, which is where numbers get
 * missed.
 */
import { AlertCircle, AlertTriangle, ArrowRight, Ban, RefreshCw, RotateCcw } from 'lucide-react'

import type { CascadeDerivativePlan, CascadeEditPreviewResponse } from '@crm/shared'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import {
  CASCADE_BLOCKED_FALLBACK_MESSAGE,
  CASCADE_BLOCKED_REASON_MESSAGES,
  TYPE_COLORS,
  TYPE_LABELS,
  fmtAmount,
} from '../../constants'

// Stryker disable next-line StringLiteral: the two variants are decided by `=== 'mobile'`, so ANY non-'mobile' value (including '') selects the desktop rendering — the mutant is equivalent by construction. Which layout each id lands in is pinned by PR-29/PR-30
const DESKTOP = 'desktop' as const

/** A destructive warning stops the save; an amber one is for the human to weigh. */
const BLOCKING_WARNING_CODES = new Set(['NO_SHARE_SNAPSHOT', 'OBLIGATION_CURRENCY_MISMATCH'])

export interface CascadeImpactPanelProps {
  preview: CascadeEditPreviewResponse | undefined
  isLoading: boolean
  /** A genuine network failure — an `editable: false` answer is a 200, not this. */
  isNetworkError: boolean
  onRetry: () => void
  /**
   * The server's 409 text, verbatim, when the plan on screen was overtaken by a
   * concurrent change. Non-null ⇒ the plan below is stale and Save is refused
   * until it is re-fetched.
   */
  staleMessage: string | null
  /** Receiver of the SOURCE row — the senior a `SENIOR_PENDING_PAYOUT` share belongs to. */
  sourceReceiverName: string | null
}

/**
 * The receiver of a derivative, as far as it can be known honestly.
 *
 * `CascadeDerivativePlan` carries no receiver (see the design spec §14.2): the
 * resolver is pure and `loadCascadeSnapshot` selects only what the arithmetic
 * needs. For a senior share the source row's own receiver IS that senior, so
 * the name is reused. For a drop share there is nothing to reuse, and the label
 * stays nameless rather than guessing — a wrong name on a money screen is worse
 * than no name.
 */
const SENIOR_DERIVATIVE_TYPES = new Set(['SENIOR_PENDING_PAYOUT', 'SENIOR_INCOME'])
const DROP_DERIVATIVE_TYPES = new Set(['DROP_PENDING_PAYOUT', 'PAYOUT_DROP'])

function derivativeReceiverLabel(
  derivative: CascadeDerivativePlan,
  sourceReceiverName: string | null,
): string | null {
  // UX-1 (design fidelity, HIGH): match the FAMILY, not the pending type.
  //
  // `settleByCompany` flips an IOU in place — `SENIOR_PENDING_PAYOUT` becomes
  // `SENIOR_INCOME`, `DROP_PENDING_PAYOUT` becomes `PAYOUT_DROP` — and
  // `loadCascadeSnapshot` reads `type: d.type`, i.e. the CURRENT one. Matching
  // only the pending type therefore failed on exactly the population this
  // screen exists for: an already-paid share about to be reverted. The single
  // most consequential row on the panel showed no receiver at all.
  if (SENIOR_DERIVATIVE_TYPES.has(derivative.type) && sourceReceiverName) {
    return `Синьору ${sourceReceiverName}`
  }
  if (DROP_DERIVATIVE_TYPES.has(derivative.type)) return 'Доля дропа'
  return null
}

function WarningLine({
  warning,
  testId,
}: {
  warning: CascadeDerivativePlan['warnings'][number]
  testId: string
}) {
  const blocking = BLOCKING_WARNING_CODES.has(warning.code)
  const Icon = blocking ? AlertCircle : AlertTriangle

  return (
    <p
      className={cn(
        // Stryker disable next-line StringLiteral: pure layout (flex/gap/size). The SEVERITY half of this className is pinned by PR-34/PR-34b; no rendered output distinguishes these spacing utilities from an empty string, and asserting them would pin the stylesheet rather than the behaviour
        'flex items-start gap-1.5 text-[11px] leading-snug',
        blocking ? 'text-destructive' : 'text-amber-400',
      )}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
      <span>{warning.message}</span>
    </p>
  )
}

/**
 * The same badge appears in both layouts, so its testid MUST differ between
 * them: two nodes under one testid is a strict-mode violation in Playwright and
 * an ambiguous query in Testing Library — the exact failure this file's own
 * spec caught before review did. The suffix is passed in rather than derived
 * inside, so adding a third layout cannot silently reuse an id.
 */
function ReconfirmBadge({
  derivativeId,
  variant,
}: {
  derivativeId: string
  variant: 'desktop' | 'mobile'
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400"
      data-testid={
        variant === 'mobile'
          ? `cascade-derivative-reconfirm-${derivativeId}-mobile`
          : `cascade-derivative-reconfirm-${derivativeId}`
      }
    >
      <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
      Вернётся в ожидание выплаты
    </span>
  )
}

/** «Было → Стало», or an explicit dash when there is no share snapshot to recompute from. */
function AmountTransition({ derivative }: { derivative: CascadeDerivativePlan }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5 tabular-nums">
      {/* `whitespace-nowrap` on each FIGURE, not on the pair: at 320 px the two
          amounts do not fit on one line, and the honest break is between them.
          Without it the break lands inside a figure and «8 000,00 USDT» renders
          as «8 000,00 / USDT» — a number separated from its unit, on a screen
          whose whole job is to be unambiguous about money. */}
      <span className="whitespace-nowrap text-muted-foreground">
        {fmtAmount(derivative.oldAmount, derivative.currency)}
      </span>
      {/* UX-4 (design fidelity): the arrow travels WITH the new figure.
          
          Measured: inside the `max-w-3xl` dialog this column is ~161px at every
          desktop width (768…1920 — the dialog is capped, so the viewport does
          not widen it), while «8 000,00 USDT → 10 000,00 USDT» needs ~190px.
          The wrap is therefore unavoidable without widening the dialog again,
          which is the change that caused the 768px overflow in the first place.
          What WAS fixable is where the break lands: the arrow used to trail the
          end of line one, leaving «→» pointing at nothing. Grouped with the new
          amount it reads as a two-line before/after stack. */}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        {derivative.newAmount === null ? (
          <span className="font-medium text-destructive">—</span>
        ) : (
          <span className="font-medium">
            {fmtAmount(derivative.newAmount, derivative.currency)}
          </span>
        )}
      </span>
    </span>
  )
}

/**
 * ONE derivative, rendered twice from the same data — a table row from `sm:` up,
 * a card below. Two files would be two chances for the figures to disagree.
 */
function CascadeDerivativeRow({
  derivative,
  sourceReceiverName,
}: {
  derivative: CascadeDerivativePlan
  sourceReceiverName: string | null
}) {
  const receiverLabelText = derivativeReceiverLabel(derivative, sourceReceiverName)
  // Found by looking at the rendered screen, not at the code: on a settled drop
  // row `TYPE_LABELS.PAYOUT_DROP` is ITSELF «Доля дропа», so the badge and the
  // line under it said the same three words twice. A receiver line that only
  // repeats the badge is noise; stated as a general guard rather than a special
  // case for this one type, so a future label collision cannot reintroduce it.
  const receiver = receiverLabelText === TYPE_LABELS[derivative.type] ? null : receiverLabelText
  const settledLabel =
    derivative.settledAmount > 0
      ? fmtAmount(derivative.settledAmount, derivative.settledCurrency ?? derivative.currency)
      : null
  // UX-3 (design fidelity): a fully closed row has nothing left to pay, and
  // «0,00 USDT» in a «К доплате» column is a figure the operator must read and
  // then discard on every settled row. `null` (currencies not comparable) and
  // zero are both "no actionable remainder" — one dash for both.
  const remainingLabel =
    derivative.remainingToPay === null || derivative.remainingToPay === 0
      ? '—'
      : fmtAmount(derivative.remainingToPay, derivative.currency)
  const warningsFor = (variant: 'desktop' | 'mobile') =>
    derivative.warnings.map((w) => (
      <WarningLine
        key={w.code}
        warning={w}
        testId={
          variant === 'mobile'
            ? `cascade-derivative-warning-${derivative.id}-${w.code}-mobile`
            : `cascade-derivative-warning-${derivative.id}-${w.code}`
        }
      />
    ))
  // Stryker disable next-line LogicalOperator: `&&` and `||` render the SAME text — with `||` a truthy receiver renders as a bare string and a falsy one as an empty span; no query distinguishes either from the `&&` form. The receiver TEXT is pinned by PR-3/PR-4/PR-5
  const receiverLine = receiver && <span className="text-xs text-muted-foreground">{receiver}</span>
  // Stryker disable next-line ConditionalExpression,EqualityOperator: this guard only avoids an EMPTY wrapper div — always-true renders a container with no children, byte-identical in text and in every query. Its CONTENTS are pinned by PR-12/PR-30/PR-36
  const showMobileStatusBlock = derivative.needsReconfirm || derivative.warnings.length > 0
  const typeBadge = (
    <span
      className={cn(
        // Stryker disable next-line StringLiteral: pure layout. The badge's MEANING is `TYPE_COLORS[type]` plus its text, both asserted (PR-3/PR-4); these are the shared pill utilities every badge in this module uses
        'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TYPE_COLORS[derivative.type],
      )}
    >
      {TYPE_LABELS[derivative.type]}
    </span>
  )

  return (
    <>
      {/* Desktop — table row. `hidden sm:table-row` rather than a second
          component so both layouts read the same fields. */}
      <tr
        className={cn(
          // The `hidden`/`sm:table-row` pair IS the responsive contract and is asserted by PR-15; the border utilities beside it are pure layout.
          'hidden border-b border-border/50 last:border-0 sm:table-row',
          derivative.needsReconfirm && 'border-l-2 border-l-amber-500 bg-amber-500/5',
        )}
        data-testid={`cascade-derivative-${derivative.id}`}
      >
        <td className="px-2 py-2.5 align-top">
          <div className="flex flex-col gap-1">
            {typeBadge}
            {receiverLine}
          </div>
        </td>
        <td className="px-2 py-2.5 text-right align-top whitespace-nowrap">
          <AmountTransition derivative={derivative} />
        </td>
        <td className="px-2 py-2.5 text-right align-top tabular-nums whitespace-nowrap">
          {settledLabel ?? <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-2 py-2.5 text-right align-top tabular-nums font-medium whitespace-nowrap">
          {remainingLabel}
        </td>
        <td className="px-2 py-2.5 align-top">
          <div className="flex flex-col gap-1">
            {derivative.needsReconfirm && (
              <ReconfirmBadge derivativeId={derivative.id} variant="desktop" />
            )}
            {warningsFor(DESKTOP)}
          </div>
        </td>
      </tr>

      {/* Mobile — card. A `<dl>` so the label→value pairing survives a screen
          reader, which a bare `flex justify-between` does not carry. */}
      <tr className="sm:hidden" data-testid={`cascade-derivative-mobile-row-${derivative.id}`}>
        <td colSpan={5} className="pb-2">
          <div
            className={cn(
              // Stryker disable next-line StringLiteral: pure layout (radius/padding/size); the ACCENT branch below it is asserted by PR-36
              'rounded-lg border p-3 text-sm',
              derivative.needsReconfirm
                ? 'border-amber-500/30 bg-amber-500/5'
                : 'border-border bg-muted/30',
            )}
            data-testid={`cascade-derivative-mobile-${derivative.id}`}
          >
            <div className="flex flex-col gap-1">
              {typeBadge}
              {receiverLine}
            </div>
            <dl className="mt-2 space-y-1 border-t border-border/50 pt-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">Было → Стало</dt>
                <dd className="text-right">
                  <AmountTransition derivative={derivative} />
                </dd>
              </div>
              {settledLabel && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Выплачено</dt>
                  <dd className="text-right tabular-nums">{settledLabel}</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted-foreground">К доплате</dt>
                <dd className="text-right font-medium tabular-nums">{remainingLabel}</dd>
              </div>
            </dl>
            {showMobileStatusBlock && (
              <div className="mt-2 flex flex-col gap-1">
                {derivative.needsReconfirm && (
                  <ReconfirmBadge derivativeId={derivative.id} variant="mobile" />
                )}
                {warningsFor('mobile')}
              </div>
            )}
          </div>
        </td>
      </tr>
    </>
  )
}

export function CascadeImpactPanel({
  preview,
  isLoading,
  isNetworkError,
  onRetry,
  staleMessage,
  sourceReceiverName,
}: CascadeImpactPanelProps) {
  // A narrow live region, not the whole panel: announcing the entire table
  // again on every keystroke is worse for a screen-reader user than announcing
  // nothing. The status line changes, the table does not re-announce.
  //
  // COPY-M-8: it reports the OUTCOME, not merely that an answer arrived. The
  // refusal banner is not inside the live region, so on `editable: false` the
  // only thing a screen-reader user used to hear was «Предпросмотр обновлён» —
  // the opposite of what the screen says.
  const status = isLoading
    ? 'Пересчитываем связанные выплаты…'
    : preview && !preview.editable
      ? 'Правка суммы этой строки запрещена, причина ниже'
      : preview
        ? 'Предпросмотр обновлён'
        : ''

  return (
    <div className="space-y-2" data-testid="cascade-impact-panel">
      <p
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="cascade-preview-status"
      >
        {status}
      </p>

      {isLoading && (
        <div className="space-y-1.5" data-testid="cascade-preview-loading">
          <Skeleton className="h-4 w-40" />
          <p className="text-xs text-muted-foreground">Пересчитываем связанные выплаты…</p>
        </div>
      )}

      {/* COPY-M-7: stacks below `sm:`, exactly like the stale banner further
          down. Measured at 320px: an inline `shrink-0` button left the text a
          135px column and blew a 56-character sentence into five lines; the
          neighbour's `flex-col sm:flex-row` gives it 246px. Parity with an
          existing solution, not a new pattern — and the text stays as it is,
          because even trimmed to 33 characters it still wrapped to three lines
          in the narrow column. */}
      {!isLoading && isNetworkError && (
        <div
          className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between sm:gap-3"
          data-testid="cascade-preview-error"
        >
          <span>Не удалось загрузить предпросмотр — проверьте соединение</span>
          {/* h-11 below `sm:` — the responsive rule's 44px touch target, not
              the 24px WCAG floor. Measured at 320/375: the default `size="sm"`
              button is 32px tall. */}
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            className="h-11 w-full shrink-0 sm:h-8 sm:w-auto"
            data-testid="cascade-preview-retry"
          >
            Повторить
          </Button>
        </div>
      )}

      {!isLoading && !isNetworkError && preview && !preview.editable && (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
          data-testid="cascade-blocked-banner"
        >
          <Ban className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          <span>
            {preview.blockedReason
              ? CASCADE_BLOCKED_REASON_MESSAGES[preview.blockedReason]
              : CASCADE_BLOCKED_FALLBACK_MESSAGE}
          </span>
        </div>
      )}

      {!isLoading && !isNetworkError && preview?.editable && preview.plan && (
        <>
          {staleMessage && (
            <div
              className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-400 sm:flex-row sm:items-center sm:justify-between"
              data-testid="cascade-stale-banner"
            >
              <span>{staleMessage}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={onRetry}
                className="h-11 w-full sm:h-8 sm:w-auto"
                data-testid="cascade-refresh-preview"
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Обновить предпросмотр
              </Button>
            </div>
          )}

          {/* The plan stays visible under a stale banner, dimmed: the operator
              needs to see WHAT went out of date, not lose the context. */}
          <div
            className={cn(staleMessage && 'pointer-events-none opacity-60')}
            data-testid="cascade-plan-body"
          >
            {preview.plan.derivatives.length === 0 ? (
              <p
                className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs"
                data-testid="cascade-preview-empty"
              >
                Эта сумма не связана с выплатами — пересчитывать нечего
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Что изменится при сохранении
                </p>

                <p
                  className="flex flex-wrap items-center gap-1.5 text-xs tabular-nums"
                  data-testid="cascade-source-amount"
                >
                  <span className="text-muted-foreground">Сумма источника:</span>
                  <span className="text-muted-foreground">
                    {fmtAmount(preview.plan.oldSourceAmount, preview.plan.sourceCurrency)}
                  </span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="font-medium">
                    {fmtAmount(preview.plan.newSourceAmount, preview.plan.sourceCurrency)}
                  </span>
                </p>

                {preview.plan.sourceWarnings.map((w) => (
                  <WarningLine
                    key={w.code}
                    warning={w}
                    testId={`cascade-source-warning-${w.code}`}
                  />
                ))}

                <table className="w-full text-sm">
                  <thead className="hidden sm:table-header-group" data-testid="cascade-table-head">
                    <tr className="border-b border-border/50 text-xs text-muted-foreground">
                      <th scope="col" className="px-2 py-2 text-left font-medium">
                        Получатель
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        Было → Стало
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        Выплачено
                      </th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">
                        К доплате
                      </th>
                      <th scope="col" className="px-2 py-2 text-left font-medium">
                        Статус
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.plan.derivatives.map((d) => (
                      <CascadeDerivativeRow
                        key={d.id}
                        derivative={d}
                        sourceReceiverName={sourceReceiverName}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
