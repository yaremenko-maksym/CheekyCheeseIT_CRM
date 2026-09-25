import { useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
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
  const { t } = useLingui()
  const mutation = useAdminSetNote(userId)
  const [note, setNote] = useState(currentNote ?? '')

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Нотатка адміністратора</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Внутрішня нотатка, видна лише адміністраторам</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>
            <Trans>Нотатка (макс. 2000 символів)</Trans>
          </Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={8}
            maxLength={2000}
            placeholder={t`Внутрішня нотатка, видна лише адміністраторам…`}
          />
          <p className="text-xs text-muted-foreground text-right">{note.length}/2000</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={async () => {
              await mutation.mutateAsync({ note: note || null })
              onClose()
            }}
          >
            <Trans>Зберегти</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
