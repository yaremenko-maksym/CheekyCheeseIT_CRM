import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
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
  const [share, setShare] = useState(String(user.seniorSharePercent ?? 26))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить зарплату</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {isShareRole ? (
            <div className="space-y-1.5">
              <Label>Доля от транзакций (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={share}
                onChange={(e) => setShare(e.target.value)}
              />
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
                ? { seniorSharePercent: parseInt(share, 10) }
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
