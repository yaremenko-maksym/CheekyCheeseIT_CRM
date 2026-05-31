import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeftRight, TrendingUp, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import type { TransactionType } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
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
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'
import { Textarea } from '@/components/ui/textarea'
import { DatePickerField } from '@/components/ui/date-picker'
import { financeApi } from '../../api'
import { EXPENSE_CATEGORIES, TYPE_LABELS } from '../../constants'
import { ReceiptInput, emptyReceiptState, type ReceiptState } from '../ReceiptInput'

// Drop role - phase 2. Extended with `dropId` so the DROP_INCOME path can
// filter projects by `project.dropId === user.id`. Backward compatible —
// `dropId` is optional + null for legacy senior-projects.
type ProjectOption = { id: string; name: string; seniorId: string; dropId?: string | null }
type UserOption = { id: string; displayName: string; role: string }
type ExchangeRate = { usdUah: string; usdtUah: string; eurUah: string; date: string }

type Currency = 'USDT' | 'USD' | 'EUR' | 'UAH'

const TYPE_ICONS: Record<string, React.ReactNode> = {
  ADMIN_INCOME: <TrendingUp className="h-4 w-4" />,
  SENIOR_INCOME: <TrendingUp className="h-4 w-4" />,
  // Drop role - phase 2. DROP_INCOME reuses TrendingUp — same business
  // semantics (income), different recipient.
  DROP_INCOME: <TrendingUp className="h-4 w-4" />,
  EXPENSE: <Wallet className="h-4 w-4" />,
  SALARY: <Wallet className="h-4 w-4" />,
  ADMIN_TRANSFER: <ArrowLeftRight className="h-4 w-4" />,
}

const TYPE_DESCRIPTIONS: Record<string, string> = {
  ADMIN_INCOME: 'Доход с собственного проекта',
  SENIOR_INCOME: 'Доход синьора с проекта',
  DROP_INCOME: 'Доход дропа с drop-проекта',
  EXPENSE: 'Расход компании',
  SALARY: 'Выплата зарплаты сотруднику',
  ADMIN_TRANSFER: 'Перевод между партнёрами',
}

function needsConversion(currency: Currency) {
  return currency === 'EUR' || currency === 'UAH' || currency === 'USD'
}

function getRate(currency: Currency, rates: ExchangeRate | undefined): number | null {
  if (!rates) return null
  if (currency === 'EUR') return parseFloat(rates.eurUah) / parseFloat(rates.usdUah)
  if (currency === 'UAH') return 1 / parseFloat(rates.usdUah)
  if (currency === 'USD') return 1
  return null
}

export function CreateTransactionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const qc = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'
  const isSenior = user?.role === 'SENIOR'
  // Drop role - phase 2. DROP user can only declare DROP_INCOME via this
  // dialog (mirrors SENIOR_INCOME from the senior path). Other roles never
  // reach this dialog (FinancePage guards them out).
  const isDrop = user?.role === 'DROP'

  const availableTypes: TransactionType[] = isAdmin
    ? ['ADMIN_INCOME', 'EXPENSE', 'SALARY', 'ADMIN_TRANSFER']
    : isSenior
      ? ['SENIOR_INCOME']
      : isDrop
        ? ['DROP_INCOME']
        : []

  const [type, setType] = useState<TransactionType>(availableTypes[0] ?? 'SENIOR_INCOME')
  const [projectId, setProjectId] = useState('')
  const [receiverId, setReceiverId] = useState('')
  const [transferSenderId, setTransferSenderId] = useState<string>('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('USDT')
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]!)
  const [salaryMonth, setSalaryMonth] = useState(() => {
    const prev = new Date()
    prev.setMonth(prev.getMonth() - 1)
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  })
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceiptState())
  const [notes, setNotes] = useState('')
  const [txDate, setTxDate] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  // AC4: per-field validation errors keyed by field name. Populated on submit
  // so the user sees EVERY missing/invalid field at once (project, receipt,
  // amount, …) inline next to the field, instead of only the first failure in
  // a single bottom banner.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Drop a single field's error as soon as the user edits it — keeps the
  // inline hint from lingering after the problem is fixed.
  function clearFieldError(field: string) {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  const { data: projects = [] } = useQuery<ProjectOption[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectOption[]>('/projects').then((r) => r.data),
    enabled: open && (isAdmin || isSenior || isDrop),
  })

  const { data: allUsers = [] } = useQuery<UserOption[]>({
    queryKey: ['users-all'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: open && isAdmin,
  })

  // Fetch NBU rates when non-USD/USDT currency selected, keyed by date
  const needsRate = needsConversion(currency)
  const rateDateParam = txDate.replace(/-/g, '') // YYYY-MM-DD → YYYYMMDD
  const { data: exchangeRate, isFetching: _rateFetching } = useQuery<ExchangeRate>({
    queryKey: ['exchange-rate', rateDateParam],
    queryFn: () =>
      api.get<ExchangeRate>(`/finance/exchange-rate?date=${rateDateParam}`).then((r) => r.data),
    enabled: open && needsRate,
    staleTime: 1000 * 60 * 60 * 24, // 24h — historical rates don't change
  })

  const myProjects = isSenior ? projects.filter((p) => p.seniorId === user?.id) : projects
  const adminProjects = isAdmin ? projects.filter((p) => p.seniorId === user?.id) : []
  // Drop role - phase 2. DROP user can only declare income on drop-projects
  // routed through them. Backend enforces this too — UI mirrors the rule.
  const dropProjects = isDrop ? projects.filter((p) => p.dropId === user?.id) : []
  const salaryTargets = allUsers.filter((u) => ['JUNIOR', 'HR', 'ACCOUNTANT'].includes(u.role))
  const adminUsers = allUsers.filter((u) => u.role === 'ADMIN')
  const adminTargets = adminUsers.filter((u) => u.id !== user?.id)

  // Init transferSenderId to self when admins load
  const effectiveTransferSenderId = transferSenderId || user?.id || ''
  const transferReceiverId = receiverId || adminTargets[0]?.id || ''
  const transferSender = adminUsers.find((u) => u.id === effectiveTransferSenderId)
  const transferReceiver = adminUsers.find((u) => u.id === transferReceiverId)

  function swapTransfer() {
    const prevSender = effectiveTransferSenderId
    const prevReceiver = transferReceiverId
    setTransferSenderId(prevReceiver)
    setReceiverId(prevSender)
  }

  // AC4: collect ALL validation errors up front (keyed by field) so the user
  // sees every problem inline at once. Returns an empty object when valid.
  function validate(): Record<string, string> {
    const errors: Record<string, string> = {}
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) errors.amount = 'Укажите корректную сумму'

    const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
    const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null
    const hasReceipt = receiptDocumentId || receiptExternalUrl

    if (type === 'ADMIN_INCOME' || type === 'SENIOR_INCOME' || type === 'DROP_INCOME') {
      if (!projectId) errors.project = 'Выберите проект'
    }
    if (type === 'SENIOR_INCOME' || type === 'DROP_INCOME') {
      if (!hasReceipt) errors.receipt = 'Прикрепите чек или укажите ссылку на подтверждение'
    }
    if (type === 'SALARY') {
      if (!receiverId) errors.receiver = 'Выберите сотрудника'
    }
    if (type === 'ADMIN_TRANSFER') {
      if (!transferReceiverId) errors.receiver = 'Выберите получателя'
    }
    return errors
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount)
      // Build XOR receipt fields: exactly one populated, or both null.
      const receiptDocumentId = receipt.mode === 'file' ? receipt.documentId : null
      const receiptExternalUrl = receipt.mode === 'url' ? receipt.externalUrl || null : null

      if (type === 'ADMIN_INCOME') {
        return financeApi.createAdminIncome({
          projectId,
          amount: amt,
          currency,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'SENIOR_INCOME') {
        return financeApi.createSeniorIncome({
          projectId,
          amount: amt,
          currency,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      // Drop role - phase 2. Same payload shape as senior income — mirror
      // path goes through `POST /transactions/drop-income`.
      if (type === 'DROP_INCOME') {
        return financeApi.createDropIncome({
          projectId,
          amount: amt,
          currency,
          receiptDocumentId,
          receiptExternalUrl,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'EXPENSE') {
        return financeApi.createExpense({
          amount: amt,
          currency,
          category,
          notes: notes || null,
          receiptDocumentId,
          receiptExternalUrl,
          txDate: txDate || null,
        })
      }
      if (type === 'SALARY') {
        return financeApi.createSalary({
          receiverId,
          amount: amt,
          currency,
          salaryMonth,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      if (type === 'ADMIN_TRANSFER') {
        return financeApi.createAdminTransfer({
          senderId: effectiveTransferSenderId,
          receiverId: transferReceiverId,
          amount: amt,
          currency,
          notes: notes || null,
          txDate: txDate || null,
        })
      }
      throw new Error('Unknown type')
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] })
      void qc.invalidateQueries({ queryKey: ['finance-summary'] })
      // Drop role - phase 2. Confirm the new flow loudly so the DROP user
      // knows their tx is registered + queued for validation. Other types
      // already surface via the table refresh so a toast would be noise.
      if (type === 'DROP_INCOME') {
        toast.success('Приход зарегистрирован, ожидает валидации')
      }
      onClose()
      resetForm()
    },
  })

  // Validate first; only fire the network mutation when every field is valid.
  function handleSubmit() {
    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    mutation.mutate()
  }

  function resetForm() {
    setProjectId('')
    setReceiverId('')
    setTransferSenderId('')
    setAmount('')
    setCurrency('USDT')
    setCategory(EXPENSE_CATEGORIES[0]!)
    setReceipt(emptyReceiptState())
    setNotes('')
    setFieldErrors({})
    const now = new Date()
    setTxDate(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    )
  }

  const error = mutation.error instanceof Error ? mutation.error.message : null
  const showReceipt =
    type === 'ADMIN_INCOME' ||
    type === 'SENIOR_INCOME' ||
    type === 'DROP_INCOME' ||
    type === 'EXPENSE'
  const hasFieldErrors = Object.keys(fieldErrors).length > 0

  // Conversion info
  const rate = needsRate ? getRate(currency, exchangeRate) : null
  const amtNum = parseFloat(amount)
  const _convertedUsd = rate && !isNaN(amtNum) && amtNum > 0 ? (amtNum * rate).toFixed(2) : null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose()
          resetForm()
        }
      }}
    >
      <CrmDialogContent maxWidth="sm:max-w-lg" data-testid="create-transaction-dialog">
        <CrmDialogHeader>
          <DialogTitle className="text-base" data-testid="create-transaction-dialog-title">
            Новая транзакция
          </DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody className="space-y-4 py-1">
          {/* Type selector — card-style */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Тип операции</Label>
            <div className="grid grid-cols-1 gap-1.5">
              {availableTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setType(t)
                    setProjectId('')
                    setReceiverId('')
                    setFieldErrors({})
                  }}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all',
                    type === t
                      ? 'border-primary bg-primary/8 text-foreground'
                      : 'border-border bg-muted/20 text-muted-foreground hover:border-border/80 hover:bg-muted/40',
                  )}
                  data-testid={`create-transaction-type-${t.toLowerCase()}`}
                >
                  <span className="text-muted-foreground shrink-0">{TYPE_ICONS[t]}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium leading-tight">{TYPE_LABELS[t]}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                      {TYPE_DESCRIPTIONS[t]}
                    </div>
                  </div>
                  {type === t && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                </button>
              ))}
            </div>
          </div>

          <div className="h-px bg-border/60" />

          {/* Project selector */}
          {(type === 'SENIOR_INCOME' || type === 'ADMIN_INCOME' || type === 'DROP_INCOME') && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Проект</Label>
              <Select
                value={projectId}
                onValueChange={(v) => {
                  setProjectId(v)
                  clearFieldError('project')
                }}
              >
                <SelectTrigger
                  className={cn('h-9 text-sm', fieldErrors.project && 'border-destructive')}
                  data-testid="create-transaction-project-trigger"
                >
                  <SelectValue placeholder="Выберите проект" />
                </SelectTrigger>
                <SelectContent>
                  {(type === 'ADMIN_INCOME'
                    ? adminProjects
                    : type === 'DROP_INCOME'
                      ? dropProjects
                      : myProjects
                  ).map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-sm">
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldErrors.project && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="create-transaction-error-project"
                >
                  {fieldErrors.project}
                </p>
              )}
            </div>
          )}

          {/* Salary — receiver + month */}
          {type === 'SALARY' && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Сотрудник</Label>
                  <Select
                    value={receiverId}
                    onValueChange={(v) => {
                      setReceiverId(v)
                      clearFieldError('receiver')
                    }}
                  >
                    <SelectTrigger
                      className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
                      data-testid="create-transaction-receiver-trigger"
                    >
                      <SelectValue placeholder="Выберите..." />
                    </SelectTrigger>
                    <SelectContent>
                      {salaryTargets.map((u) => (
                        <SelectItem key={u.id} value={u.id} className="text-sm">
                          {u.displayName}
                          <span className="ml-1 text-[10px] text-muted-foreground">({u.role})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Месяц</Label>
                  <Input
                    value={salaryMonth}
                    onChange={(e) => setSalaryMonth(e.target.value)}
                    placeholder="2025-03"
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              {fieldErrors.receiver && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="create-transaction-error-receiver"
                >
                  {fieldErrors.receiver}
                </p>
              )}
            </div>
          )}

          {/* Admin transfer — swap UI */}
          {type === 'ADMIN_TRANSFER' && adminUsers.length >= 2 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Направление перевода</Label>
              <div className="flex items-center gap-2">
                {/* Sender card */}
                <button
                  type="button"
                  onClick={swapTransfer}
                  className={cn(
                    'flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center',
                    'border-border bg-muted/20 hover:bg-muted/40',
                  )}
                  title="Нажмите для смены направления"
                >
                  <div className="h-8 w-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-sm font-bold text-primary">
                    {transferSender?.displayName.charAt(0) ?? '?'}
                  </div>
                  <span className="text-xs font-medium leading-tight">
                    {transferSender?.displayName ?? '—'}
                  </span>
                  <span className="text-[10px] text-muted-foreground">отправляет</span>
                </button>

                {/* Swap button */}
                <button
                  type="button"
                  onClick={swapTransfer}
                  className="shrink-0 h-8 w-8 rounded-full border border-border bg-muted/30 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all hover:rotate-180 duration-300"
                  title="Поменять направление"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>

                {/* Receiver card */}
                <button
                  type="button"
                  onClick={swapTransfer}
                  className={cn(
                    'flex-1 flex flex-col items-center gap-1 rounded-lg border px-3 py-2.5 transition-all text-center',
                    'border-border bg-muted/20 hover:bg-muted/40',
                  )}
                  title="Нажмите для смены направления"
                >
                  <div className="h-8 w-8 rounded-full bg-muted/40 border border-border flex items-center justify-center text-sm font-bold text-muted-foreground">
                    {transferReceiver?.displayName.charAt(0) ?? '?'}
                  </div>
                  <span className="text-xs font-medium leading-tight">
                    {transferReceiver?.displayName ?? '—'}
                  </span>
                  <span className="text-[10px] text-muted-foreground">получает</span>
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/60 text-center">
                Нажмите на карточки или стрелку, чтобы поменять направление
              </p>
            </div>
          )}

          {/* Expense category — pill buttons */}
          {type === 'EXPENSE' && (
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

          {/* Amount + Currency */}
          <AmountCurrencyInput
            amount={amount}
            currency={currency}
            onAmountChange={(v) => {
              setAmount(v)
              clearFieldError('amount')
            }}
            onCurrencyChange={setCurrency}
            error={fieldErrors.amount}
            errorTestId="create-transaction-error-amount"
          />

          {/* Date */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Дата транзакции</Label>
            <DatePickerField value={txDate} onChange={setTxDate} className="h-9 text-sm" />
          </div>

          {/* Receipt */}
          {showReceipt && (
            <div className="space-y-1.5">
              <ReceiptInput
                state={receipt}
                onChange={(s) => {
                  setReceipt(s)
                  clearFieldError('receipt')
                }}
                label={type === 'SENIOR_INCOME' ? 'Чек / подтверждение *' : 'Чек / подтверждение'}
              />
              {fieldErrors.receipt && (
                <p
                  className="text-[11px] text-destructive"
                  data-testid="create-transaction-error-receipt"
                >
                  {fieldErrors.receipt}
                </p>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Заметки <span className="text-muted-foreground/50">(необязательно)</span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Дополнительная информация..."
              rows={2}
              className="text-sm resize-none"
            />
          </div>
        </CrmDialogBody>

        {/* AC4: when fields are missing, show a short summary banner pointing
            at the inline hints (the offending field can be below the fold).
            The server/mutation error keeps its own banner below it. */}
        {hasFieldErrors && (
          <div
            className="flex items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
            data-testid="create-transaction-field-error-summary"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Заполните выделенные поля
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        <CrmDialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClose()
              resetForm()
            }}
            data-testid="create-transaction-cancel"
          >
            Отмена
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={mutation.isPending}
            data-testid="create-transaction-submit"
          >
            {mutation.isPending ? 'Создание...' : 'Создать транзакцию'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
