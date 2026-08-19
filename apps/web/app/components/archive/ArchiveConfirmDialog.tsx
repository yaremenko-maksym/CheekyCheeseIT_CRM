import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useArchiveImpact, useArchiveEntity, type EntityType } from '@/hooks/use-archive'
import type { ArchiveImpact } from '@crm/shared'
import { ArchivePendingTransactionsList } from '@/components/archive/ArchivePendingTransactionsList'

/**
 * Per-entity dialog titles. The team variant has a drop-team sibling that
 * uses a different title — see `getTeamTitle` below.
 */
const TITLES: Record<EntityType, string> = {
  user: 'Архивировать пользователя',
  team: 'Архивировать команду',
  project: 'Архивировать проект',
}

const ROLE_RU: Record<string, string> = {
  SENIOR: 'синьора',
  HR: 'HR',
  JUNIOR: 'джуна',
  ACCOUNTANT: 'бухгалтера',
  ADMIN: 'администратора',
}

/**
 * Builds the role-aware warning text shown above the confirmation input.
 * Numbers (N, M, K) come from `GET /<entity>s/:id/archive-impact`.
 */
function renderImpactText(
  entityType: EntityType,
  entityName: string,
  impact: ArchiveImpact | undefined,
): React.ReactNode {
  if (!impact) return <span className="text-muted-foreground">Загружаем влияние…</span>

  if (entityType === 'user' && impact.type === 'user') {
    const role = impact.role
    // task-archive-pending-modal (AC7/AC9, owner decision 2026-08-19): SENIOR
    // and DROP cascade команда+проекты as one operation; HR/ACCOUNTANT on the
    // team and JUNIOR on the projects keep their membership and keep earning
    // off their own `archivedAt` — the cascade never touches it.
    if (role === 'SENIOR' || role === 'DROP') {
      const roleGenitive = role === 'SENIOR' ? 'синьора' : 'дропа'
      const teamPart = impact.teamName ? ` и его команда «${impact.teamName}»` : ''
      const projectNames = impact.projectNames ?? []
      return (
        <>
          <strong className="text-foreground">{entityName}</strong>
          {teamPart} — связанная пара, убрать по одному нельзя. Будут архивированы: профиль{' '}
          {roleGenitive}, команда и все её проекты ({impact.projectsCount ?? 0} шт.
          {projectNames.length > 0 ? `: ${projectNames.join(', ')}` : ''}). HR/бухгалтеры на команде
          ({impact.hrAccountantsToBeRemoved ?? 0}) и JUNIOR на этих проектах (
          {impact.juniorsAffected ?? 0}) остаются активными членами и продолжают получать оплату —
          архивация команды/проектов их не касается. Восстановление возможно — пара{' '}
          {role === 'SENIOR' ? 'senior' : 'drop'}
          +команда вернётся, но проекты восстанавливать отдельно.
        </>
      )
    }
    if (role === 'HR') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован и убран из{' '}
          <strong>{impact.teamsCount ?? 0} команд</strong> (HR-роль). Сами команды останутся
          активны.
        </>
      )
    }
    if (role === 'ACCOUNTANT') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован и убран из{' '}
          <strong>{impact.teamsCount ?? 0} команд</strong> (бухгалтерская роль). Сами команды
          останутся активны.
        </>
      )
    }
    if (role === 'JUNIOR') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован и убран из{' '}
          <strong>{impact.projectsCount ?? 0} активных проектов</strong>. Сами проекты останутся
          активны.
        </>
      )
    }
    if (role === 'ADMIN') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован. Связанных
          сущностей нет.
        </>
      )
    }
  }

  // task-archive-pending-modal (AC9): archiving a team means archiving the
  // paired senior/drop — third parties (HR/бухгалтеры on the team) keep
  // their membership and keep earning; the copy below says so explicitly
  // instead of the old "будут отвязаны".
  if (entityType === 'team' && impact.type === 'team') {
    const projectNames = impact.projectNames ?? []
    const projectNamesSuffix = projectNames.length > 0 ? `: ${projectNames.join(', ')}` : ''
    // Drop-archive round 2 (B3): branch by `teamType`. Drop-teams have a
    // *drop* as the paired entity (not a senior) — the senior, if any,
    // is detached without being archived. The legacy SENIOR copy renders
    // 1:1 when `teamType` is absent or 'SENIOR'.
    if (impact.teamType === 'DROP') {
      const dropName = impact.dropName?.trim() || '—'
      const seniorClause = impact.seniorWillBeDetached
        ? `Активный синьор${impact.seniorName ? ` ${impact.seniorName}` : ''} отцепится от команды без архивации.`
        : 'Активного синьора в команде нет.'
      return (
        <>
          Команда <strong className="text-foreground">{impact.teamName}</strong> и её дроп{' '}
          <strong>{dropName}</strong> — связанная пара, убрать по одному нельзя. При архивации будут
          архивированы: профиль <strong>дропа</strong>, команда и все её drop-проекты (
          {impact.projectsCount} шт.
          {projectNamesSuffix}). HR/бухгалтеры на команде ({impact.membersAffected}) остаются
          активными членами и продолжают получать оплату — архивация их не касается. {seniorClause}
        </>
      )
    }
    return (
      <>
        <strong className="text-foreground">{impact.teamName}</strong> и её синьор{' '}
        <strong>{impact.seniorName || '—'}</strong> — связанная пара, убрать по одному нельзя. При
        архивации будут архивированы: профиль синьора, команда и все его проекты (
        {impact.projectsCount} шт.
        {projectNamesSuffix}). HR/бухгалтеры на команде ({impact.membersAffected}) остаются
        активными членами и продолжают получать оплату — архивация их не касается. Это эквивалентно
        архивации {ROLE_RU.SENIOR} <strong>{impact.seniorName || '—'}</strong>.
      </>
    )
  }

  if (entityType === 'project' && impact.type === 'project') {
    return (
      <>
        Проект <strong className="text-foreground">{entityName}</strong> будет архивирован,{' '}
        <strong>{impact.activeMembersCount} активных джунов</strong> будут отвязаны. Синьор и
        команда <strong>не</strong> будут архивированы. Финансовая история (транзакции, инвойсы)
        остаётся доступной.
      </>
    )
  }

  return null
}

export function ArchiveConfirmDialog({
  entityType,
  entityId,
  entityName,
  // For team — confirmation phrase is the senior's (or drop's) name, not the team name.
  confirmName,
  onClose,
}: {
  entityType: EntityType
  entityId: string
  entityName: string
  confirmName?: string
  onClose: () => void
}) {
  const { data: impact, isLoading } = useArchiveImpact(entityType, entityId)
  const mutation = useArchiveEntity(entityType, entityId)
  const [typed, setTyped] = useState('')

  // Drop-archive round 2 (B3): team archive expects different confirm
  // names per team type — SENIOR teams ask for the senior name, DROP
  // teams ask for the drop name. Fall back to entityName when impact
  // hasn't loaded or the type isn't a team.
  const isDropTeam = entityType === 'team' && impact?.type === 'team' && impact.teamType === 'DROP'
  const expected =
    confirmName ??
    (entityType === 'team' && impact?.type === 'team'
      ? isDropTeam
        ? (impact.dropName ?? '')
        : impact.seniorName
      : entityName)

  const matches = typed.trim() === (expected ?? '').trim() && (expected ?? '').length > 0

  // Title for team archive — drop variant uses a tailored copy.
  const title =
    entityType === 'team' && isDropTeam ? 'Архивировать команду дропа' : TITLES[entityType]

  // Confirm-input prompt label — different by entity type + team variant.
  const confirmInputLabel =
    entityType === 'team'
      ? isDropTeam
        ? 'имя дропа'
        : 'имя синьора'
      : entityType === 'project'
        ? 'название проекта'
        : 'имя'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Подтверждение архивации. Введите имя для подтверждения действия.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <p className="text-muted-foreground">
                {renderImpactText(entityType, entityName, impact)}
              </p>
              {(impact?.type === 'user' || impact?.type === 'team') && (
                <ArchivePendingTransactionsList transactions={impact.pendingTransactions} />
              )}
            </>
          )}
          {expected && (
            <p>
              Для подтверждения введите {confirmInputLabel}:{' '}
              <strong className="text-foreground">{expected}</strong>
            </p>
          )}
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={expected}
            data-testid="archive-confirm-input"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || mutation.isPending}
            onClick={async () => {
              await mutation.mutateAsync()
              onClose()
            }}
            data-testid="archive-confirm-submit"
          >
            Архивировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
