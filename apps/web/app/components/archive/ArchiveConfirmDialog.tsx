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
          {impact.hrAccountantsToBeRemoved ?? 0} HR/бухгалтеров будут отвязаны), и все его
          проекты ({impact.projectsCount ?? 0} шт., {impact.juniorsAffected ?? 0} активных
          джунов будут отвязаны). Восстановление возможно — пара синьор+команда вернётся,
          но проекты восстанавливать отдельно.
        </>
      )
    }
    if (role === 'HR') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован и
          убран из <strong>{impact.teamsCount ?? 0} команд</strong> (HR-роль). Сами
          команды останутся активны.
        </>
      )
    }
    if (role === 'ACCOUNTANT') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован и
          убран из <strong>{impact.teamsCount ?? 0} команд</strong> (бухгалтерская роль).
          Сами команды останутся активны.
        </>
      )
    }
    if (role === 'JUNIOR') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован и
          убран из <strong>{impact.projectsCount ?? 0} активных проектов</strong>. Сами
          проекты останутся активны.
        </>
      )
    }
    if (role === 'ADMIN') {
      return (
        <>
          <strong className="text-foreground">{entityName}</strong> будет архивирован.
          Связанных сущностей нет.
        </>
      )
    }
  }

  if (entityType === 'team' && impact.type === 'team') {
    return (
      <>
        <strong className="text-foreground">{impact.teamName}</strong> и её синьор{' '}
        <strong>{impact.seniorName || '—'}</strong> — связанная пара. При архивации будут
        архивированы: профиль синьора, команда (HR/бухгалтеры будут отвязаны —{' '}
        {impact.membersAffected}), и все его проекты ({impact.projectsCount} шт.). Это
        эквивалентно архивации {ROLE_RU.SENIOR}{' '}
        <strong>{impact.seniorName || '—'}</strong>.
      </>
    )
  }

  if (entityType === 'project' && impact.type === 'project') {
    return (
      <>
        Проект <strong className="text-foreground">{entityName}</strong> будет архивирован,{' '}
        <strong>{impact.activeMembersCount} активных джунов</strong> будут отвязаны. Синьор
        и команда <strong>не</strong> будут архивированы. Финансовая история (транзакции,
        инвойсы) остаётся доступной.
      </>
    )
  }

  return null
}

export function ArchiveConfirmDialog({
  entityType,
  entityId,
  entityName,
  // For team — confirmation phrase is the senior's name, not the team name.
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

  // For team archive — backend returns seniorName; we ask user to type SENIOR name.
  const expected =
    confirmName ??
    (entityType === 'team' && impact?.type === 'team' ? impact.seniorName : entityName)

  const matches = typed.trim() === (expected ?? '').trim() && (expected ?? '').length > 0

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">{TITLES[entityType]}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <p className="text-muted-foreground">{renderImpactText(entityType, entityName, impact)}</p>
          )}
          {expected && (
            <p>
              Для подтверждения введите{' '}
              {entityType === 'team' ? 'имя синьора' : entityType === 'project' ? 'название проекта' : 'имя'}:{' '}
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
