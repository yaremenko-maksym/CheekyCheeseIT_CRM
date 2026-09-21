import { User, Users } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
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

const ENTITY_LABEL_MESSAGES: Record<UnarchiveCascadeEntity['type'], MessageDescriptor> = {
  user: msg`Користувач (сеньйор)`,
  team: msg`Команда`,
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
  const { i18n } = useLingui()
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Відновити пов'язане</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Відновлення проєкту разом із пов'язаними командою і профілем.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            <Trans>
              Для відновлення проєкту <strong className="text-foreground">{projectName}</strong>{' '}
              потрібно також відновити пару:
            </Trans>
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
                  <p className="text-xs text-muted-foreground">
                    {i18n._(ENTITY_LABEL_MESSAGES[e.type])}
                  </p>
                  <p className="truncate text-sm font-medium">{e.name}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            <Trans>
              HR/бухгалтери команди після відновлення залишаються відв'язаними — додайте їх заново.
            </Trans>
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button onClick={onConfirm} disabled={isPending} data-testid="cascade-unarchive-confirm">
            {isPending ? <Trans>Відновлення…</Trans> : <Trans>Відновити все</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
