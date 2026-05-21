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
import { RoleSelect } from '@/components/ui/role-select'
import { useAdminChangeRole } from '@/hooks/use-user-profile'
import type { Role } from '@crm/shared'

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
          {/* ADMIN role is intentionally hidden — admins cannot be created via UI */}
          <RoleSelect value={role} onChange={setRole} exclude={['ADMIN']} />
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
