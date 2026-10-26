import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { MonthPickerField } from '@/components/ui/month-picker'
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
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        data-testid="create-transaction-salary-grid"
      >
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
              className={cn(
                // Stryker disable next-line StringLiteral: `SelectTrigger`'s own base classes already include `h-9` and `text-sm`, and `cn` (tailwind-merge) de-duplicates them — dropping this redundant pair from the className changes no rendered class, so it is unobservable by construction (the `border-destructive` literal on the next line IS pinned by the error-state tests).
                'h-9 text-sm',
                fieldErrors.receiver && 'border-destructive',
              )}
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
          <Label
            htmlFor="create-transaction-salary-month-trigger"
            className="text-xs text-muted-foreground"
          >
            <Trans>Місяць</Trans>
          </Label>
          <MonthPickerField
            id="create-transaction-salary-month-trigger"
            value={salaryMonth}
            onChange={setSalaryMonth}
            data-testid="create-transaction-salary-month"
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
