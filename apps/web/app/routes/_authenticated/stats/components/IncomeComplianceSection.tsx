import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, ChevronDown, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { Trans, Plural } from '@lingui/react/macro'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

import type { IncomeComplianceOverviewDto, IncomeComplianceReceiverDto } from '@crm/shared'
import { formatMonthLabel } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { financeApi } from '../../finance/api'

// ── Income compliance «Контроль приходов» (task-income-compliance) ────────────
//
// ADMIN + ACCOUNTANT see this on /stats: a company-wide list of income
// receivers (seniors + admin-as-senior + drops with active projects) with an
// «X/N приходов за месяц» progress bar and an expand drawer of the projects
// WITHOUT a counted (VALIDATED|PAID) income. Laggards (least coverage) on top.
// Fed by GET /api/finance/income-compliance — an RBAC-gated aggregate, so this
// section never renders for a non-privileged viewer (the whole /stats route
// is already ADMIN/ACCOUNTANT-only). NOT in the persist allow-list (financial
// data is never written to disk — the query is volatile by default).

/**
 * task-i18n-stage3d-pr4 (template G, COPY-H-fin-2). This is `stats.tsx`'s
 * OWN enum, not the app-wide `Role` — `satisfies` without `as const` (урок
 * #707). DROP was rendered as «Посредник» — none of the four synonyms the
 * glossary actually bans (посередник/підставна особа/номінал/проксі), but a
 * fifth term nobody had approved — and `SENIOR`/`ADMIN_SENIOR` rendered
 * Latin script in an otherwise-Ukrainian sentence. Canon (`CONTEXT.md` →
 * «Волна d»): DROP = «Дроп», SENIOR = «Сеньйор», ADMIN_SENIOR = «Адмін-сеньйор».
 */
const ROLE_LABEL_MESSAGES = {
  SENIOR: msg`Сеньйор`, // en: Senior
  ADMIN_SENIOR: msg`Адмін-сеньйор`, // en: Admin-senior
  DROP: msg`Дроп`, // en: Drop
} satisfies Record<IncomeComplianceReceiverDto['role'], MessageDescriptor>

export function receiverInitials(name: string): string {
  const parts = name.split(/\s/).filter(Boolean)
  if (parts.length === 0) return '—'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

// Status accent per receiver coverage: complete (green) / has-pending (amber) /
// lagging-no-pending (red). Drives the left accent bar, dot and badge.
//
// task-compliance-overview-pending-types: `accruedCount` (a company-booked
// obligation still awaiting the COMPANY's payout) is grouped with
// `pendingCount` (self-declared income still awaiting the ACCOUNTANT) for THIS
// coverage classification only — both mean "nothing left for the receiver to
// do, not their fault", so neither should ever render as the red `lagging`
// false alarm. The two stay separate NUMBERS everywhere else (badge text,
// DTO) — see the extended comment on `incomeComplianceReceiverSchema` — this
// function only decides a colour.
export function receiverStatus(r: IncomeComplianceReceiverDto): 'complete' | 'pending' | 'lagging' {
  if (r.submitted >= r.expected) return 'complete'
  const awaitingSomeoneElse = r.pendingCount + r.accruedCount
  // code-review (round 2, MED): the PREVIOUS suppression sat on the `if` line
  // itself and named BOTH `ConditionalExpression,EqualityOperator` — Stryker
  // applies a line-scoped `// Stryker disable` to EVERY mutant of the named
  // mutator TYPES found on that line, not to one specific replacement value.
  // That `if` line carried several genuinely different, independently
  // catchable mutants (forcing the WHOLE condition to true/false; narrowing
  // `>=` on the gap comparison) ALONGSIDE the two truly equivalent
  // mutations — so the broad directive silently killed six catchable mutants
  // along with the two equivalent ones (confirmed empirically: removing it
  // and re-running let six die to the EXISTING test matrix below, unchanged).
  //
  // Isolating `awaitingSomeoneElse > 0` onto its own line shrinks what's left
  // under the SAME two mutator names to EXACTLY the two mutations this
  // paragraph proves equivalent (re-confirmed empirically after isolating:
  // only these two remained, both provably equivalent — no third mutant
  // appeared here under either name):
  //   - EqualityOperator: `>` widened to `>=`.
  //   - ConditionalExpression: the WHOLE expression forced to literal `true`.
  // Both reduce to the identical question — does anything downstream see a
  // difference between "true" and "awaitingSomeoneElse > 0" for THIS one
  // boolean, used only as the left operand of `hasSomeoneElseInvolved &&
  // awaitingSomeoneElse >= gap`? `pendingCount`/`accruedCount` are
  // `z.number().int().nonnegative()` on the wire
  // (incomeComplianceReceiverSchema), so their sum can never be negative —
  // `> 0` and "always true" therefore differ ONLY at exactly 0. And the line
  // above this one already guarantees `r.expected - r.submitted > 0`
  // whenever this line runs (the `submitted >= expected` case already
  // returned 'complete'), so at `awaitingSomeoneElse === 0` the gap
  // comparison on the right of `&&` is false EITHER WAY. No input
  // (respecting the schema's own nonnegative contract) can make either
  // mutation diverge from the original's output. (A hypothetical
  // force-to-`false` mutant would NOT be equivalent — it would return
  // 'lagging' for every accrued/pending case the test matrix below expects
  // 'pending' — but Stryker does not generate that variant for this node;
  // only the `true` constant shown above.)
  // Stryker disable next-line ConditionalExpression,EqualityOperator: see the paragraph above.
  const hasSomeoneElseInvolved = awaitingSomeoneElse > 0
  if (hasSomeoneElseInvolved && awaitingSomeoneElse >= r.expected - r.submitted) return 'pending'
  return 'lagging'
}

export function ComplianceKpi({
  label,
  value,
  sub,
  color,
}: {
  label: React.ReactNode
  value: string
  sub: React.ReactNode
  color: 'default' | 'green' | 'red' | 'amber'
}) {
  const valueColor: Record<string, string> = {
    default: 'text-foreground',
    green: 'text-green-500',
    red: 'text-red-500',
    amber: 'text-amber-500',
  }
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-bold tabular-nums mt-1', valueColor[color])}>{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  )
}

export function ComplianceReceiverRow({ receiver }: { receiver: IncomeComplianceReceiverDto }) {
  const [open, setOpen] = useState(false)
  const status = receiverStatus(receiver)
  const pct =
    receiver.expected > 0 ? Math.round((receiver.submitted / receiver.expected) * 100) : 100
  const hasMissing = receiver.missingProjects.length > 0

  const accent: Record<typeof status, string> = {
    complete: 'border-l-green-500',
    pending: 'border-l-amber-500',
    lagging: 'border-l-red-500',
  }
  const dot: Record<typeof status, string> = {
    complete: 'bg-green-500',
    pending: 'bg-amber-500',
    lagging: 'bg-red-500',
  }
  const bar: Record<typeof status, string> = {
    complete: 'bg-green-500',
    pending: 'bg-amber-500',
    lagging: 'bg-red-500',
  }
  // code-review (round 2, HIGH): the badge used to be computed INDEPENDENTLY
  // of `status` — `receiver.pendingCount > 0` alone (ignoring whether it
  // actually covers the whole gap) picked the amber "На валидации" wording
  // even when `receiverStatus()` had already decided `lagging` (red), e.g.
  // expected=3, submitted=0, pendingCount=1: pendingCount covers only 1 of 3
  // missing projects, so status is 'lagging', but the OLD badge code still
  // showed the reassuring amber text — a red-bordered row claiming, in its
  // own badge, that everything is in progress. That pattern predates this
  // task (existed for `pendingCount` alone on `main`); this task's
  // `accruedCount` doubled the surface by adding a symmetric, equally
  // ungated branch, so it is fixed here. Gating every non-green/red case
  // through `status === 'pending'` makes the contradiction structurally
  // impossible: the amber sub-wording (mixed / accrued-only / pending-only)
  // only ever renders when `receiverStatus()` has ALREADY confirmed
  // pendingCount+accruedCount fully cover the gap — which is exactly the
  // condition `receiverStatus()` requires to return 'pending' in the first
  // place. `accruedCount` (booked, awaiting the company's payout) still gets
  // its OWN wording within that branch — reusing «На валидации» would be a
  // wrong claim (nobody is validating anything; the accountant has nothing
  // to check, the company just hasn't paid out yet).
  const badge: { text: React.ReactNode; cls: string } =
    status === 'complete'
      ? { text: <Trans>Усі отримано</Trans>, cls: 'bg-green-500/10 text-green-500' }
      : status === 'pending'
        ? receiver.pendingCount > 0 && receiver.accruedCount > 0
          ? {
              text: (
                <Plural
                  value={receiver.pendingCount + receiver.accruedCount}
                  one="# у процесі"
                  few="# у процесі"
                  many="# у процесі"
                  other="# у процесі"
                />
              ),
              cls: 'bg-amber-500/10 text-amber-500',
            }
          : receiver.accruedCount > 0
            ? {
                text:
                  receiver.accruedCount === 1 ? (
                    <Trans>Нараховано</Trans>
                  ) : (
                    <Plural
                      value={receiver.accruedCount}
                      one="# нараховано"
                      few="# нараховано"
                      many="# нараховано"
                      other="# нараховано"
                    />
                  ),
                cls: 'bg-amber-500/10 text-amber-500',
              }
            : {
                text:
                  receiver.pendingCount === 1 ? (
                    <Trans>На валідації</Trans>
                  ) : (
                    <Plural
                      value={receiver.pendingCount}
                      one="# на валідації"
                      few="# на валідації"
                      many="# на валідації"
                      other="# на валідації"
                    />
                  ),
                cls: 'bg-amber-500/10 text-amber-500',
              }
        : {
            text:
              receiver.submitted === 0 ? (
                <Trans>Немає доходів</Trans>
              ) : (
                <Plural
                  value={receiver.expected - receiver.submitted}
                  one="# без доходу"
                  few="# без доходу"
                  many="# без доходу"
                  other="# без доходу"
                />
              ),
            cls: 'bg-red-500/10 text-red-500',
          }

  return (
    <div
      className={cn('rounded-lg border border-l-2 bg-card overflow-hidden', accent[status])}
      data-testid={`compliance-row-${receiver.userId}`}
    >
      <button
        type="button"
        onClick={() => hasMissing && setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 text-left',
          hasMissing ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default',
        )}
        aria-expanded={hasMissing ? open : undefined}
        data-testid={`compliance-toggle-${receiver.userId}`}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">
          {receiverInitials(receiver.displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full shrink-0', dot[status])} />
            <span className="font-medium truncate" title={receiver.displayName}>
              {receiver.displayName}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {i18n._(ROLE_LABEL_MESSAGES[receiver.role])} ·{' '}
            <Plural
              value={receiver.expected}
              one="# активний проєкт"
              few="# активні проєкти"
              many="# активних проєктів"
              other="# активного проєкту"
            />
          </span>
        </div>

        {/* Progress bar */}
        <div className="hidden sm:block w-32 shrink-0">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', bar[status])}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
        </div>

        <span className={cn('rounded px-2 py-0.5 text-[11px] font-medium shrink-0', badge.cls)}>
          {badge.text}
        </span>
        <span className="tabular-nums text-sm font-semibold w-10 text-right shrink-0">
          {receiver.submitted}/{receiver.expected}
        </span>
        {hasMissing ? (
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground shrink-0 transition-transform',
              open && 'rotate-180',
            )}
          />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-green-500/70 shrink-0" />
        )}
      </button>

      <AnimatePresence>
        {open && hasMissing && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div
              className="border-t border-border/60 px-3 py-2.5"
              data-testid={`compliance-detail-${receiver.userId}`}
            >
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                <Trans>Проєкти без зарахованого доходу</Trans>
              </p>
              <ul className="space-y-1.5">
                {receiver.missingProjects.map((p) => (
                  <li key={p.projectId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        data-testid={`compliance-project-dot-${p.projectId}`}
                        className={cn(
                          'h-1.5 w-1.5 rounded-full shrink-0',
                          p.accrued || p.pendingValidation ? 'bg-amber-500' : 'bg-red-500',
                        )}
                      />
                      <span className="truncate font-medium">{p.name}</span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground truncate max-w-32">
                        {p.companyName}
                      </span>
                      <span
                        data-testid={`compliance-project-status-${p.projectId}`}
                        className={cn(
                          'text-xs font-medium',
                          p.accrued || p.pendingValidation ? 'text-amber-500' : 'text-red-500',
                        )}
                      >
                        {/* task-compliance-overview-pending-types: `accrued` gets
                            its own wording — it is a company-booked obligation
                            awaiting PAYOUT, not a self-declared income awaiting
                            VALIDATION («На валідації» would misattribute the
                            wait to the wrong party. */}
                        {p.accrued ? (
                          <Trans>Нараховано · очікує розрахунку</Trans>
                        ) : p.pendingValidation ? (
                          <Trans>На валідації</Trans>
                        ) : (
                          <Trans>Немає доходу</Trans>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function IncomeComplianceSection() {
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['income-compliance'],
    queryFn: () => financeApi.getIncomeCompliance(),
    // Financial aggregate — avoid refetching on every window focus.
    staleTime: 60_000,
  })

  return (
    <section className="space-y-4" data-testid="income-compliance-section">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          <Trans>Контроль доходів</Trans>
        </h2>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : isError ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between sm:gap-3"
          data-testid="income-compliance-error"
        >
          <span>
            <Trans>Не вдалося завантажити дані контролю доходів.</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refetch()}
            disabled={isRefetching}
            className="h-11 w-full shrink-0 sm:h-8 sm:w-auto"
            data-testid="income-compliance-retry"
          >
            <Trans>Повторити</Trans>
          </Button>
        </div>
      ) : data ? (
        <IncomeComplianceBody data={data} />
      ) : null}
    </section>
  )
}

function IncomeComplianceBody({ data }: { data: IncomeComplianceOverviewDto }) {
  const locale = useLocale()
  const { totals, receivers, month } = data
  const coverage =
    totals.expectedProjects > 0
      ? Math.round((totals.submittedProjects / totals.expectedProjects) * 100)
      : 100
  const monthLabel = formatMonthLabel(month, locale)

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <ComplianceKpi
          label={<Trans>Усього доходів</Trans>}
          value={`${totals.submittedProjects} / ${totals.expectedProjects}`}
          sub={
            <Trans>
              покриття {coverage}% · {monthLabel}
            </Trans>
          }
          color="default"
        />
        <ComplianceKpi
          label={<Trans>Закриті повністю</Trans>}
          value={String(totals.completeReceivers)}
          sub={
            <Plural
              value={totals.completeReceivers}
              one="отримувач"
              few="отримувачі"
              many="отримувачів"
              other="отримувача"
            />
          }
          color="green"
        />
        <ComplianceKpi
          label={<Trans>Відстають</Trans>}
          value={String(totals.laggingReceivers)}
          sub={
            <Plural
              value={totals.laggingReceivers}
              one="отримувач"
              few="отримувачі"
              many="отримувачів"
              other="отримувача"
            />
          }
          color="red"
        />
        <ComplianceKpi
          label={<Trans>На валідації у бухгалтера</Trans>}
          value={String(totals.pendingProjects)}
          sub={
            <Plural
              value={totals.pendingProjects}
              one="дохід"
              few="доходи"
              many="доходів"
              other="доходу"
            />
          }
          color="amber"
        />
      </div>

      {/* Receiver list — laggards first (already sorted by the API) */}
      {receivers.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <Trans>Немає активних проєктів-отримувачів доходу за {monthLabel}.</Trans>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1" data-testid="compliance-list">
          {receivers.map((r) => (
            <ComplianceReceiverRow key={r.userId} receiver={r} />
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/60">
        <Trans>
          Зараховується дохід у статусі «валідовано» або «виплачено» за поточний місяць. Згодом:
          ручні винятки (пауза / відпустка) і автоматичні нагадування.
        </Trans>
      </p>
    </div>
  )
}
