import { useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, Zap } from 'lucide-react'
import type { AxiosError } from 'axios'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { CascadeUnarchiveModal } from '@/components/archive/CascadeUnarchiveModal'
import {
  useUnarchiveEntity,
  type EntityType,
  type UnarchiveCascadeEntity,
  type UnarchiveError,
} from '@/hooks/use-archive'

type DialogState = 'archive' | 'cascade' | null

/**
 * Generic admin actions menu — supports archive/unarchive for teams + projects.
 * (User-profile admin actions remain in `apps/web/app/components/user-profile/admin-actions`
 * for PR 2 to evolve independently.)
 */
export function AdminActionsMenu({
  entityType,
  entityId,
  entityName,
  isArchived,
}: {
  entityType: EntityType
  entityId: string
  entityName: string
  isArchived: boolean
}) {
  const [dialog, setDialog] = useState<DialogState>(null)
  const [cascadeEntities, setCascadeEntities] = useState<UnarchiveCascadeEntity[]>([])

  const unarchive = useUnarchiveEntity(entityType, entityId)

  const handleUnarchiveClick = async () => {
    if (entityType === 'project') {
      try {
        await unarchive.mutateAsync({})
      } catch (err) {
        const ax = err as AxiosError<UnarchiveError>
        if (ax.response?.status === 409 && ax.response.data?.requiresCascade) {
          setCascadeEntities(ax.response.data.entities)
          setDialog('cascade')
        }
      }
    } else {
      await unarchive.mutateAsync({})
    }
  }

  const handleCascadeConfirm = async () => {
    try {
      await unarchive.mutateAsync({ cascade: true })
    } finally {
      setDialog(null)
      setCascadeEntities([])
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1" data-testid="admin-actions-trigger">
            <Zap className="h-4 w-4" />
            Действия
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {isArchived ? (
            <DropdownMenuItem
              onClick={() => void handleUnarchiveClick()}
              data-testid="admin-action-unarchive"
            >
              <ArchiveRestore className="mr-2 h-4 w-4" />
              Восстановить из архива
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => setDialog('archive')}
              className="text-destructive focus:text-destructive"
              data-testid="admin-action-archive"
            >
              <Archive className="mr-2 h-4 w-4" />
              Архивировать
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === 'archive' && (
        <ArchiveConfirmDialog
          entityType={entityType}
          entityId={entityId}
          entityName={entityName}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'cascade' && (
        <CascadeUnarchiveModal
          projectName={entityName}
          entities={cascadeEntities}
          isPending={unarchive.isPending}
          onConfirm={() => void handleCascadeConfirm()}
          onCancel={() => {
            setDialog(null)
            setCascadeEntities([])
          }}
        />
      )}
    </>
  )
}
