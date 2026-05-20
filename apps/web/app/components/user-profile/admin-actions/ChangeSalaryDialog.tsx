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
  const [salary, setSalary] = useState(user.monthlySalary ?? '')
  const [share, setShare] = useState(String(user.seniorSharePercent ?? 26))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить зарплату</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {isShareRole ? (
            <div>
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
            <div>
              <Label>Месячная ставка (USD)</Label>
              <Input
                type="number"
                min={0}
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                placeholder="0"
              />
            </div>
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
                : { monthlySalary: salary ? parseFloat(String(salary)) : null }
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
