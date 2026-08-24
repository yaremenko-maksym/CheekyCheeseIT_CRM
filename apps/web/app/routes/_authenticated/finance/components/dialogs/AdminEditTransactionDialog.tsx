import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { amountsDiffer, type TransactionDto } from '@crm/shared'
import { cn, parseStrictAmount } from '@/lib/utils'
import { getApiErrorMessage, getAxiosStatus } from '@/lib/axios-utils'
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
import { canSaveCascadeEdit } from '../../cascade-preview'
import { EXPENSE_CATEGORIES, TYPE_LABELS, fmtAmount } from '../../constants'
import { CascadeImpactPanel } from './CascadeImpactPanel'
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

  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('USDT')
  const [notes, setNotes] = useState('')
  const [receipt, setReceipt] = useState<ReceiptState>(receiptStateFromExternalUrl(null))
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]!)
  const [salaryMonth, setSalaryMonth] = useState('')
  // Stryker disable next-line StringLiteral: unobservable — the mount effect below sets this from `tx` before any render can read it, the same shape as the documented `useState` default in SettleSeniorPayoutDialog
  const [debouncedAmount, setDebouncedAmount] = useState('')
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
    setCategory(tx.receiverLabel ?? EXPENSE_CATEGORIES[0]!)
    setSalaryMonth(tx.salaryMonth ?? '')
    setDebouncedAmount(parseFloat(tx.amount).toString())
    setStaleMessage(null)
  }, [tx])

  // task-cascade-preview-ui (task 5). Editing the amount of a PAID row drags
  // shares and obligations with it, and the server refuses such an edit unless
  // the operator has seen the plan and sends its version back. Everything below
  // is what makes that possible from the interface.
  //
  // 400 ms rather than per-keystroke: «10000» is five requests otherwise, four
  // of them describing a cascade for a number nobody meant («1», «10», …).
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAmount(amount), 400)
    return () => clearTimeout(timer)
  }, [amount])

  const parsedPreviewAmount = parseStrictAmount(debouncedAmount)
  // `amountsDiffer` is imported from @crm/shared, not re-written: it is the
  // SAME six-decimal comparison the server uses to decide whether an edit is a
  // cascade edit at all. A local copy would agree until the first rounding
  // boundary and then ask for a preview the server would not honour.
  const shouldPreview =
    !!tx &&
    tx.status === 'PAID' &&
    Number.isFinite(parsedPreviewAmount) &&
    parsedPreviewAmount > 0 &&
    amountsDiffer(parsedPreviewAmount, Number(tx.amount))

  const previewQuery = useQuery({
    // Stryker disable next-line StringLiteral: the literal is a NAMESPACE, not a value — replacing it with '' keeps the key just as unique (id + amount still discriminate every entry), so no cache behaviour changes. What the key must actually do — give a different amount a different entry — is pinned by CP-18
    queryKey: ['cascade-preview', tx?.id, parsedPreviewAmount],
    queryFn: () => financeApi.getEditCascadePreview(tx!.id, parsedPreviewAmount),
    enabled: shouldPreview,
    // A refusal (`editable: false`) is a 200 with a reason, so retries have
    // nothing to do with it. What they DO affect is a real connection failure:
    // without this the panel would sit in «пересчитываем…» for seconds while
    // three doomed attempts run, dressing a network error up as work.
    retry: false,
  })

  const preview = shouldPreview ? previewQuery.data : undefined
  // A 4xx carries a body the operator needs to read; only a request that never
  // got an answer at all is the «проверьте соединение» case.
  const isPreviewNetworkError =
    shouldPreview && previewQuery.isError && getAxiosStatus(previewQuery.error) === undefined

  // SR-H-1 (security-review, HIGH). Is the plan on screen the plan for the
  // figure currently in the field?
  //
  // The version token is `id` + `updatedAt` of the source and its derivatives
  // — it does NOT encode the amount. So a token proves «the world has not
  // moved», never «this is the plan you were shown». The server, holding a
  // valid token, recomputes the cascade for whatever amount arrived and
  // applies it. Between the 400 ms debounce and the live `amount` there was a
  // window where those two were different figures, and a save inside it
  // rewrote shares, reopened obligations and voided an invoice for a number
  // the operator had never seen a plan for. Measured, not argued: the probe
  // submitted 90 000 carrying the token of the 25 000 plan (CP-24).
  //
  // `amountsDiffer` — the same six-decimal comparison the server uses — so
  // this cannot disagree with it at a rounding boundary.
  const previewAmountIsCurrent =
    shouldPreview && !amountsDiffer(parsedPreviewAmount, parseStrictAmount(amount))

  // CR-M-1 (code-review, MED) — the same window, its visible half. `isFetching`
  // only rises once a request is actually in flight, so during the debounce the
  // panel showed the PREVIOUS plan with nothing marking it stale — exactly the
  // moment a click looks safest. The recompute indicator now covers the whole
  // window, not just the request.
  const previewIsRecomputing = shouldPreview && (previewQuery.isFetching || !previewAmountIsCurrent)

  const mutation = useMutation({
    mutationFn: () => {
      const amt = parseStrictAmount(amount)
      if (isNaN(amt) || amt <= 0) throw new Error('Некорректная сумма')
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
        ...(preview?.version && previewAmountIsCurrent ? { cascadeVersion: preview.version } : {}),
        ...(!receiptUnchanged && {
          receiptDocumentId: nextReceiptDocId,
          receiptExternalUrl: nextReceiptExternalUrl,
        }),
        ...(tx?.type === 'EXPENSE' && { category }),
        ...(tx?.type === 'SALARY' && salaryMonth && { salaryMonth }),
      })
    },
    onError: (err) => {
      // 409 is not an ordinary failure: the plan below is still on screen and
      // still readable, it is merely no longer true. Surfacing it INSIDE the
      // panel (with a re-fetch button) rather than as a generic red line keeps
      // the operator's context — they can see exactly what went out of date.
      setStaleMessage(getAxiosStatus(err) === 409 ? getApiErrorMessage(err) : null)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['transaction', tx?.id] })
      onClose()
    },
  })

  // `getApiErrorMessage` rather than a local `instanceof Error` check: the
  // latter renders nothing at all for a non-Error rejection, and this is the
  // only place the server's explanation of a refused money edit is shown.
  // (The axios interceptor already humanises `.message`, so for a normal axios
  // failure the two agree — this is about the cases where they do not.)
  const error = mutation.error ? getApiErrorMessage(mutation.error) : null
  // A 409 is rendered by the panel, in place, not duplicated as a red line.
  const submitError = staleMessage ? null : error
  // `canSaveCascadeEdit(undefined)` is `true` on purpose — an ordinary,
  // non-cascade edit must never be blocked by this feature. That is why the
  // in-flight case needs its own clause: on a cascade edit with no answer yet,
  // a click used to send the amount with no token at all and earn a guaranteed
  // 400 (fail-closed, but it reads as a broken screen).
  const cascadeSaveBlocked = !canSaveCascadeEdit(preview) || previewIsRecomputing
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
          <DialogDescription className="sr-only">Редактирование транзакции</DialogDescription>
          <DialogTitle className="text-base">
            Редактировать транзакцию
            {tx && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {TYPE_LABELS[tx.type]} · {fmtAmount(tx.amount, tx.currency)}
              </span>
            )}
          </DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="pb-4">
          {!isEditable && tx ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Транзакцию нельзя редактировать (PAYOUT или привязана к запросу выплаты)
            </div>
          ) : (
            <div className="space-y-4">
              {/* Amount + Currency */}
              <AmountCurrencyInput
                amount={amount}
                currency={currency}
                onAmountChange={setAmount}
                onCurrencyChange={setCurrency}
              />

              {/* Mounted BELOW the amount field and above nothing focusable —
                  a panel appearing between the field and the buttons would move
                  focus out from under the operator mid-typing. */}
              {shouldPreview && (
                <CascadeImpactPanel
                  preview={preview}
                  isLoading={previewIsRecomputing}
                  isNetworkError={isPreviewNetworkError}
                  onRetry={() => {
                    setStaleMessage(null)
                    // UX-2 (design fidelity): the failed-save error goes with
                    // it. Without the reset the dialog showed a FRESH plan and
                    // a red «сохранение не удалось» line from the previous
                    // attempt at the same time — the same two-contradictory-
                    // answers defect as COPY-H-1, one screen down.
                    mutation.reset()
                    void previewQuery.refetch()
                  }}
                  staleMessage={staleMessage}
                  // Stryker disable next-line OptionalChaining: unreachable — this JSX only renders under `shouldPreview`, which is itself `!!tx && …`, so `tx` is non-null wherever this expression is evaluated (CP-23 covers the closed dialog)
                  sourceReceiverName={tx?.receiverName ?? null}
                />
              )}

              {/* Expense category */}
              {tx?.type === 'EXPENSE' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Категория</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {EXPENSE_CATEGORIES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategory(c)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-medium transition-all',
                          category === c
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:border-border/80 hover:bg-muted/50',
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Salary month */}
              {tx?.type === 'SALARY' && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Месяц</Label>
                  <Input
                    value={salaryMonth}
                    onChange={(e) => setSalaryMonth(e.target.value)}
                    placeholder="2025-03"
                    className="h-9 text-sm"
                  />
                </div>
              )}

              {/* Receipt */}
              {(tx?.type === 'ADMIN_INCOME' ||
                tx?.type === 'SENIOR_INCOME' ||
                tx?.type === 'EXPENSE') && <ReceiptInput state={receipt} onChange={setReceipt} />}

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Заметки</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Дополнительная информация..."
                  rows={2}
                  className="text-sm resize-none"
                />
              </div>

              {submitError && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {submitError}
                </div>
              )}
            </div>
          )}
        </CrmDialogBody>

        {/* WCAG 2.2 SC 1.4.13: the reason a control is unavailable has to be
            readable without hovering it. A `title` would hide it from touch
            and from a keyboard user entirely.
            
            COPY-H-1: NOT shown under the refusal banner. `isEditable` is a
            client-side type check, not `preview.editable`, so the two used to
            render together — the banner saying «правьте сторнирующей
            транзакцией» (i.e. never here) with a line underneath saying
            «устраните и сохраняйте». Two contradictory instructions, one line
            apart, on a money screen. The banner already names both the cause
            and the remedy; a second voice can only disagree with it.
            
            The text itself names the CAUSE rather than a repair: every
            blocking condition is a property of data already written (a legacy
            row with no share snapshot, an accumulator in another currency),
            and none of them is fixable in this dialog. «Пока не устранены»
            promised work that does not exist — the same defect #610 removed
            from this module three hours earlier. «Нужно ручное решение» is not
            a new phrase: it is the one `NO_SHARE_SNAPSHOT` already uses in the
            red row itself. */}
        {isEditable && cascadeSaveBlocked && preview?.editable !== false && (
          <p
            className="px-4 pb-1 text-xs text-destructive sm:px-6"
            data-testid="cascade-save-blocked-note"
          >
            Сохранить нельзя — по отмеченным строкам сумму не пересчитать, нужно ручное решение
          </p>
        )}

        <CrmDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Отмена
          </Button>
          {isEditable && (
            <Button
              size="sm"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || cascadeSaveBlocked || !!staleMessage}
              data-testid="admin-edit-save"
            >
              {mutation.isPending ? 'Сохранение...' : 'Сохранить'}
            </Button>
          )}
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
