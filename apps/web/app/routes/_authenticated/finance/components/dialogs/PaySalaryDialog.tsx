import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import {
  MAX_TRANSACTION_AMOUNT,
  receiptMandatoryError,
  salaryPaidAmountDeviation,
} from '@crm/shared'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { api } from '@/lib/axios'
import { financeApi } from '../../api'
import { convertAmount, fmtAmount, fmtDate, type ExchangeRates } from '../../constants'
import { FundingSourceFields, COMPANY_ACCOUNT_VALUE, type Currency } from './FundingSourceFields'
import { ReceiptInput, emptyReceiptState, type ReceiptState } from '../ReceiptInput'

export function PaySalaryDialog({
  tx,
  onClose,
}: {
  tx: TransactionDto | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  // account = COMPANY_ACCOUNT_VALUE (Счёт компании, default) OR an ADMIN partner id.
  const [account, setAccount] = useState<string>(COMPANY_ACCOUNT_VALUE)
  const [currency, setCurrency] = useState<Currency>('USDT')
  // task-salary-pay-amount: the amount ACTUALLY paid, in `currency`. Prefilled
  // from the rate-derived expectation and editable — see the sync effect below.
  const [amountInput, setAmountInput] = useState('')
  // Once the ADMIN types their own figure we stop overwriting it when the
  // currency changes or the rates finish loading: their number is the fact,
  // ours is only a suggestion.
  const [amountTouched, setAmountTouched] = useState(false)
  const [amountSubmitError, setAmountSubmitError] = useState<string | null>(null)
  // task-receipts-frontend: replaces the old optional "TX Hash" text input
  // (design-spec §2.3) — proof of payment is now the mandatory ReceiptInput,
  // explorer-only when the effective currency is USDT.
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  const isCompany = account === COMPANY_ACCOUNT_VALUE
  // «Счёт компании» is a USDT-only account — the backend re-forces this, so
  // every conversion below must reason about what will ACTUALLY be paid.
  const effectiveCurrency: Currency = isCompany ? 'USDT' : currency

  // Same query key `AmountCurrencyInput` uses internally (calendar-day scoped,
  // so a tab left open past midnight refetches): an identical key means ONE
  // cache entry and ONE request shared with the input rendered below, not a
  // second fetch of the same rates.
  const todayKey = new Date().toISOString().slice(0, 10)
  const { data: rates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', todayKey],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60 * 24,
    enabled: !!tx,
  })

  // The obligation, re-expressed in the currency being paid. `null` while the
  // rates are loading (or if they are unusable) — the field then stays empty
  // instead of showing a confidently wrong number.
  const expectedAmount = useMemo(() => {
    if (!tx) return null
    return convertAmount(tx.amount, tx.currency, effectiveCurrency, rates)
  }, [tx, effectiveCurrency, rates])

  // Prefill / re-prefill with the rate-derived expectation until the ADMIN
  // edits the field themselves.
  useEffect(() => {
    if (amountTouched) return
    if (expectedAmount === null) return
    setAmountInput(expectedAmount.toFixed(2))
  }, [expectedAmount, amountTouched])

  const parsedPaidAmount = parseFloat(amountInput)
  const hasAmountInput = amountInput.trim() !== ''
  // Live validity of what is typed. Mirrors `paySalarySchema.paidAmount` on the
  // server (positive, ≤ BIZ-13 ceiling) via the SAME constant, so the two
  // cannot drift. Silent while the field is empty — an error before the first
  // keystroke is noise, and `handleSubmit` covers the empty case.
  const liveAmountError = !hasAmountInput
    ? null
    : !Number.isFinite(parsedPaidAmount)
      ? 'Введите сумму числом'
      : parsedPaidAmount <= 0
        ? 'Сумма должна быть больше нуля'
        : parsedPaidAmount > MAX_TRANSACTION_AMOUNT
          ? `Сумма не может превышать ${MAX_TRANSACTION_AMOUNT.toLocaleString('ru-RU')}`
          : null
  const amountError = liveAmountError ?? amountSubmitError

  // task-salary-pay-amount (AC5): a WARNING, never a block. The owner may settle
  // at their own bank's rate, and the payment closes the obligation in full
  // either way — which is exactly why «300» typed instead of «30 000» would
  // otherwise close it silently.
  const deviation =
    !liveAmountError && hasAmountInput && expectedAmount !== null
      ? salaryPaidAmountDeviation(parsedPaidAmount, expectedAmount)
      : null

  function resetState() {
    setAccount(COMPANY_ACCOUNT_VALUE)
    setCurrency('USDT')
    setAmountInput('')
    setAmountTouched(false)
    setAmountSubmitError(null)
    setReceipt(emptyReceiptState())
    setReceiptError(null)
    setNotes('')
  }

  const mutation = useMutation({
    mutationFn: () => {
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
      // task-salary-pay-flow: the funding source + currency are chosen HERE.
      //   - «Счёт компании» → COMPANY_ACCOUNT, currency forced USDT (the account
      //     is USDT-only; the backend re-forces it and gates the balance).
      //   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner, the
      //     chosen currency (any) is used.
      // task-salary-pay-amount: `paidAmount` is the figure that lands on the row
      // (the FACT of the payment); the backend snapshots the obligation it
      // settles into originalAmount / originalCurrency / exchangeRate.
      return financeApi.paySalary(tx!.id, {
        fundingSource: isCompany ? 'COMPANY_ACCOUNT' : 'ADMIN_PERSONAL',
        ...(isCompany ? {} : { payerAdminId: account }),
        currency: effectiveCurrency,
        paidAmount: parsedPaidAmount,
        receiptDocumentId,
        receiptExternalUrl,
        notes: notes || null,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      // A company-funded payout debits the company account → refresh its balance.
      if (isCompany) void qc.invalidateQueries({ queryKey: ['company-account'] })
      onClose()
      resetState()
    },
  })

  function handleClose() {
    onClose()
    resetState()
  }

  // Select the account: when switching to «Счёт компании» the currency is locked
  // to USDT; switching to a partner restores an editable currency.
  function selectAccount(value: string) {
    setAccount(value)
    if (value === COMPANY_ACCOUNT_VALUE) setCurrency('USDT')
  }

  // task-receipts-frontend: client-side gate (mirrors CreateTransactionDialog) —
  // blocks mutation.mutate() when the receipt is missing/invalid, delegating
  // the rule to the SAME shared function the backend refine uses.
  function handleSubmit() {
    const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
    const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
    // Both gates are evaluated INDEPENDENTLY and both errors surface at once —
    // no early return between them. Ordering them would mean the receipt error
    // could only appear once the amount happened to be valid, making one
    // required field's feedback depend on another's timing (the amount is
    // prefilled asynchronously). The user sees everything that is wrong.
    //
    // task-salary-pay-amount: the deviation WARNING is deliberately NOT
    // consulted here — it must never block a payment.
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId, receiptExternalUrl },
      effectiveCurrency,
    )
    if (receiptErr) setReceiptError(receiptErr)
    if (!hasAmountInput) setAmountSubmitError('Укажите сумму выплаты')
    if (receiptErr || !hasAmountInput || liveAmountError) return
    mutation.mutate()
  }

  const error = mutation.error instanceof Error ? mutation.error.message : null

  if (!tx) return null

  // Whether a conversion is actually in play — drives the «расчёт по курсу» row
  // (AC1: the amount due in the chosen currency; the rate itself is rendered by
  // AmountCurrencyInput's own hint below). Compared on the FIGURE, not on the
  // currency code: paying a USD obligation in USDT is a 1:1 relabel, and a row
  // announcing «500 USD = 500 USDT» is noise, not information.
  const isConverted =
    expectedAmount !== null && Math.abs(expectedAmount - parseFloat(tx.amount)) > 0.005

  return (
    <Dialog
      open={!!tx}
      onOpenChange={(v) => {
        if (!v) handleClose()
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="pay-salary-dialog">
        <CrmDialogHeader>
          <DialogTitle>Выплатить зарплату</DialogTitle>
          <DialogDescription className="sr-only">Выплата зарплаты</DialogDescription>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 pb-4">
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-sm">
            {tx.receiverName && (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground shrink-0">Получатель</span>
                <span className="font-medium text-right break-words">{tx.receiverName}</span>
              </div>
            )}
            {/* task-salary-pay-amount: this row is the OBLIGATION — what is owed,
                in the currency it was created in. It stays visible next to the
                editable payment amount below so the two are never confused, and
                it is what the backend preserves in original_amount /
                original_currency once the payment lands. */}
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground shrink-0">К выплате</span>
              <span
                className="font-medium tabular-nums text-right"
                data-testid="pay-salary-obligation"
              >
                {fmtAmount(tx.amount, tx.currency)}
              </span>
            </div>
            {tx.salaryMonth && (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground shrink-0">Месяц</span>
                <span className="font-medium text-right">{tx.salaryMonth}</span>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground shrink-0">Дата</span>
              <span className="font-medium text-right">{fmtDate(tx.createdAt)}</span>
            </div>
          </div>

          {/* task-senior-settle-owner: account selection is the shared
          FundingSourceFields (same UI as SettleSeniorPayoutDialog). The parent
          owns the funding semantics (COMPANY_ACCOUNT → USDT forced;
          ADMIN_PERSONAL → payerAdminId = the selected partner).
          task-salary-pay-amount: `hideCurrency` — the currency picker now lives
          in the AmountCurrencyInput below, so the amount and the currency it is
          denominated in sit together and share ONE conversion hint instead of
          being two unrelated controls. */}
          <FundingSourceFields
            account={account}
            onSelectAccount={selectAccount}
            enabled={!!tx}
            testIdPrefix="pay-salary"
            hideCurrency
          />

          {/* task-salary-pay-amount (AC1 + AC2). The SHARED money input — it owns
              the numeric parsing (including the decimal-separator handling being
              fixed for every money field at once in PR #481), the currency
              picker and the «≈ $X USD · 1 USD = NN UAH» conversion hint. No
              second amount input and no second parser: whatever that component
              accepts, this field accepts.
              The wrapper testid targets the inner <input> without depending on
              its `type` (which PR #481 flips number→text). */}
          <div data-testid="pay-salary-amount-field">
            <AmountCurrencyInput
              amount={amountInput}
              currency={effectiveCurrency}
              onAmountChange={(v) => {
                setAmountTouched(true)
                setAmountSubmitError(null)
                setAmountInput(v)
              }}
              onCurrencyChange={setCurrency}
              label="Сумма выплаты"
              disableCurrency={isCompany}
              error={amountError ?? undefined}
              errorTestId="pay-salary-amount-error"
            />
          </div>

          {/* AC1: the amount due in the chosen currency, spelled out, with a way
              back to it after a manual edit. Only meaningful when a conversion
              actually happened. */}
          {isConverted && expectedAmount !== null && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
              <span className="text-muted-foreground shrink-0">Расчёт по курсу НБУ</span>
              <div className="flex items-center gap-2">
                <span
                  className="font-medium tabular-nums text-right"
                  data-testid="pay-salary-expected-amount"
                >
                  {fmtAmount(expectedAmount.toFixed(2), effectiveCurrency)}
                </span>
                {amountTouched && amountInput !== expectedAmount.toFixed(2) && (
                  <button
                    type="button"
                    className="shrink-0 text-primary underline-offset-2 hover:underline"
                    onClick={() => {
                      setAmountTouched(false)
                      setAmountSubmitError(null)
                      setAmountInput(expectedAmount.toFixed(2))
                    }}
                    data-testid="pay-salary-reset-amount"
                  >
                    подставить
                  </button>
                )}
              </div>
            </div>
          )}

          {/* AC5: warns, never blocks — «Отметить как оплачено» stays enabled. */}
          {deviation !== null && expectedAmount !== null && (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400"
              data-testid="pay-salary-amount-warning"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>
                Сумма отличается от расчёта по курсу на {Math.round(deviation * 100)}% (
                {fmtAmount(expectedAmount.toFixed(2), effectiveCurrency)}). Проверьте, всё ли верно
                — зарплата будет закрыта полностью на введённую сумму.
              </span>
            </div>
          )}

          {/* task-receipts-frontend: mandatory proof of payment (design-spec §3.2),
              replaces the old optional TX Hash text field. Explorer-only when
              the effective currency is USDT (COMPANY_ACCOUNT always forces it;
              ADMIN_PERSONAL defaults to USDT until the currency is switched). */}
          <div className="space-y-1.5">
            <ReceiptInput
              state={receipt}
              onChange={(s) => {
                setReceipt(s)
                setReceiptError(null)
              }}
              label="Чек / подтверждение *"
              explorerOnly={effectiveCurrency === 'USDT'}
              error={receiptError ?? undefined}
            />
            {receiptError && (
              <p className="text-[11px] text-destructive" data-testid="pay-salary-error-receipt">
                {receiptError}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Заметки</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Дополнительная информация..."
              rows={2}
              className="text-sm resize-none"
              data-testid="pay-salary-notes"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive" data-testid="pay-salary-error">
              {error}
            </p>
          )}
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="pay-salary-cancel">
            Отмена
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            data-testid="pay-salary-submit"
          >
            {mutation.isPending ? 'Оплата...' : 'Отметить как оплачено'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
