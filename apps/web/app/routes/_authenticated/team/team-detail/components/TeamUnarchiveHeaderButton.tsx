import { ArchiveRestore } from 'lucide-react'
import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { useUnarchiveEntity } from '@/hooks/use-archive'

/**
 * ut-39b: Header-level Unarchive button — replaces the AdminActionsMenu
 * dropdown for archived teams. Pair-unarchive (team + senior in one tx) is
 * handled by the backend.
 */
export function TeamUnarchiveHeaderButton({ teamId }: { teamId: string }) {
  const unarchive = useUnarchiveEntity('team', teamId)
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void unarchive.mutateAsync({})}
      disabled={unarchive.isPending}
      className="gap-1.5"
      data-testid="team-unarchive-button"
    >
      <ArchiveRestore className="h-4 w-4" />
      <Trans>Відновити</Trans>
    </Button>
  )
}
