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
import { useAdminUpdateUser } from '@/hooks/use-user-profile'

export function EditProfileDialog({
  userId,
  user,
  onClose,
}: {
  userId: string
  user: UserProfileDto
  onClose: () => void
}) {
  const mutation = useAdminUpdateUser(userId)
  const [displayName, setDisplayName] = useState(user.displayName)
  const [telegram, setTelegram] = useState(user.telegram ?? '')
  const [phone, setPhone] = useState(user.phone ?? '')

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Редактировать профиль</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Имя</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label>Telegram</Label>
            <Input
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
              placeholder="@username"
            />
          </div>
          <div>
            <Label>Телефон</Label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+380..."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={async () => {
              await mutation.mutateAsync({
                displayName,
                telegram: telegram || null,
                phone: phone || null,
              })
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
