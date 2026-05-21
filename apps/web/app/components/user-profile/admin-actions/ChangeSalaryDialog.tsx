import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import { SliderNumberInput } from '@/components/ui/slider-number-input'
import type { UserProfileDto } from '@crm/shared'
import { useAdminChangeSalary } from '@/hooks/use-user-profile'

export function ChangeSalaryDialog({
  userId,
  user,
  onClose,
}: {
  userId: string
  user: UserProfileDto
  onClose: () => void
}) {
  const mutation = useAdminChangeSalary(userId)
  const isShareRole = user.role === 'SENIOR' || user.role === 'ADMIN'
  const [salary, setSalary] = useState(String(user.monthlySalary ?? ''))
  const [salaryCurrency, setSalaryCurrency] = useState<Currency>((user.salaryCurrency as Currency | undefined) ?? 'USD')
  const [share, setShare] = useState<number>(user.seniorSharePercent ?? 26)

  // For SENIOR/ADMIN the dialog edits a "share %" — visible label, title and
  // payload all reflect that.
  const title = isShareRole ? 'Изменить долю' : 'Изменить зарплату'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {isShareRole ? (
            <div className="space-y-2">
              <Label>Доля компании (%)</Label>
              <SliderNumberInput
                value={share}
                onChange={setShare}
                min={0}
                max={100}
                step={1}
                suffix="%"
                ariaLabel="Доля компании"
              />
              <p className="text-xs text-muted-foreground">
                Синьор получает {100 - share}% от транзакции, компания — {share}%.
              </p>
            </div>
          ) : (
            <AmountCurrencyInput
              amount={salary}
              currency={salaryCurrency}
              onAmountChange={setSalary}
              onCurrencyChange={setSalaryCurrency}
              label="Месячная ставка"
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={async () => {
              const payload = isShareRole
                ? { seniorSharePercent: share }
                : { monthlySalary: salary ? parseFloat(salary) : null, salaryCurrency }
              await mutation.mutateAsync(payload)
              onClose()
            }}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
