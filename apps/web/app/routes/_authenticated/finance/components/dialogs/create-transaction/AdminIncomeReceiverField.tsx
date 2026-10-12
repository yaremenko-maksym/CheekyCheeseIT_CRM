import { Trans, useLingui } from '@lingui/react/macro'
import { COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { UserOption } from './shared'

// task-admin-income-unified (§2, owner decision 2026-08-12). ADMIN gets a flat
// "Рахунок отримувача" Select — any ACTIVE admin (`/users` excludes archived by
// default, AC9) + «Рахунок компанії», no group headers, no default
// pre-selection — covering BOTH routes (createAdminIncome AND
// declareUsdtProjectIncome). `adminUsers` is role-filtered (=== 'ADMIN'): a drop
// structurally cannot appear here. ACCOUNTANT does NOT get this Select — it gets
// the constrained funding toggle instead.
export function AdminIncomeReceiverField({
  receiverId,
  setReceiverId,
  clearFieldError,
  fieldErrors,
  adminUsers,
  isSelectedProjectUsdt,
  companyBalance,
  fmtUsdt,
}: {
  receiverId: string
  setReceiverId: (v: string) => void
  clearFieldError: (field: string) => void
  fieldErrors: Record<string, string>
  adminUsers: UserOption[]
  isSelectedProjectUsdt: boolean
  companyBalance: number
  fmtUsdt: (n: number) => string
}) {
  const { t } = useLingui()
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        <Trans>Рахунок отримувача</Trans>
      </Label>
      <Select
        value={receiverId}
        onValueChange={(v) => {
          setReceiverId(v)
          clearFieldError('receiver')
        }}
      >
        <SelectTrigger
          className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
          data-testid="admin-income-receiver-trigger"
        >
          <SelectValue placeholder={t`Виберіть отримувача`} />
        </SelectTrigger>
        <SelectContent>
          {adminUsers.map((u) => (
            <SelectItem key={u.id} value={u.id} className="text-sm">
              {u.displayName}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={COMPANY_ACCOUNT_RECEIVER} className="text-sm">
            <Trans>Рахунок компанії</Trans>
          </SelectItem>
        </SelectContent>
      </Select>
      {/* USDT-route-specific: createAdminIncome never books an
                  obligation (AC3) — showing this on a FOP/GIG project would be
                  a false promise. */}
      {isSelectedProjectUsdt && (
        <p className="text-xs text-muted-foreground">
          <Trans>
            Весь дохід (gross) піде обраному отримувачу. Компанія автоматично створить зобов’язання
            виплатити сеньйору та дропу їхні частки.
          </Trans>
        </p>
      )}
      {/* Company account balance hint — same hint the EXPENSE/ACCOUNTANT
                  toggles show, now keyed off `receiverId` for this Select. */}
      {receiverId === COMPANY_ACCOUNT_RECEIVER && (
        <div className="flex items-center justify-between rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-400">
          <span>
            <Trans>Баланс рахунку компанії</Trans>
          </span>
          <span
            className="font-bold tabular-nums"
            data-testid="create-transaction-company-balance-hint"
          >
            {fmtUsdt(companyBalance)} USDT
          </span>
        </div>
      )}
      {fieldErrors.receiver && (
        <p className="text-[11px] text-destructive" data-testid="admin-income-error-receiver">
          {fieldErrors.receiver}
        </p>
      )}
    </div>
  )
}
