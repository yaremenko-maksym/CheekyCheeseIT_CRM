import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useArchiveImpact, useArchiveEntity, type EntityType } from '@/hooks/use-archive'
import type { ArchiveImpact } from '@crm/shared'

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
    if (role === 'SENIOR') {
      const teamPart = impact.teamName ? ` и его команда «${impact.teamName}»` : ''
      return (
        <>
          <strong className="text-foreground">{entityName}</strong>
          {teamPart} — связанная пара. Будут архивированы: профиль синьора, команда (
          {impact.hrAccountantsToBeRemoved ?? 0} HR/бухгалтеров будут отвязаны), и все его проекты (
          {impact.projectsCount ?? 0} шт., {impact.juniorsAffected ?? 0} активных джунов будут
          отвязаны). Восстановление возможно — пара синьор+команда вернётся, но проекты
          восстанавливать отдельно.
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

  if (entityType === 'team' && impact.type === 'team') {
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
          <strong>{dropName}</strong> — связанная пара. При архивации будут архивированы: профиль{' '}
          <strong>дропа</strong>, команда (HR/бухгалтер будут отвязаны — {impact.membersAffected}),
          и все его drop-проекты ({impact.projectsCount} шт.). {seniorClause}
        </>
      )
    }
    return (
      <>
        <strong className="text-foreground">{impact.teamName}</strong> и её синьор{' '}
        <strong>{impact.seniorName || '—'}</strong> — связанная пара. При архивации будут
        архивированы: профиль синьора, команда (HR/бухгалтеры будут отвязаны —{' '}
        {impact.membersAffected}), и все его проекты ({impact.projectsCount} шт.). Это эквивалентно
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
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <p className="text-muted-foreground">
              {renderImpactText(entityType, entityName, impact)}
            </p>
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
