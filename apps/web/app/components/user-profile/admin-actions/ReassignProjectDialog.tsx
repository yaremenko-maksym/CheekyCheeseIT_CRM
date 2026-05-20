import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function ReassignProjectDialog({
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
          <DialogTitle>Переназначить проект</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Перейдите в раздел «Проекты» для управления назначениями.
        </p>
        <Button asChild>
          <a href="/crm/projects">Открыть Проекты</a>
        </Button>
      </DialogContent>
    </Dialog>
  )
}
