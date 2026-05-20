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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
        <div className="space-y-1.5">
          <Label>Роль</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
