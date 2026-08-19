import { useState } from 'react'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { UserProfileDto } from '@crm/shared'
import { useArchiveUser } from '@/hooks/use-user-profile'
import { useArchiveImpact } from '@/hooks/use-archive'
import { ImpactWarning } from '@/components/users/ArchiveConfirmDialog'
import { ArchivePendingTransactionsList } from '@/components/archive/ArchivePendingTransactionsList'

/**
 * task-archive-pending-modal (AC2/AC8). Used to render a bare "type the name
 * to confirm" prompt with NO cascade information at all — the profile page
 * was the one archive entry point that never surfaced what archiving this
 * person would actually do. Now fetches the same `GET /users/:id/archive-
 * impact` the other two archive dialogs use and reuses their exact copy
 * (`ImpactWarning`, exported from `components/users/ArchiveConfirmDialog`)
 * plus the shared pending-transactions warning — one rule, three surfaces,
 * not three copies of it.
 *
 * task-archive-pending-modal (round 2, design fidelity BLOCK): originally
 * built on the bare `DialogContent` (no max-height/overflow-y-auto) — on
 * 320/375 with a real PENDING+cascade payload the dialog grew to ~840px
 * against a 568px viewport, cutting off the title, the close button, AND
 * BOTH footer buttons at once (this was the worse of the two broken
 * dialogs — this one never even had scrollable impact text before this
 * fix). `CrmDialogContent`/`CrmDialogBody`/`CrmDialogFooter` (same pattern
 * `components/users/ArchiveConfirmDialog.tsx` already used correctly) fixes
 * it: max-h-[90dvh], scrollable body, header/footer pinned.
 */
export function ArchiveUserDialog({
  user,
  onClose,
}: {
  user: UserProfileDto
  onClose: () => void
}) {
  const mutation = useArchiveUser(user.id)
  const { data: impact, isLoading } = useArchiveImpact('user', user.id)
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === user.displayName.trim()

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <CrmDialogContent maxWidth="sm:max-w-lg" onCloseAutoFocus={(e) => e.preventDefault()}>
        <CrmDialogHeader>
          <DialogTitle className="text-destructive">Архивировать пользователя</DialogTitle>
          <DialogDescription className="sr-only">
            Подтверждение архивации пользователя. Введите имя для подтверждения.
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="space-y-3 text-sm">
            {isLoading ? (
              <>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </>
            ) : (
              <>
                <ImpactWarning user={user} impact={impact} />
                {impact?.type === 'user' && (
                  <ArchivePendingTransactionsList transactions={impact.pendingTransactions} />
                )}
              </>
            )}
            <p>
              Для подтверждения введите имя:{' '}
              <strong className="text-foreground">{user.displayName}</strong>
            </p>
            <Input
              data-testid="archive-confirm-name-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={user.displayName}
            />
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            data-testid="archive-confirm-submit"
            variant="destructive"
            disabled={!matches || mutation.isPending}
            onClick={async () => {
              await mutation.mutateAsync()
              onClose()
            }}
          >
            Архивировать
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
