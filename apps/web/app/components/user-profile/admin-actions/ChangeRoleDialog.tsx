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
import { useAdminChangeRole } from '@/hooks/use-user-profile'
import type { Role } from '@crm/shared'

const ROLES: Role[] = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT']

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Senior',
  JUNIOR: 'Junior',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

export function ChangeRoleDialog({
  userId,
  currentRole,
  onClose,
}: {
  userId: string
  currentRole: string
  onClose: () => void
}) {
  const mutation = useAdminChangeRole(userId)
  const [role, setRole] = useState<Role>(currentRole as Role)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить роль</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Роль</Label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={async () => {
              await mutation.mutateAsync({ role })
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
