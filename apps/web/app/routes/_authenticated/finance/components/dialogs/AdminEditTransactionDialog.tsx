import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Trans, useLingui } from '@lingui/react/macro'
import { PAID_ROW_LOCKED_FIELD_ERROR_CODES, type TransactionDto } from '@crm/shared'
import { cn, parseStrictAmount } from '@/lib/utils'
import { getAxiosStatus, translateApiError } from '@/lib/axios-utils'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { financeApi } from '../../api'
import {
  cascadeSaveErrorMessage,
  cascadeStaleMessage,
  paidRowAmountLockReason,
} from '../../cascade-preview'
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_MESSAGES,
  TYPE_LABEL_MESSAGES,
  cascadeBlockedReasonMessage,
  fmtAmount,
} from '../../constants'
import { CascadeImpactPanel } from './CascadeImpactPanel'
import { changedSalaryMonth } from './changed-salary-month'
import { changedTxDatePayload, storedTxDate } from './changed-tx-date'
import { useCascadePreviewState } from './use-cascade-preview-state'
import { TxDateField, isReasonRequiredError } from './TxDateField'
import { SubmitErrorBanner } from './SubmitErrorBanner'
import {
  ReceiptInput,
  receiptStateFromDocument,
  receiptStateFromExternalUrl,
  type ReceiptState,
} from '../ReceiptInput'

type Currency = 'USDT' | 'USD' | 'EUR' | 'UAH'

const EDITABLE_TYPES = ['ADMIN_INCOME', 'SENIOR_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER']

export function AdminEditTransactionDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { t, i18n } = useLingui()

  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('USDT')
  const [notes, setNotes] = useState('')
  const [receipt, setReceipt] = useState<ReceiptState>(receiptStateFromExternalUrl(null))
  // Stryker disable next-line StringLiteral: unobservable — the mount effect below sets this from `tx` before any render can read it (same shape as the `debouncedAmount` suppression a few lines down), AND the field that displays it is itself gated on `tx?.type === 'EXPENSE'`, so a `tx == null` mount never renders it either way
  const [category, setCategory] = useState('')
  const [salaryMonth, setSalaryMonth] = useState('')
  const [txDate, setTxDate] = useState('')
  // Stryker disable next-line StringLiteral: equivalent — the mount effect on [tx] calls setBackdateReason('') before any observer can read the initial value
  const [backdateReason, setBackdateReason] = useState('')
  /** The server's 409 text, verbatim — set when the plan on screen was overtaken. */
  const [staleMessage, setStaleMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!tx) return
    setAmount(parseFloat(tx.amount).toString())
    setCurrency(tx.currency as Currency)
    setNotes(tx.notes ?? '')
    if (tx.receiptDocumentId) {
      setReceipt(receiptStateFromDocument(tx.receiptDocumentId))
    } else {
      setReceipt(receiptStateFromExternalUrl(tx.receiptExternalUrl))
    }
    setCategory(tx.receiverLabel ?? '')
    setSalaryMonth(tx.salaryMonth ?? '')
    setTxDate(storedTxDate(tx))
    setBackdateReason('')
    setStaleMessage(null)
  }, [tx])

  const {
    preview,
    previewErrorMessage,
    previewAmountIsCurrent,
    previewIsRecomputing,
    shouldPreview,
    liveAmountNeedsPreview,
    cascadePanelEngaged,
    cascadeSaveBlocked,
    cascadeSaveBlockedByData,
    refetchPreview,
  } = useCascadePreviewState(tx, amount)

  // QA-H-2 — a PAID row locks its currency and its salary month. `status`, not
  // «is this a cascade edit»: the two are locked by the ledger having recorded
  // a payment, which is true whether or not the amount is being touched.
  const isPaidRow = tx?.status === 'PAID'

  // task-paid-salary-amount-edit — a PAID row whose amount has a second
  // carrier (a converted payment fact, an accumulator of payouts, an on-chain
  // deposit) is locked on OPEN, with the reason under the field, instead of
  // being refused after the operator has typed a figure. A paid SALARY is not
  // one of them any more — its obligation follows the edit at the recorded
  // rate. Same classifier the server asks (`paidRowAmountLockReason`).
  const amountLockReason = paidRowAmountLockReason(tx)

  // QA-LOW-1 — set synchronously before `mutate`: two clicks in one tick never see the disabled button.
  const submittingRef = useRef(false)
  const mutation = useMutation({
    onSettled: () => {
      submittingRef.current = false
    },
    mutationFn: () => {
      const amt = parseStrictAmount(amount)
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: pre-existing defence-in-depth guard, unchanged by this PR (i18n-3d-pr3 translated only the message text) — no test drives an invalid amount past the Save button's own disabled-state gates to reach this throw, same as the sibling suppressions elsewhere in this file.
      if (isNaN(amt) || amt <= 0) throw new Error(t`Некоректна сума`)
      const nextReceiptDocId = receipt.mode === 'file' ? receipt.documentId : null
      const nextReceiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // fix/external-receipt-rendering round 2 (security-review PR #470 MED-2):
      // the form pre-fills the tx's EXISTING receipt (see the effect above)
      // even when the user is only editing amount/notes. Resending an
      // untouched value unconditionally used to be harmless, but the write
      // schema is now https-only — an untouched legacy `http://` receipt
      // would 400 on a save the user never asked to change. Omit the receipt
      // fields entirely when nothing changed; the API treats an absent field
      // as "leave unchanged" (see `adminUpdateTransaction`'s
      // `receiptDocChanged`/`receiptUrlChanged` gates), so this never touches
      // validation for a field the user didn't look at.
      const receiptUnchanged =
        nextReceiptDocId === (tx?.receiptDocumentId ?? null) &&
        nextReceiptExternalUrl === (tx?.receiptExternalUrl ?? null)
      const changedMonth = changedSalaryMonth(tx, salaryMonth)
      return financeApi.adminUpdateTransaction(tx!.id, {
        amount: amt,
        currency,
        notes: notes || null,
        // The token of the plan the operator actually saw — and ONLY when the
        // figure being submitted is the figure that plan was built for
        // (SR-H-1). Without that second condition the token vouched for a
        // different amount than the one in the payload, and the server, which
        // cannot tell (the token carries no amount), applied the cascade for
        // the submitted figure. The gate below makes this branch unreachable
        // in the UI; keeping the condition here too means the worst case
        // degrades to the server's own 400 rather than a silent apply.
        // Stryker disable next-line LogicalOperator: defense in depth, deliberately unreachable through the UI — `cascadeSaveBlocked` disables the button whenever `previewAmountIsCurrent` is false (CP-25), so no click can reach this branch with the two disagreeing. `&&` vs `||` is therefore unobservable from the outside, and that is the POINT: if the gate above were ever removed, this keeps the worst case at the server's own 400 instead of a silent apply
        ...(preview?.version && previewAmountIsCurrent ? { cascadeVersion: preview.version } : {}),
        ...(!receiptUnchanged && {
          receiptDocumentId: nextReceiptDocId,
          receiptExternalUrl: nextReceiptExternalUrl,
        }),
        ...(tx?.type === 'EXPENSE' && { category }),
        // Only when the operator changed it (SR-M-1) — see changedSalaryMonth.
        ...(changedMonth !== undefined && { salaryMonth: changedMonth }),
        // Only a day that differs from the stored one — see changedTxDatePayload.
        ...changedTxDatePayload(tx!, txDate, backdateReason),
      })
    },
    onError: (err) => {
      // 409 is not an ordinary failure: the plan below is still on screen and
      // still readable, it is merely no longer true. Surfacing it INSIDE the
      // panel (with a re-fetch button) rather than as a generic red line keeps
      // the operator's context — they can see exactly what went out of date.
      //
      // COPY-M-2 (copy-review, MED, PR #613 round 2): `getApiErrorMessage`
      // was here before. Its own third priority is axios's `.message` —
      // which, by the time this handler runs, has already been overwritten
      // by the shared interceptor (`axios.ts`) to the GENERAL per-status
      // fallback whenever the body carries nothing usable. For 409 that
      // fallback tells the operator to reload the page — destructive here
      // (it throws away the amount just typed), and this very banner already
      // offers a non-destructive way out of the same conflict, one button
      // over: «Обновить предпросмотр». `cascadeStaleMessage`
      // (`cascade-preview.ts`) reads the response body directly instead;
      // see its own doc.
      setStaleMessage(getAxiosStatus(err) === 409 ? cascadeStaleMessage(err) : null)
    },
    onSuccess: (saved: TransactionDto) => {
      // SR-M-1 — the edit committed, but the invoice is not in step with it.
      // Not a silent success: the operator hears it.
      //
      // COPY-M-6 — and hears the RIGHT thing. «Save it again» repairs only the
      // edited salary's own invoice; on a derived row there is no repair path,
      // and following that advice would return a plain «Зміни збережено» —
      // a false confirmation. The server says which case this is.
      // COPY-L-3 — action first, and no «це записано в журнал»: there is no
      // transaction journal in the UI, so the reader cannot act on it.
      // No `?.`: the endpoint always answers with the row (`findOne`), and an
      // optional chain here was a branch no response can take.
      if (saved.invoiceReissueIncomplete === 'SELF_REPAIRABLE') {
        toast.warning(t`Рахунок не перевипущено — збережіть транзакцію ще раз`)
      } else if (saved.invoiceReissueIncomplete === 'MANUAL_CHECK') {
        toast.warning(t`Рахунок розійшовся із сумою — потрібна ручна звірка`)
      }
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['transaction', tx?.id] })
      void qc.invalidateQueries({ queryKey: ['company-account'] })
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['documents'] })
      onClose()
    },
  })

  // QA-M-1 — a failed save belongs to the row it was attempted on. This cannot
  // fold into the field-reset effect near the top: that effect runs before
  // `mutation` exists (it needs `tx`), so the same intent lives in two places.
  // Without it `mutation.error` outlived the switch and greeted the NEXT
  // transaction with a red banner about the previous one. Same family as UX-2.
  const resetMutation = mutation.reset
  useEffect(() => {
    resetMutation()
  }, [tx, resetMutation])

  // COPY-M-10 (copy-review, MED, PR #613 round 3): `cascadeSaveErrorMessage`
  // (`cascade-preview.ts`), not the project's general `getApiErrorMessage` —
  // this red line sits directly under a plan written in the cascade screen's
  // own voice (COPY-M-3), and the general resolver's fallback text disagreed
  // with it in register on exactly the statuses (403/5xx/network) where the
  // server itself said nothing. See that function's own doc for why editing
  // it here, rather than `axios-utils.ts`, keeps every OTHER screen in the
  // CRM untouched. A genuine backend explanation still wins first, verbatim,
  // either way — the two functions only ever disagree on the fallback.
  const error = mutation.error ? cascadeSaveErrorMessage(mutation.error) : null
  // A 409 is rendered by the panel, in place, not duplicated as a red line.
  const submitError = staleMessage ? null : error
  const reasonRequired = !!submitError && isReasonRequiredError(mutation.error)
  const isEditable = tx && EDITABLE_TYPES.includes(tx.type) && !tx.payoutRequestId

  return (
    <Dialog open={!!tx} onOpenChange={(o) => !o && onClose()}>
      {/* The dialog grows only when there is a plan with rows to show. Measured,
          not guessed: the five-column table needs ~750 px of content width, and
          inside the default `sm:max-w-md` (448 px) it forced a horizontal scroll
          at every breakpoint — found by measuring `scrollWidth` at 768 px, not
          by looking at it. Below `sm:` the panel is a card stack and the width
          is irrelevant. */}
      <CrmDialogContent
        maxWidth={
          preview?.plan && preview.plan.derivatives.length > 0 ? 'sm:max-w-3xl' : 'sm:max-w-md'
        }
      >
        <CrmDialogHeader>
          <DialogDescription className="sr-only">
            <Trans>Редагування транзакції</Trans>
          </DialogDescription>
          <DialogTitle className="text-base">
            <Trans>Редагувати транзакцію</Trans>
            {tx && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {i18n._(TYPE_LABEL_MESSAGES[tx.type])} · {fmtAmount(tx.amount, tx.currency)}
              </span>
            )}
          </DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          {!isEditable && tx ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <Trans>
                Транзакцію не можна редагувати (це виплата або транзакція прив’язана до заявки на
                виплату)
              </Trans>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Amount + Currency */}
              {/* QA-H-2: on a PAID row the currency is not merely refused on
                  save — it cannot be entered at all. The server has always
                  rejected it, but only AFTER the click and in English; a
                  refusal the operator can walk into is worse than a control
                  that does not open, and the neighbouring ledger-fact refusal
                  had already been given both halves. */}
              <AmountCurrencyInput
                amount={amount}
                currency={currency}
                onAmountChange={setAmount}
                onCurrencyChange={setCurrency}
                disableCurrency={isPaidRow}
                disableAmount={amountLockReason !== null}
                inputClassName="min-h-[44px] sm:min-h-0 sm:h-9"
              />
              {amountLockReason !== null && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="admin-edit-locked-amount-note"
                >
                  {cascadeBlockedReasonMessage(amountLockReason)}
                </p>
              )}
              {isPaidRow && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="admin-edit-locked-currency-note"
                >
                  {translateApiError(PAID_ROW_LOCKED_FIELD_ERROR_CODES.CURRENCY, undefined)}
                </p>
              )}

              {/* Mounted BELOW the amount field and above nothing focusable —
                  a panel appearing between the field and the buttons would move
                  focus out from under the operator mid-typing.

                  COPY-H-1 (copy-review, HIGH, PR #613 round 2): mounted on
                  `shouldPreview` alone, this stayed UNMOUNTED for the whole
                  window finding 107's gate (`liveAmountNeedsPreview`, above)
                  already disables Save for — that gate is a live rule, this
                  mount condition was a lagged one. The debounce is trailing
                  and restarts on every keystroke, so that window is not a
                  bounded ~400 ms; it lasts as long as the operator keeps
                  typing. A dark button with nothing on screen explaining it
                  reads as a frozen interface; for a screen reader it was
                  outright silence. Mounted on the SAME live rule the gate
                  uses, not a new one — whatever makes Save refuse a click
                  must also be what shows the panel that explains the
                  refusal.

                  COPY-M-7 (copy-review, MED, PR #613 round 3) introduced
                  `cascadePanelEngaged` as a THIRD disjunct alongside
                  `shouldPreview`/`liveAmountNeedsPreview`, to bridge the
                  transient dip described at that flag's own definition
                  above — WITHOUT it, the panel unmounts and remounts
                  mid-edit on the two most common paths through a first edit
                  (erase-then-retype; typing back through the original
                  digits before continuing).

                  task-mutation-gate follow-up (PR #613, backlog 121):
                  mounting on all three together turned out to mount on
                  EXACTLY the same renders `cascadePanelEngaged` alone would
                  — the latch above (`if ((shouldPreview ||
                  liveAmountNeedsPreview) && !cascadePanelEngaged) {
                  setCascadePanelEngaged(true) }`) runs, unconditionally, on
                  every render, BEFORE this return statement. React's own
                  documented "adjust state during render" behaviour (cited
                  at that latch's definition above) means that when it flips
                  `cascadePanelEngaged` to `true`, this component re-renders
                  IMMEDIATELY, before any JSX from THIS pass is ever
                  committed — so on the render that actually reaches the
                  screen, `cascadePanelEngaged` is ALREADY `true` whenever
                  `shouldPreview || liveAmountNeedsPreview` is. Verified
                  empirically too, not just argued: swapping this line's
                  three-term condition for `cascadePanelEngaged` alone left
                  every test in cascade-impact-panel.test.tsx green,
                  including CP-1/CP-31 which exercise exactly the render
                  where one of the two live flags first turns true. The two
                  live flags keep gating `enabled`/`isLoading`/
                  `cascadeSaveBlocked` below, unchanged — those must stay
                  keystroke-precise, narrowing THEM would risk narrowing
                  them for money too. Only the MOUNT condition collapses,
                  because mounting asks "has this ever been true", and the
                  latch above already answers exactly that question.

                  This depends on `setCascadePanelEngaged` staying a
                  render-time call, not a `useEffect` — moving it into an
                  effect would reopen the one-render gap this simplification
                  relies on, and the two live flags would need to come back
                  into this condition.

                  The leading `!!tx &&` is NOT redundant with
                  `cascadePanelEngaged` — it is what keeps the invariant the
                  Stryker suppression two components down relies on (`tx`
                  non-null wherever this JSX renders) true. `cascadePanelEngaged`
                  is per-`tx` state and is reset on a genuine row SWITCH, but
                  `onClose`'s own effect deliberately returns early on
                  `tx === null` (so the dialog's fields do not visibly clear
                  mid closing-animation) — without this guard a stale `true`
                  from the JUST-CLOSED row would keep the panel mounted with
                  `tx` already null. */}
              {!!tx && cascadePanelEngaged && (
                <CascadeImpactPanel
                  preview={preview}
                  // The extra disjunct covers exactly finding 107's window:
                  // `liveAmountNeedsPreview` true, `shouldPreview` still
                  // false (the debounce has not caught up), so
                  // `previewIsRecomputing` — itself gated on `shouldPreview`
                  // — has nothing to be true about yet. No new copy: this is
                  // the same "Пересчитываем связанные выплаты…" skeleton
                  // CR-M-1 already wrote for the debounce window, now shown
                  // for the window before that one too.
                  isLoading={previewIsRecomputing || (liveAmountNeedsPreview && !shouldPreview)}
                  errorMessage={previewErrorMessage}
                  onRetry={() => {
                    setStaleMessage(null)
                    // UX-2 (design fidelity): the failed-save error goes with
                    // it. Without the reset the dialog showed a FRESH plan and
                    // a red «сохранение не удалось» line from the previous
                    // attempt at the same time — the same two-contradictory-
                    // answers defect as COPY-H-1, one screen down.
                    if (mutation.isError) mutation.reset() // never mid-save
                    refetchPreview()
                  }}
                  staleMessage={staleMessage}
                  // Stryker disable next-line OptionalChaining: unreachable — this JSX only renders under the leading `!!tx &&` guard above, so `tx` is non-null wherever this expression is evaluated (CP-23 covers the closed dialog)
                />
              )}

              {tx && (
                <TxDateField
                  value={txDate}
                  stored={storedTxDate(tx)}
                  reason={backdateReason}
                  onChange={setTxDate}
                  onReasonChange={(r) => {
                    setBackdateReason(r)
                    if (mutation.isError) mutation.reset() // QA-MED-1; never mid-save (CR-M-7)
                  }}
                  invalid={reasonRequired}
                  locked={tx.isDateLocked === true}
                  errorMessage={submitError}
                />
              )}

              {/* Expense category — owner override 2026-09-28 (i18n-3d-pr3):
                  FREE TEXT, not a closed Select. `receiverLabel` on prod
                  EXPENSE rows carries 16 distinct operator-authored values
                  (imports wrote arbitrary descriptions, e.g. «RumpUp
                  service») — forcing a choice among three pills here would
                  clobber an imported row the instant its dialog opens. The
                  Input below IS the field; the chips are quick-fill
                  suggestions for a NEW category, translated for display only
                  — clicking one just fills the input, it never validates or
                  rewrites a value the operator has already typed. */}
              {tx?.type === 'EXPENSE' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    <Trans>Категорія</Trans>
                  </Label>
                  <Input
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder={t`Категорія витрати`}
                    className="min-h-[44px] sm:min-h-0 sm:h-9 text-sm"
                    data-testid="admin-edit-expense-category-input"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {EXPENSE_CATEGORIES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategory(i18n._(EXPENSE_CATEGORY_MESSAGES[c]!))}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-medium transition-all min-h-[44px] sm:min-h-0 flex items-center',
                          category === i18n._(EXPENSE_CATEGORY_MESSAGES[c]!)
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:border-border/80 hover:bg-muted/50',
                        )}
                        data-testid={`admin-edit-expense-category-suggestion-${EXPENSE_CATEGORIES.indexOf(c)}`}
                      >
                        {i18n._(EXPENSE_CATEGORY_MESSAGES[c]!)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Salary month */}
              {tx?.type === 'SALARY' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    <Trans>Місяць</Trans>
                  </Label>
                  <Input
                    value={salaryMonth}
                    onChange={(e) => setSalaryMonth(e.target.value)}
                    placeholder="2025-03"
                    className="min-h-[44px] sm:min-h-0 sm:h-9 text-sm"
                    disabled={isPaidRow}
                  />
                  {/* Its own note, under its own field: two locked controls with
                      two unrelated reasons (a currency halts every payout, a
                      salary month keys monthly aggregates). One shared banner
                      would have to say both and would be about neither. */}
                  {isPaidRow && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="admin-edit-locked-salary-month-note"
                    >
                      {translateApiError(PAID_ROW_LOCKED_FIELD_ERROR_CODES.SALARY_MONTH, undefined)}
                    </p>
                  )}
                </div>
              )}

              {/* Receipt */}
              {(tx?.type === 'ADMIN_INCOME' ||
                tx?.type === 'SENIOR_INCOME' ||
                tx?.type === 'EXPENSE') && <ReceiptInput state={receipt} onChange={setReceipt} />}

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  <Trans>Примітки</Trans>
                </Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  // Stryker disable next-line StringLiteral: cosmetic placeholder for an optional field, not asserted by any test in this file.
                  placeholder={t`Додаткова інформація…`}
                  rows={2}
                  className="text-sm resize-none"
                />
              </div>

              {/* The reason-required message lives inline under the field (COPY-LOW-1). */}
              {submitError && !reasonRequired && <SubmitErrorBanner message={submitError} />}
            </div>
          )}
        </CrmDialogBody>

        {/* WCAG 2.2 SC 1.4.13: the reason a control is unavailable has to be
            readable without hovering it. A `title` would hide it from touch
            and from a keyboard user entirely.
            
            COPY-H-1: NOT shown under the refusal banner. `isEditable` is a
            client-side type check, not `preview.editable`, so the two used to
            render together — the banner saying «виправляйте сторнувальною
            транзакцією» (i.e. never here) with a line underneath saying
            «усуньте і зберігайте». Two contradictory instructions, one line
            apart, on a money screen. The banner already names both the cause
            and the remedy; a second voice can only disagree with it.

            The text itself names the CAUSE rather than a repair: every
            blocking condition is a property of data already written (a legacy
            row with no share snapshot, an accumulator in another currency),
            and none of them is fixable in this dialog. «Ще не усунуто»
            promised work that does not exist — the same defect #610 removed
            from this module three hours earlier. «Потрібне ручне рішення» is not
            a new phrase: it is the one `NO_SHARE_SNAPSHOT` already uses in the
            red row itself. */}
        {/* The `preview?.` test comes FIRST on purpose. Ordered the other way it
            was unreachable — `canSaveCascadeEdit(undefined)` is `true` by
            design, so `cascadeSaveBlockedByData` short-circuited before any
            undefined `preview` could reach the chain, and the mutation gate
            correctly reported that `?.` could be `.` with nothing noticing.
            Leading with it makes the guard say what it means — «the server
            says this row IS editable, yet this plan cannot be saved» — and
            makes the optional chain load-bearing on the two ordinary states
            where `preview` is genuinely absent (first request in flight,
            request failed), which CP-27/CP-31 both exercise. */}
        {isEditable && preview?.editable === true && cascadeSaveBlockedByData && (
          <p
            className="px-4 pb-1 text-xs text-destructive sm:px-6"
            data-testid="cascade-save-blocked-note"
          >
            <Trans>
              Зберегти не можна — по відмічених рядках суму не перерахувати, потрібне ручне рішення
            </Trans>
          </p>
        )}

        <CrmDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            <Trans>Скасувати</Trans>
          </Button>
          {isEditable && (
            <Button
              size="sm"
              onClick={() => {
                if (submittingRef.current) return
                submittingRef.current = true
                mutation.mutate()
              }}
              disabled={mutation.isPending || cascadeSaveBlocked || !!staleMessage}
              data-testid="admin-edit-save"
            >
              {
                // Stryker disable next-line StringLiteral: submit-button copy — `AdminEditTransactionDialog.test.tsx` clicks this button by testid (`admin-edit-save`), never asserts its label text.
                mutation.isPending ? t`Збереження…` : t`Зберегти`
              }
            </Button>
          )}
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
