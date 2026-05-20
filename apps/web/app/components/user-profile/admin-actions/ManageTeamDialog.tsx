import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function ManageTeamDialog({
  userId: _userId,
  onClose,
}: {
  userId: string
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Управление командой</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Перейдите в раздел «Команда» для управления составом команды.
        </p>
        <Button asChild>
          <a href="/crm/team">Открыть Команду</a>
        </Button>
      </DialogContent>
    </Dialog>
  )
}
