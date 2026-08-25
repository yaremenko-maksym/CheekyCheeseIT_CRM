import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { amountsDiffer, type TransactionDto } from '@crm/shared'
import { cn, parseStrictAmount } from '@/lib/utils'
import { getApiErrorMessage, getAxiosStatus } from '@/lib/axios-utils'
import { PAID_ROW_LOCKED_FIELD_MESSAGES } from '@crm/shared'
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
  canSaveCascadeEdit,
  cascadePreviewErrorMessage,
  cascadeStaleMessage,
  needsCascadePreview,
} from '../../cascade-preview'
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
  // `needsCascadePreview` (cascade-preview.ts) is the SAME six-decimal
  // comparison the server uses to decide whether an edit is a cascade edit at
  // all. A local copy would agree until the first rounding boundary and then
  // ask for a preview the server would not honour.
  const shouldPreview = needsCascadePreview(tx, parsedPreviewAmount)

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

  // UX-6 (design fidelity, HIGH) — THREE states, named, because conflating two
  // of them left a live Save button over an empty panel.
  //
  //   not asked   — `!shouldPreview`: an ordinary edit, no cascade, no panel
  //   in flight   — `previewIsRecomputing` below: skeleton, Save held
  //   FAILED      — here: banner + retry, Save held
  //
  // The old code only knew «network error» (`status === undefined`). A bare 500
  // with no body — what a dev proxy returns when the API is down, found by
  // stopping the process — has a status, so it fell through every branch: no
  // banner, and `canSaveCascadeEdit(undefined) === true` kept Save live. A
  // failed preview was literally indistinguishable from one never requested.
  const previewFailed = shouldPreview && previewQuery.isError

  // QA-H-2 — a PAID row locks its currency and its salary month. `status`, not
  // «is this a cascade edit»: the two are locked by the ledger having recorded
  // a payment, which is true whether or not the amount is being touched.
  const isPaidRow = tx?.status === 'PAID'

  // The TEXT still distinguishes the two kinds, which is what CP-19 protects:
  // sending someone to check their wifi over a message the server took the
  // trouble to write is its own defect. A request that never got an answer
  // keeps the panel's own short line.
  //
  // COPY-M-3 (copy-review, MED, PR #613 round 2): anything the server
  // actually answered used to be rendered by `getUserFacingErrorMessage` —
  // the project's GENERAL resolver (backend message → Russian text per
  // status → generic). Reusing it looked right — a genuine backend
  // explanation still comes through it verbatim, and it never surfaces
  // axios's raw English `.message` — but its status-derived FALLBACK is a
  // different register: full sentences with a closing period, sometimes two,
  // first person plural ("Мы уже знаем о проблеме"), landing in the exact
  // banner slot that otherwise carries this screen's own one-clause,
  // no-period, impersonal lines. `cascadePreviewErrorMessage`
  // (`cascade-preview.ts`) keeps the same priority — a real backend message
  // still wins first, verbatim — and gives only the fallback tail this
  // screen's own voice; see its own doc.
  const previewErrorMessage = !previewFailed
    ? null
    : getAxiosStatus(previewQuery.error) === undefined
      ? 'Не удалось загрузить предпросмотр — проверьте соединение'
      : cascadePreviewErrorMessage(previewQuery.error)

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
  //
  // SR-L-1 (security-review, for the record): none of this makes «the operator
  // saw a preview» a PROVABLE property. `computeCascadeVersion` concatenates
  // ids and `updatedAt`s that are already visible in ordinary API responses —
  // it is not a MAC — so a scripted ADMIN caller can assemble a token without
  // ever opening the panel. Acceptable under the current threat model (the
  // endpoint is ADMIN-only, and such a caller can request a real preview
  // anyway); written down so the guarantee is not over-read.
  const previewAmountIsCurrent =
    shouldPreview && !amountsDiffer(parsedPreviewAmount, parseStrictAmount(amount))

  // Backlog finding 107. `shouldPreview` above is built off the DEBOUNCED
  // figure, deliberately — the same lag that keeps five keystrokes from
  // firing five previews (CP-17). But the debounce (the effect above) is a
  // TRAILING one, restarted on every change to `amount` — so it is NOT a
  // bounded ~400 ms lag after the first edit (an earlier round of this fix
  // said so, and PR #613 round 2 corrected it): while the operator keeps
  // typing, `debouncedAmount` never catches up at all, and `shouldPreview`
  // stays false for the whole burst. Right after the FIRST keystroke
  // `debouncedAmount` still equals `tx.amount`, so `shouldPreview` read
  // false, no plan was ever asked for, and Save stayed enabled. A click
  // inside that window sent the new amount with no version token; the
  // server refused it pointing at a preview panel that was not even mounted
  // to open. `needsCascadePreview` run against the LIVE amount — the SAME
  // rule `shouldPreview` uses, just not lagged — answers "does the figure on
  // screen right now need a plan", independent of whether the debounce has
  // caught up to ask for one yet.
  const liveAmountNeedsPreview = needsCascadePreview(tx, parseStrictAmount(amount))

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
        // Stryker disable next-line LogicalOperator: defense in depth, deliberately unreachable through the UI — `cascadeSaveBlocked` disables the button whenever `previewAmountIsCurrent` is false (CP-25), so no click can reach this branch with the two disagreeing. `&&` vs `||` is therefore unobservable from the outside, and that is the POINT: if the gate above were ever removed, this keeps the worst case at the server's own 400 instead of a silent apply
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      void qc.invalidateQueries({ queryKey: ['transaction', tx?.id] })
      onClose()
    },
  })

  // QA-M-1 — a failed save belongs to the row it was attempted on. This cannot
  // fold into the field-reset effect near the top: that effect runs before
  // `mutation` exists (it needs `tx`), so the same intent lives in two places.
  // Without it `mutation.error` outlived the switch and greeted the NEXT
  // transaction with a red banner about the previous one, before the operator
  // touched anything. Same family as UX-2, which cleared the leftover when the
  // preview was refreshed but not when the dialog changed subject.
  const resetMutation = mutation.reset
  useEffect(() => {
    resetMutation()
  }, [tx, resetMutation])

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
  // COPY-H-2 (copy-review, HIGH): the button and the note answer DIFFERENT
  // questions, and this line used to conflate them.
  //
  //   «may I press Save right now?»  — no, an answer is still in flight
  //   «why can this row never be saved?» — a property of data already written
  //
  // Only the second is something the operator can act on, and only the second
  // is what the note's text describes. Widening `cascadeSaveBlocked` to cover
  // the recompute window (correct for the BUTTON — that is CR-M-1/SR-H-1) also
  // dragged the note into two ordinary happy-path states: the first request in
  // flight (`preview === undefined`, and `undefined !== false` satisfied the
  // note's own guard) and the debounce window after every keystroke. In both
  // the screen said «Пересчитываем связанные выплаты…» above and «по отмеченным
  // строкам сумму не пересчитать, нужно ручное решение» below — simultaneously,
  // about the same moment, with nothing marked and nothing to decide.
  //
  // No extra «Сохранить можно после пересчёта» line is added in its place. The
  // reason is already on screen and already announced: `previewIsRecomputing`
  // implies `shouldPreview`, so the panel is mounted with `isLoading` set and
  // its `aria-live` status reads the recompute out loud. A second sentence at
  // the bottom would rebuild, in miniature, the very «two texts for one state»
  // that COPY-H-1 removed. (WCAG 1.4.13 is Content on Hover or Focus and says
  // nothing about disabled controls; no success criterion demands a visible
  // reason next to one.)
  //
  // COPY-H-1 (copy-review, HIGH), one round later: this premise held for
  // `previewIsRecomputing` but NOT for the term below,
  // `(liveAmountNeedsPreview && !previewAmountIsCurrent)` — finding 107's own
  // term, which widens the BUTTON's gate but, until this round, widened
  // nothing about the PANEL. In that term's own window `shouldPreview` is
  // false by construction (that is its entire point), so the panel — mounted
  // on `shouldPreview` alone — was not on screen at all: no skeleton, no
  // `aria-live`, nothing to read. Fixed at the panel's mount condition and
  // `isLoading` prop below (same live rule, `liveAmountNeedsPreview`, not a
  // new one), not by moving this comment — with that fix in place, mounting
  // the panel now tracks every disjunct of `cascadeSaveBlocked` below,
  // including this one, so the premise above is finally true for the whole
  // gate, not just its first two thirds.
  const cascadeSaveBlockedByData = !canSaveCascadeEdit(preview)
  // Finding 107's own term is intentionally NOT folded into
  // `cascadeSaveBlockedByData` — that flag also gates
  // `cascade-save-blocked-note` (below), and this window has nothing to name
  // yet: no plan was ever requested, so there is no reason to print. Held out
  // of the note's guard the same way `previewIsRecomputing` already is
  // (COPY-H-2) — it only widens the BUTTON's gate.
  const cascadeSaveBlocked =
    cascadeSaveBlockedByData ||
    previewIsRecomputing ||
    previewFailed ||
    (liveAmountNeedsPreview && !previewAmountIsCurrent)
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
              />
              {isPaidRow && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="admin-edit-locked-currency-note"
                >
                  {PAID_ROW_LOCKED_FIELD_MESSAGES.CURRENCY}
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
                  refusal. */}
              {(shouldPreview || liveAmountNeedsPreview) && (
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
                    mutation.reset()
                    void previewQuery.refetch()
                  }}
                  staleMessage={staleMessage}
                  // Stryker disable next-line OptionalChaining: unreachable — this JSX only renders under `shouldPreview || liveAmountNeedsPreview`, both of which are `!!tx && …`, so `tx` is non-null wherever this expression is evaluated (CP-23 covers the closed dialog)
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
                      {PAID_ROW_LOCKED_FIELD_MESSAGES.SALARY_MONTH}
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
