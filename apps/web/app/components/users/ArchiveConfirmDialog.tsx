import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive } from 'lucide-react'
import { useState } from 'react'
import type { AxiosError } from 'axios'
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
import { ArchivePendingTransactionsList } from '@/components/archive/ArchivePendingTransactionsList'

/**
 * Replaces the old DeleteUserDialog. Behaviour:
 *  - On open, fetches GET /users/:id/archive-impact for cascade counts
 *  - Warning text varies by role:
 *      SENIOR/DROP — cascade-archive (team + N named projects, one operation).
 *                    HR/ACCOUNTANT on the team and JUNIOR on the projects keep
 *                    their membership and keep earning — task-archive-pending-
 *                    modal AC9 (owner decision 2026-08-19).
 *      HR/ACC      — removed from N teams (teams stay active)
 *      JUNIOR      — removed from M projects (projects stay active)
 *      ADMIN       — no cascades
 *  - Any PENDING salary/income addressed to the user is listed separately
 *    (ArchivePendingTransactionsList) — it survives the archive and stays
 *    payable (task-archive-pending-modal AC2).
 *  - Confirm disabled until name input matches displayName exactly
 *  - On confirm, DELETE /users/:id → invalidate ['users-admin'], teams, projects
 */
export function ArchiveConfirmDialog({
  user,
  onClose,
}: {
  user: UserProfileDto | null
  onClose: () => void
}) {
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
      if (user?.role === 'SENIOR' || user?.role === 'DROP') {
        void queryClient.invalidateQueries({ queryKey: ['teams'] })
        void queryClient.invalidateQueries({ queryKey: ['projects'] })
      }
      const msg =
        user?.role === 'SENIOR'
          ? 'Синьор и команда архивированы'
          : user?.role === 'DROP'
            ? 'Дроп и команда архивированы'
            : 'Пользователь архивирован'
      toast.success(msg)
      handleClose()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Ошибка при архивации')
    },
  })

  const handleClose = () => {
    setTyped('')
    onClose()
  }

  const matches = !!user && typed.trim() === user.displayName.trim()

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md" data-testid="archive-confirm-dialog">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Archive className="h-4 w-4" />
            Архивировать пользователя
          </DialogTitle>
          <DialogDescription className="sr-only">Архивирование пользователя</DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="space-y-3 text-sm">
            {isLoading || !user ? (
              <>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
              </>
            ) : (
              <>
                <ImpactWarning user={user} impact={impact} />
                {impact?.type === 'user' && (
                  <ArchivePendingTransactionsList transactions={impact.pendingTransactions} />
                )}
              </>
            )}

            {user && (
              <>
                <p className="text-sm text-muted-foreground pt-1">
                  Для подтверждения введите имя:{' '}
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
          <Button variant="ghost" onClick={handleClose}>
            Отмена
          </Button>
          <Button
            data-testid="archive-confirm-submit"
            variant="destructive"
            disabled={!matches || mutation.isPending || !user}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Архивация...' : 'Архивировать'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

function ImpactWarning({
  user,
  impact,
}: {
  user: UserProfileDto
  impact: ArchiveImpact | undefined
}) {
  const name = (
    <strong className="text-foreground" data-testid="archive-confirm-user-name">
      {user.displayName}
    </strong>
  )

  // task-archive-pending-modal (AC7/AC9, owner decision 2026-08-19): SENIOR
  // and DROP share the same cascade shape — команда+проекты archived as one
  // operation, third parties (HR/ACCOUNTANT on the team, JUNIOR on the
  // projects) keep their membership and keep earning off their OWN
  // `archivedAt`, untouched by this cascade.
  if (user.role === 'SENIOR' || user.role === 'DROP') {
    const roleLabel = user.role === 'SENIOR' ? 'синьора' : 'дропа'
    const teamName =
      impact && impact.type === 'user' && impact.isPaired && impact.teamName
        ? impact.teamName
        : `команда ${roleLabel}`
    const projectsCount =
      impact && impact.type === 'user' && impact.isPaired && impact.projectsCount !== undefined
        ? impact.projectsCount
        : 0
    const projectNames =
      impact && impact.type === 'user' && impact.isPaired ? (impact.projectNames ?? []) : []
    const juniorsAffected =
      impact && impact.type === 'user' && impact.isPaired && impact.juniorsAffected !== undefined
        ? impact.juniorsAffected
        : 0
    const hrAccountantsToBeRemoved =
      impact &&
      impact.type === 'user' &&
      impact.isPaired &&
      impact.hrAccountantsToBeRemoved !== undefined
        ? impact.hrAccountantsToBeRemoved
        : 0

    return (
      <div className="space-y-2">
        <p data-testid="archive-warning-senior">
          {name} и его команда <strong className="text-foreground">{teamName}</strong> — связанная
          пара. Убрать по одному нельзя — архивируются одной операцией.
        </p>
        <p className="text-muted-foreground">
          При архивации будут архивированы: профиль {roleLabel}, команда{' '}
          <strong className="text-foreground">{teamName}</strong> и все её проекты (
          <strong className="text-foreground">{projectsCount}</strong> шт.
          {projectNames.length > 0 && (
            <>
              : <strong className="text-foreground">{projectNames.join(', ')}</strong>
            </>
          )}
          ).
        </p>
        <p className="text-muted-foreground">
          HR/бухгалтеры на команде (
          <strong className="text-foreground">{hrAccountantsToBeRemoved}</strong>) и JUNIOR на этих
          проектах (<strong className="text-foreground">{juniorsAffected}</strong>)
          <strong className="text-foreground"> остаются активными членами</strong> и продолжают
          получать оплату на общих основаниях — архивация команды/проектов их не касается.
        </p>
        <p className="text-xs text-muted-foreground/80">
          Восстановление возможно — пара {roleLabel === 'синьора' ? 'senior' : 'drop'}+team
          вернётся, но проекты нужно будет восстанавливать отдельно с cascade-подтверждением.
        </p>
      </div>
    )
  }

  if (user.role === 'HR') {
    const teamsCount =
      impact && impact.type === 'user' && impact.role === 'HR' && impact.teamsCount !== undefined
        ? impact.teamsCount
        : 0
    return (
      <p data-testid="archive-warning-hr">
        {name} будет архивирован и убран из{' '}
        <strong className="text-foreground">{teamsCount} команд</strong> (HR-роль). Сами команды
        останутся активны.
      </p>
    )
  }

  if (user.role === 'ACCOUNTANT') {
    const teamsCount =
      impact &&
      impact.type === 'user' &&
      impact.role === 'ACCOUNTANT' &&
      impact.teamsCount !== undefined
        ? impact.teamsCount
        : 0
    return (
      <p data-testid="archive-warning-accountant">
        {name} будет архивирован и убран из{' '}
        <strong className="text-foreground">{teamsCount} команд</strong> (бухгалтерская роль). Сами
        команды останутся активны.
      </p>
    )
  }

  if (user.role === 'JUNIOR') {
    const projectsCount =
      impact &&
      impact.type === 'user' &&
      impact.role === 'JUNIOR' &&
      impact.projectsCount !== undefined
        ? impact.projectsCount
        : 0
    return (
      <p data-testid="archive-warning-junior">
        {name} будет архивирован и убран из{' '}
        <strong className="text-foreground">{projectsCount} активных проектов</strong>. Сами проекты
        останутся активны.
      </p>
    )
  }

  // ADMIN
  return (
    <p data-testid="archive-warning-admin">{name} будет архивирован. Связанных сущностей нет.</p>
  )
}
