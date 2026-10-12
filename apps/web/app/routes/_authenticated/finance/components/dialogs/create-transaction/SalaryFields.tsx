import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { UserOption } from './shared'

// Salary — receiver + month.
export function SalaryFields({
  receiverId,
  setReceiverId,
  clearFieldError,
  fieldErrors,
  salaryTargets,
  salaryMonth,
  setSalaryMonth,
}: {
  receiverId: string
  setReceiverId: (v: string) => void
  clearFieldError: (field: string) => void
  fieldErrors: Record<string, string>
  salaryTargets: UserOption[]
  salaryMonth: string
  setSalaryMonth: (v: string) => void
}) {
  const { t } = useLingui()
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            <Trans>Співробітник</Trans>
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
              data-testid="create-transaction-receiver-trigger"
            >
              <SelectValue
                placeholder={
                  // Stryker disable next-line StringLiteral: unselected-state placeholder — the empty-selection case is asserted via `create-transaction-error-receiver`'s message, not this generic placeholder.
                  t`Виберіть…`
                }
              />
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
          <Label className="text-xs text-muted-foreground">
            <Trans>Місяць</Trans>
          </Label>
          <input
            type="month"
            value={salaryMonth}
            onChange={(e) => setSalaryMonth(e.target.value)}
            onClick={(e) => e.currentTarget.showPicker?.()}
            onFocus={(e) => e.currentTarget.showPicker?.()}
            data-testid="create-transaction-salary-month"
            className={cn(
              'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
              'placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'cursor-pointer',
              '[color-scheme:dark]',
              '[&::-webkit-calendar-picker-indicator]:opacity-60',
              '[&::-webkit-calendar-picker-indicator]:cursor-pointer',
              '[&::-webkit-calendar-picker-indicator]:invert',
              '[&::-webkit-calendar-picker-indicator]:hover:opacity-100',
            )}
          />
        </div>
      </div>
      {fieldErrors.receiver && (
        <p className="text-[11px] text-destructive" data-testid="create-transaction-error-receiver">
          {fieldErrors.receiver}
        </p>
      )}
    </div>
  )
}
