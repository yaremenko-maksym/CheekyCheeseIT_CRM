import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useAdminSetNote } from '@/hooks/use-user-profile'

export function AdminNoteDialog({
  userId,
  currentNote,
  onClose,
}: {
  userId: string
  currentNote: string | null
  onClose: () => void
}) {
  const mutation = useAdminSetNote(userId)
  const [note, setNote] = useState(currentNote ?? '')

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Заметка админа</DialogTitle>
          <DialogDescription className="sr-only">
            Внутренняя заметка, видна только администраторам.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Заметка (макс. 2000 символов)</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={8}
            maxLength={2000}
            placeholder="Внутренняя заметка, видна только администраторам..."
          />
          <p className="text-xs text-muted-foreground text-right">{note.length}/2000</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={async () => {
              await mutation.mutateAsync({ note: note || null })
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
