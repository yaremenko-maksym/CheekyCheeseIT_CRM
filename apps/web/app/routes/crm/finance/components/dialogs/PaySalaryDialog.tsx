import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'
import { api } from '@/lib/axios'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { financeApi, companyAccountApi } from '../../api'
import { fmtAmount, fmtDate } from '../../constants'

type Currency = 'USDT' | 'USD' | 'EUR' | 'UAH'
type UserOption = { id: string; displayName: string; role: string }

// UI-level account selection. 'COMPANY' = pay from the shared company USDT
// account (COMPANY_ACCOUNT). Any other value is an ADMIN partner's id → the
// payment is ADMIN_PERSONAL funded by that partner's personal account.
const COMPANY_ACCOUNT_VALUE = 'COMPANY' as const

const CURRENCIES: Currency[] = ['USDT', 'USD', 'EUR', 'UAH']

function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

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
  const [txHash, setTxHash] = useState('')
  const [notes, setNotes] = useState('')

  const isCompany = account === COMPANY_ACCOUNT_VALUE

  // Admin partners (Maksym / Kostya) for the ADMIN_PERSONAL options. Same source
  // as CreateTransactionDialog — /users filtered by role === ADMIN.
  const { data: allUsers = [] } = useQuery<UserOption[]>({
    queryKey: ['users-all'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: !!tx,
  })
  const adminUsers = useMemo(() => allUsers.filter((u) => u.role === 'ADMIN'), [allUsers])

  // Company account balance — shown as a hint when «Счёт компании» is selected.
  const { data: companyAccount } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
    enabled: !!tx,
  })
  const companyBalance = companyAccount?.balance ?? 0

  function resetState() {
    setAccount(COMPANY_ACCOUNT_VALUE)
    setCurrency('USDT')
    setTxHash('')
    setNotes('')
  }

  const mutation = useMutation({
    mutationFn: () =>
      // task-salary-pay-flow: the funding source + currency are chosen HERE.
      //   - «Счёт компании» → COMPANY_ACCOUNT, currency forced USDT (the account
      //     is USDT-only; the backend re-forces it and gates the balance).
      //   - an ADMIN partner → ADMIN_PERSONAL, payerAdminId = that partner, the
      //     chosen currency (any) is used.
      financeApi.paySalary(tx!.id, {
        fundingSource: isCompany ? 'COMPANY_ACCOUNT' : 'ADMIN_PERSONAL',
        ...(isCompany ? {} : { payerAdminId: account }),
        currency: isCompany ? 'USDT' : currency,
        txHash: txHash || null,
        notes: notes || null,
      }),
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

  const error = mutation.error instanceof Error ? mutation.error.message : null

  if (!tx) return null

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
              <div className="flex justify-between">
                <span className="text-muted-foreground">Получатель</span>
                <span className="font-medium">{tx.receiverName}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сумма</span>
              <span className="font-medium tabular-nums">{fmtAmount(tx.amount, tx.currency)}</span>
            </div>
            {tx.salaryMonth && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Месяц</span>
                <span className="font-medium">{tx.salaryMonth}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Дата</span>
              <span className="font-medium">{fmtDate(tx.createdAt)}</span>
            </div>
          </div>

          {/* Account selector — С какого счёта оплачено */}
          <div className="space-y-2" data-testid="pay-salary-account-section">
            <Label className="text-xs text-muted-foreground">С какого счёта оплачено</Label>
            <div className="grid grid-cols-1 gap-1.5">
              {/* Company account — default */}
              <button
                type="button"
                onClick={() => selectAccount(COMPANY_ACCOUNT_VALUE)}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
                  isCompany
                    ? 'border-primary bg-primary/8 text-foreground'
                    : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
                )}
                data-testid="pay-salary-account-company"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium leading-tight">Счёт компании</div>
                  <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                    Спишется со счёта компании (USDT)
                  </div>
                </div>
                {isCompany && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
              </button>

              {/* Admin partners — personal accounts */}
              {adminUsers.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => selectAccount(u.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
                    account === u.id
                      ? 'border-primary bg-primary/8 text-foreground'
                      : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
                  )}
                  data-testid={`pay-salary-account-admin-${u.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium leading-tight">{u.displayName}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                      Из личного счёта партнёра
                    </div>
                  </div>
                  {account === u.id && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                </button>
              ))}
            </div>

            {/* Company balance hint */}
            {isCompany && (
              <div className="flex items-center justify-between rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
                <span>Баланс счёта компании</span>
                <span
                  className="font-bold tabular-nums"
                  data-testid="pay-salary-company-balance-hint"
                >
                  {fmtUsdt(companyBalance)} USDT
                </span>
              </div>
            )}
          </div>

          {/* Currency selector — locked to USDT for the company account */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Валюта</Label>
            <Select
              value={currency}
              onValueChange={(v) => setCurrency(v as Currency)}
              disabled={isCompany}
            >
              <SelectTrigger className="h-9 text-sm" data-testid="pay-salary-currency-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem
                    key={c}
                    value={c}
                    className="text-sm"
                    data-testid={`pay-salary-currency-${c}`}
                  >
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isCompany && (
              <p className="text-[11px] text-muted-foreground">Спишется со счёта компании в USDT</p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">TX Hash (необязательно)</Label>
            <Input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="0x..."
              className="h-8 text-sm font-mono"
              data-testid="pay-salary-tx-hash"
            />
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
            onClick={() => mutation.mutate()}
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
