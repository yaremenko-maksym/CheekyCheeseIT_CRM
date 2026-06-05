import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useArchiveUser } from '@/hooks/use-user-profile'

export function ArchiveUserDialog({
  userId,
  userName,
  onClose,
}: {
  userId: string
  userName: string
  onClose: () => void
}) {
  const mutation = useArchiveUser(userId)
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === userName.trim()

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-destructive">Архивировать пользователя</DialogTitle>
          <DialogDescription className="sr-only">
            Подтверждение архивации пользователя. Введите имя для подтверждения.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Пользователь будет перемещён в архив. Связанные проекты, выплаты и история остаются.
          </p>
          <p>
            Для подтверждения введите имя: <strong className="text-foreground">{userName}</strong>
          </p>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={userName} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || mutation.isPending}
            onClick={async () => {
              await mutation.mutateAsync()
              onClose()
            }}
          >
            Архивировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
