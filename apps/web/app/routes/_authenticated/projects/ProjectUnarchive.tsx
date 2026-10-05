import type { AxiosError } from 'axios'
import { ArchiveRestore } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { CascadeUnarchiveModal } from '@/components/archive/CascadeUnarchiveModal'
import {
  useUnarchiveEntity,
  type UnarchiveCascadeEntity,
  type UnarchiveError,
} from '@/hooks/use-archive'

/**
 * Header-level Unarchive button replacing AdminActionsMenu's unarchive flow.
 * Handles the 409-cascade response by lifting the entities to the parent.
 */
export function ProjectUnarchiveHeaderButton({
  projectId,
  projectName: _projectName,
  onCascadeRequired,
}: {
  projectId: string
  projectName: string
  onCascadeRequired: (entities: UnarchiveCascadeEntity[]) => void
}) {
  const unarchive = useUnarchiveEntity('project', projectId)
  const handleClick = async () => {
    try {
      await unarchive.mutateAsync({})
    } catch (err) {
      const ax = err as AxiosError<UnarchiveError>
      if (ax.response?.status === 409 && ax.response.data?.requiresCascade) {
        onCascadeRequired(ax.response.data.entities)
      }
    }
  }
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void handleClick()}
      disabled={unarchive.isPending}
      className="gap-1.5"
      data-testid="project-unarchive-button"
    >
      <ArchiveRestore className="h-3.5 w-3.5" />
      <Trans>Відновити</Trans>
    </Button>
  )
}

export function ProjectCascadeUnarchiveModal({
  projectId,
  projectName,
  entities,
  onClose,
}: {
  projectId: string
  projectName: string
  entities: UnarchiveCascadeEntity[]
  onClose: () => void
}) {
  const unarchive = useUnarchiveEntity('project', projectId)
  return (
    <CascadeUnarchiveModal
      projectName={projectName}
      entities={entities}
      isPending={unarchive.isPending}
      onConfirm={async () => {
        await unarchive.mutateAsync({ cascade: true })
        onClose()
      }}
      onCancel={onClose}
    />
  )
}
