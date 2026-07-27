import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Loader2 } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { financeApi } from '../../api'
import { fmtAmount, STATUS_COLORS, STATUS_LABELS } from '../../constants'
import {
  buildPreviewRows,
  groupByProject,
  type ProjectIncomeGroup,
} from '../../utils/company-share'
import { usePayoutPaymentForm } from '../../hooks/usePayoutPaymentForm'
import { PayoutPaymentForm } from './PayoutPaymentForm'

type Step = 'select' | 'pay'

/**
 * StepDot — tiny non-clickable progress indicator (design spec §5.3). Three
 * visual states; NOT a toggle — unlike `SegmentedToggle` this is sequential
 * progress, not a mutually-exclusive selector, so there is no "go back"
 * affordance from step 2 to step 1 (the payout already exists server-side).
 */
function StepDot({ state, label }: { state: 'upcoming' | 'active' | 'done'; label: string }) {
  return (
    <span
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
        state === 'active' && 'border-primary bg-primary text-primary-foreground',
        state === 'done' && 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
        state === 'upcoming' && 'border-border text-muted-foreground',
      )}
    >
      {state === 'done' ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : label}
    </span>
  )
}

/**
 * ProjectRow — one project group in step 1. A separate component (not an
 * inline `.map()` closure) because the tri-state checkbox needs its own
 * `useRef`/`useEffect` for the native `.indeterminate` DOM property — calling
 * hooks inside an array-map callback would violate the Rules of Hooks.
 */
function ProjectRow({
  project,
  selected,
  onToggleProject,
  onToggleTx,
  disabled,
}: {
  project: ProjectIncomeGroup
  selected: Set<string>
  onToggleProject: (ids: string[]) => void
  onToggleTx: (id: string) => void
  disabled: boolean
}) {
  const projectRef = useRef<HTMLInputElement>(null)
  const incomeIds = project.incomes.map((t) => t.id)
  const selectedCount = incomeIds.filter((id) => selected.has(id)).length
  const allSelected = selectedCount === incomeIds.length
  const noneSelected = selectedCount === 0
  const projectTotal = project.incomes.reduce((sum, t) => sum + parseFloat(t.amount), 0)
  const currency = project.incomes[0]?.currency ?? 'USDT'

  useEffect(() => {
    if (projectRef.current) projectRef.current.indeterminate = !allSelected && !noneSelected
  }, [allSelected, noneSelected])

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 p-3 hover:bg-muted/30">
        <input
          ref={projectRef}
          type="checkbox"
          checked={allSelected}
          onChange={() => onToggleProject(incomeIds)}
          disabled={disabled}
          className="h-4 w-4 shrink-0 accent-primary"
          aria-label={`Выбрать все приходы проекта ${project.projectName}`}
          data-testid={`company-share-project-checkbox-${project.projectId}`}
        />
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{project.projectName}</span>
          <span className="shrink-0 tabular-nums text-sm font-medium">
            {fmtAmount(projectTotal, currency)}
          </span>
        </span>
      </label>
      {project.incomes.map((tx) => (
        <label
          key={tx.id}
          className="flex min-h-11 cursor-pointer items-center gap-3 border-t border-border py-2.5 pl-10 pr-3 hover:bg-muted/20"
        >
          <input
            type="checkbox"
            checked={selected.has(tx.id)}
            onChange={() => onToggleTx(tx.id)}
            disabled={disabled}
            className="h-4 w-4 shrink-0 accent-primary"
            aria-label={`Приход от ${new Date(tx.txDate ?? tx.createdAt).toLocaleDateString('ru-RU')}`}
            data-testid={`company-share-income-checkbox-${tx.id}`}
          />
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">
              Приход от {new Date(tx.txDate ?? tx.createdAt).toLocaleDateString('ru-RU')}
            </span>
            <span className="shrink-0 tabular-nums text-xs">
              {fmtAmount(tx.amount, tx.currency)}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}

/**
 * CompanySharePayoutModal — two-step payout modal (task-company-share-cta,
 * design spec §5-§7). Replaces `PayoutDialog.tsx`.
 *
 * Step 1 ("select"): projects grouped with their unpaid VALIDATED incomes,
 * tri-state project checkbox + per-income checkboxes, live total.
 * Step 2 ("pay"): the SAME mounted `<Dialog>`/`<CrmDialogContent>` switches
 * its inner content to `PayoutPaymentForm` for the just-created payout — this
 * (NOT a re-mount) is the mechanism behind "the modal does not close" after
 * submit (owner's explicit requirement, design spec §5/§7.1).
 *
 * Prop shape mirrors the old `PayoutDialog` 1:1 (`open` / `onClose` /
 * `validatedTxs` / `preselectedTxIds`) so every existing call site — the
 * finance page header button, the per-row «Выплатить» button, and
 * `InProgressPanel`'s toolbar/row buttons (SENIOR *and* DROP, see design spec
 * §9) — swaps in with a rename only.
 */
export function CompanySharePayoutModal({
  open,
  onClose,
  validatedTxs,
  preselectedTxIds,
}: {
  open: boolean
  onClose: () => void
  validatedTxs: TransactionDto[]
  /**
   * Pre-checked transaction ids. A NON-EMPTY list means a specific row asked
   * for itself only (row-level «Выплатить» — kept exactly as before). An
   * EMPTY/absent list means a generic multi-select entry point (banner,
   * header button, toolbar batch button) — those now default to "everything
   * selected" (design spec §6.6): the banner already promised "N projects,
   * amount X", so opening to an empty list would contradict its own claim.
   */
  preselectedTxIds?: string[]
}) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const canManualConfirm = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'

  const [step, setStep] = useState<Step>('select')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselectedTxIds ?? []))
  const [payoutId, setPayoutId] = useState<string | null>(null)

  const step2Ref = useRef<HTMLDivElement>(null)

  // Sync selection whenever the modal (re-)opens. Same "select all" default
  // for every generic entry point; a non-empty preselect (single-row) wins.
  useEffect(() => {
    if (open) {
      setStep('select')
      setPayoutId(null)
      setSelected(
        new Set(
          preselectedTxIds && preselectedTxIds.length > 0
            ? preselectedTxIds
            : validatedTxs.map((t) => t.id),
        ),
      )
    }
    // validatedTxs is intentionally excluded from deps: it's a fresh array
    // reference every parent render, and re-syncing on every such render
    // would blow away in-progress selection edits. Only re-sync on an actual
    // open/preselect transition — same pattern the old PayoutDialog used.
  }, [open, preselectedTxIds])

  // A11y (design spec §5.4): move focus to step 2's content when we switch to
  // it — the "Создать выплату" button the user just clicked has logically
  // disappeared under new content.
  useEffect(() => {
    if (step === 'pay') step2Ref.current?.focus()
  }, [step])

  function handleClose() {
    paymentState.resetLocal()
    onClose()
    setStep('select')
    setSelected(new Set())
    setPayoutId(null)
  }

  const paymentState = usePayoutPaymentForm(payoutId, step === 'pay', {
    onAutoClose: handleClose,
  })

  const createMutation = useMutation({
    mutationFn: () => financeApi.createPayoutRequest({ transactionIds: [...selected] }),
    onSuccess: (payout) => {
      // Seed the cache with the mutation response so step 2 renders
      // instantly (no skeleton flash) while staying independently
      // refetch-able (design spec §7.1).
      qc.setQueryData(['payout-request', payout.id], payout)
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['payout-requests'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      toast.success('Заявка на выплату создана')
      setPayoutId(payout.id)
      setStep('pay') // NOT onClose() — the modal stays open (owner's requirement).
    },
  })

  const projects = useMemo(() => groupByProject(validatedTxs), [validatedTxs])

  const seniorDefault = user?.seniorSharePercent ?? 26
  const selectedTxs = validatedTxs.filter((t) => selected.has(t.id))
  // selectedTxs is a derived array (new reference per render); depending on
  // `selected` + `validatedTxs` directly keeps this memo correct without an
  // extra dep-churn workaround.
  const previewRows = useMemo(
    () => buildPreviewRows(selectedTxs, seniorDefault),
    [selected, validatedTxs, seniorDefault],
  )
  const selectedCurrencies = new Set(selectedTxs.map((t) => t.currency))
  const hasMixedCurrencies = selectedCurrencies.size > 1
  const batchCurrency =
    selectedCurrencies.size === 1 ? ([...selectedCurrencies][0] as string) : 'USDT'
  const payable = previewRows.reduce((sum, r) => sum + r.payable, 0)
  const totalOwn = previewRows.reduce((sum, r) => sum + r.ownShare, 0)
  const totalIncome = selectedTxs.reduce((sum, t) => sum + parseFloat(t.amount), 0)

  const perCurrencyBreakdown: Record<string, { income: number; payable: number }> = {}
  for (const row of previewRows) {
    const cur = row.tx.currency
    perCurrencyBreakdown[cur] ??= { income: 0, payable: 0 }
    perCurrencyBreakdown[cur]!.income += parseFloat(row.tx.amount)
    perCurrencyBreakdown[cur]!.payable += row.payable
  }

  function toggleTx(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleProject(incomeIds: string[]) {
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = incomeIds.every((id) => next.has(id))
      for (const id of incomeIds) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const createError = createMutation.error instanceof Error ? createMutation.error.message : null

  const isPaid = paymentState.isPaid
  // `PayoutRequestDto.status` is its OWN 'PENDING' | 'PAID' enum — distinct
  // from `TransactionStatus`. The badge deliberately reuses the transaction
  // table's PENDING_PAYMENT/PAID visual language (design spec §7.2) so it
  // reads consistently with everything else the SENIOR already sees, not the
  // payout_request's internal status wording.
  const payoutStatusKey = isPaid ? 'PAID' : 'PENDING_PAYMENT'
  const stepAriaLabel =
    step === 'pay'
      ? 'Шаг 2 из 2: оплата созданной заявки'
      : 'Шаг 1 из 2: выбор приходов для выплаты'

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent
        maxWidth="sm:max-w-lg"
        className="max-h-[100dvh] sm:max-h-[90dvh]"
        data-testid="company-share-payout-modal"
      >
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 'select' ? 'Оплата доли CheekyCheeseIT' : 'Заявка на выплату'}
            {step === 'pay' && paymentState.payout && (
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
                  STATUS_COLORS[payoutStatusKey],
                )}
              >
                {STATUS_LABELS[payoutStatusKey]}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {step === 'select'
              ? 'Выберите проекты и приходы, которые войдут в заявку на выплату.'
              : 'Переведите сумму компании и подтвердите оплату.'}
          </DialogDescription>
          <div className="mt-3 flex items-center gap-2" role="status" aria-label={stepAriaLabel}>
            <StepDot state={step === 'select' ? 'active' : 'done'} label="1" />
            <span className="text-xs font-medium">Выбор</span>
            <span
              className={cn('h-px w-8', step !== 'select' ? 'bg-emerald-500/30' : 'bg-border')}
            />
            <StepDot
              state={step === 'select' ? 'upcoming' : isPaid ? 'done' : 'active'}
              label="2"
            />
            <span className="text-xs font-medium">Оплата</span>
          </div>
          {/* Live region — announces the step change once, not on every
              re-render (design spec §5.4, second a11y mechanism). */}
          <div aria-live="polite" className="sr-only" data-testid="company-share-step-announcer">
            {step === 'pay'
              ? 'Шаг 2 из 2. Заявка на выплату создана. Деньги ещё не отправлены.'
              : ''}
          </div>
        </CrmDialogHeader>

        {step === 'select' ? (
          <>
            <CrmDialogBody className="pb-4">
              <div className="space-y-4">
                {validatedTxs.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Нет проверенных приходов
                  </p>
                ) : (
                  <fieldset disabled={createMutation.isPending} className="space-y-2">
                    {projects.map((project) => (
                      <ProjectRow
                        key={project.projectId}
                        project={project}
                        selected={selected}
                        onToggleProject={toggleProject}
                        onToggleTx={toggleTx}
                        disabled={createMutation.isPending}
                      />
                    ))}
                  </fieldset>
                )}

                {selected.size > 0 &&
                  (hasMixedCurrencies ? (
                    <div
                      className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm"
                      data-testid="company-share-selection-total"
                    >
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Выбрано</span>
                        <span className="font-medium">
                          {selected.size} прих. ·{' '}
                          {new Set(selectedTxs.map((t) => t.projectId)).size} проект.
                        </span>
                      </div>
                      <div className="h-px bg-border/60" />
                      <p className="text-xs text-muted-foreground">Разбивка по валютам:</p>
                      {Object.entries(perCurrencyBreakdown).map(([cur, totals]) => (
                        <div key={cur} className="space-y-0.5 pl-2 border-l-2 border-border/60">
                          <div className="flex justify-between font-medium">
                            <span>{cur}</span>
                            <span className="tabular-nums">{fmtAmount(totals.income, cur)}</span>
                          </div>
                          <div className="flex justify-between text-xs text-primary">
                            <span>Итого к оплате</span>
                            <span className="tabular-nums">{fmtAmount(totals.payable, cur)}</span>
                          </div>
                        </div>
                      ))}
                      <p className="text-xs text-muted-foreground/70">
                        Итоговая выплата будет в USDT — конвертация по курсу НБУ на момент создания
                      </p>
                    </div>
                  ) : (
                    <div
                      className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm"
                      data-testid="company-share-selection-total"
                    >
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Выбрано</span>
                        <span className="font-medium">
                          {selected.size} прих. ·{' '}
                          {new Set(selectedTxs.map((t) => t.projectId)).size} проект.
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Общая сумма</span>
                        <span className="font-medium tabular-nums">
                          {fmtAmount(totalIncome, batchCurrency)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Остаётся вам</span>
                        <span className="font-medium tabular-nums">
                          {fmtAmount(totalOwn, batchCurrency)}
                        </span>
                      </div>
                      <div className="flex justify-between text-primary">
                        <span>Итого к оплате</span>
                        <span className="font-bold tabular-nums">
                          {fmtAmount(payable, batchCurrency)}
                        </span>
                      </div>
                    </div>
                  ))}

                {createError && <p className="text-xs text-destructive">{createError}</p>}
              </div>
            </CrmDialogBody>

            {/* max-sm:min-h-11: footer buttons stack full-width on mobile
                (CrmDialogFooter default) and ARE the whole touch target here
                (unlike the banner, where a larger outer <button> already
                covers it) — 44px floor only below sm, desktop unaffected. */}
            <CrmDialogFooter>
              <Button variant="outline" onClick={handleClose} className="max-sm:min-h-11">
                Отмена
              </Button>
              <Button
                data-testid="company-share-create-payout"
                onClick={() => createMutation.mutate()}
                disabled={selected.size === 0 || createMutation.isPending}
                className="max-sm:min-h-11"
              >
                {createMutation.isPending ? 'Создание...' : 'Создать выплату'}
              </Button>
            </CrmDialogFooter>
          </>
        ) : (
          <>
            <CrmDialogBody className="pb-4">
              {/* tabIndex=-1: programmatic focus target only (§5.4), not tab-reachable. */}
              <div
                ref={step2Ref}
                tabIndex={-1}
                className="space-y-4 outline-none"
                data-testid="company-share-step2-content"
              >
                {!isPaid && paymentState.onChainStatus !== 'confirmed' && (
                  <div
                    role="status"
                    className="flex gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
                    data-testid="company-share-created-notice"
                  >
                    <CheckCircle2
                      className="h-4 w-4 shrink-0 text-emerald-500"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="text-xs font-medium text-emerald-400">Заявка создана</p>
                      <p className="text-[11px] text-muted-foreground">
                        Деньги ещё не отправлены — переведите сумму и укажите хеш транзакции ниже.
                      </p>
                    </div>
                  </div>
                )}
                <PayoutPaymentForm state={paymentState} canManualConfirm={canManualConfirm} />
              </div>
            </CrmDialogBody>

            <CrmDialogFooter>
              <Button
                variant="outline"
                onClick={handleClose}
                data-testid="company-share-close-step2"
                className="max-sm:min-h-11"
              >
                Закрыть
              </Button>
              {!isPaid && paymentState.onChainStatus !== 'confirmed' && (
                <Button
                  data-testid="company-share-submit-payment"
                  onClick={() => paymentState.payMutation.mutate()}
                  disabled={paymentState.submitDisabled}
                  className="max-sm:min-h-11"
                >
                  {paymentState.payMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Проверка…
                    </>
                  ) : (
                    'Подтвердить оплату'
                  )}
                </Button>
              )}
            </CrmDialogFooter>
          </>
        )}
      </CrmDialogContent>
    </Dialog>
  )
}
