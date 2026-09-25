import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive } from 'lucide-react'
import { useState } from 'react'
import { select } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ArchiveImpact, UserProfileDto } from '@crm/shared'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { ArchivePendingTransactionsList } from '@/components/archive/ArchivePendingTransactionsList'
import { UserArchiveImpact } from '@/components/archive/UserArchiveImpact'

/**
 * Replaces the old DeleteUserDialog. Behaviour:
 *  - On open, fetches GET /users/:id/archive-impact for cascade counts
 *  - Warning text (all roles) is owned by `UserArchiveImpact` — the SAME
 *    component `components/archive/ArchiveConfirmDialog` (entityType='user')
 *    and `user-profile/admin-actions/ArchiveUserDialog` render, task-i18n-
 *    stage3b (PR2) "two ArchiveConfirmDialog" note: this dialog keeps its
 *    OWN mutation/invalidation/testid/close-guard behaviour (security-review
 *    PR #584 round 3), only the impact TEXT is shared.
 *  - Any PENDING salary/income addressed to the user is listed separately
 *    (ArchivePendingTransactionsList) — it survives the archive and stays
 *    payable (task-archive-pending-modal AC2).
 *  - Confirm disabled until name input matches displayName exactly
 *  - On confirm, DELETE /users/:id → invalidate ['users-admin'], teams, projects
 */
export function ArchiveUserConfirmDialog({
  user,
  onClose,
}: {
  user: UserProfileDto | null
  onClose: () => void
}) {
  const { t } = useLingui()
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState('')

  const { data: impact, isLoading } = useQuery({
    queryKey: ['users-archive-impact', user?.id],
    queryFn: () => api.get<ArchiveImpact>(`/users/${user!.id}/archive-impact`).then((r) => r.data),
    enabled: !!user,
    staleTime: 0,
  })

  const mutation = useMutation({
    mutationFn: () => api.delete(`/users/${user!.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      // task-archive-pending-modal (AC7): DROP cascades team+projects exactly
      // like SENIOR — both need the same invalidation.
      //
      // security-review PR #584 round 3: `onSuccess` reads `user` from
      // WHATEVER render was current when the mutation settled, not the
      // render active at `.mutate()` time (TanStack Query v5 stores the
      // latest options on every render and invokes the CURRENT callback on
      // settle — @tanstack/query-core's `createMutation`/`setOptions`).
      // `mutationFn`'s `user!.id` above is captured once, at call time,
      // inside the async function already in flight — it does NOT prove
      // anything about what `onSuccess` sees later. Without a guard, a
      // dismiss gesture mid-mutation (Cancel, Escape, overlay click) could
      // re-render this component with `user=null` before the delete
      // resolves, and `onSuccess` would then run against that null. The
      // `<Dialog>` below now refuses to close while `mutation.isPending`
      // (Cancel is disabled AND `onOpenChange` ignores Escape/overlay
      // dismissal during the pending window), so `user` cannot become null
      // between `.mutate()` and this callback firing — `?.` stays as
      // defence-in-depth for a state this component's OWN interaction
      // surface can no longer produce, not a line this test suite can drive
      // to a genuinely different outcome (the component's own guards make
      // it unreachable, not the old — incorrect — "mutationFn already
      // proved it" reasoning this replaces).
      // Stryker disable next-line OptionalChaining: `user` is provably non-null here — see the long comment above (the dialog's own dismiss-guard makes it unreachable, not the old "mutationFn already proved it" reasoning).
      if (user?.role === 'SENIOR' || user?.role === 'DROP') {
        void queryClient.invalidateQueries({ queryKey: ['teams'] })
        void queryClient.invalidateQueries({ queryKey: ['projects'] })
      }
      // Role stands in the accusative case (uk) — "Сеньйора й команду
      // архівовано" reads as a completed passive action and stays the same
      // regardless of the archived person's gender, unlike an adjective
      // agreement would. `other` is reachable: HR/ACCOUNTANT/JUNIOR/ADMIN
      // all take the generic "Користувача архівовано".
      // Stryker disable next-line OptionalChaining: same non-null guarantee as the `if` above
      const archivedRole = user?.role ?? 'ADMIN'
      // Stryker disable next-line ObjectLiteral,StringLiteral: Lingui's select() macro needs this options object to stay a literal it can statically read at compile time (the `{}` mutant makes the transform throw before any test runs) — `other` covers HR/ACCOUNTANT/JUNIOR/ADMIN and is reachable by every one of them.
      const successMessage = select(archivedRole, {
        SENIOR: 'Сеньйора й команду архівовано',
        DROP: 'Дропа й команду архівовано',
        other: 'Користувача архівовано',
      })
      toast.success(successMessage)
      handleClose()
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, t`Не вдалося архівувати користувача — спробуйте ще раз`))
    },
  })

  const handleClose = () => {
    setTyped('')
    onClose()
  }

  const matches = !!user && typed.trim() === user.displayName.trim()

  return (
    // security-review PR #584 round 3: ignore any dismiss gesture (Escape,
    // overlay click) while the archive DELETE is in flight — see the long
    // comment on mutation.onSuccess above for why this is what makes `user`
    // provably non-null there, not just the disabled Cancel button below.
    <Dialog open={!!user} onOpenChange={(o) => !o && !mutation.isPending && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="archive-confirm-dialog">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Archive className="h-4 w-4" />
            <Trans>Архівувати користувача</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Архівування користувача</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="space-y-3 text-sm">
            {isLoading || !user ? (
              <div data-testid="archive-impact-loading">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : (
              <>
                {impact?.type === 'user' && (
                  <UserArchiveImpact entityName={user.displayName} impact={impact} />
                )}
                {impact?.type === 'user' && (
                  <ArchivePendingTransactionsList transactions={impact.pendingTransactions} />
                )}
              </>
            )}

            {user && (
              <>
                <p className="text-sm text-muted-foreground pt-1">
                  <Trans>Для підтвердження введіть ім’я:</Trans>{' '}
                  <strong className="text-foreground">{user.displayName}</strong>
                </p>
                <Input
                  data-testid="archive-confirm-name-input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={user.displayName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matches && !mutation.isPending) {
                      e.preventDefault()
                      mutation.mutate()
                    }
                  }}
                />
              </>
            )}
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={mutation.isPending}>
            <Trans>Скасувати</Trans>
          </Button>
          <Button
            data-testid="archive-confirm-submit"
            variant="destructive"
            disabled={!matches || mutation.isPending || !user}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? t`Архівуємо…` : t`Архівувати`}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
