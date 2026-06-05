import { User, Users } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { UnarchiveCascadeEntity } from '@/hooks/use-archive'

const ENTITY_LABELS: Record<UnarchiveCascadeEntity['type'], string> = {
  user: 'Пользователь (синьор)',
  team: 'Команда',
}

const ENTITY_ICONS: Record<UnarchiveCascadeEntity['type'], React.ReactNode> = {
  user: <User className="h-4 w-4 text-muted-foreground" />,
  team: <Users className="h-4 w-4 text-muted-foreground" />,
}

/**
 * Shown when POST /projects/:id/unarchive returns 409 with `requiresCascade: true`.
 * Lists the related entities that must also be unarchived (senior + team pair).
 */
export function CascadeUnarchiveModal({
  projectName,
  entities,
  onConfirm,
  onCancel,
  isPending,
}: {
  projectName: string
  entities: UnarchiveCascadeEntity[]
  onConfirm: () => void
  onCancel: () => void
  isPending?: boolean
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Восстановить связанные сущности</DialogTitle>
          <DialogDescription className="sr-only">
            Восстановление проекта вместе со связанными сущностями.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Для восстановления проекта <strong className="text-foreground">{projectName}</strong>{' '}
            требуется также восстановить пару:
          </p>
          <div className="space-y-2">
            {entities.map((e) => (
              <div
                key={`${e.type}:${e.id}`}
                className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2"
                data-testid={`cascade-entity-${e.type}`}
              >
                {ENTITY_ICONS[e.type]}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">{ENTITY_LABELS[e.type]}</p>
                  <p className="truncate text-sm font-medium">{e.name}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            HR/бухгалтеры команды после восстановления остаются отвязанными — добавьте их заново.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>
            Отмена
          </Button>
          <Button onClick={onConfirm} disabled={isPending} data-testid="cascade-unarchive-confirm">
            {isPending ? 'Восстановление…' : 'Восстановить всё'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
