import { useState } from 'react'
import { msg, select } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
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
import { useArchiveImpact, useArchiveEntity, type EntityType } from '@/hooks/use-archive'
import type { ArchiveImpact } from '@crm/shared'
import { ArchivePendingTransactionsList } from '@/components/archive/ArchivePendingTransactionsList'

/**
 * Per-entity dialog titles. The team variant has a drop-team sibling that
 * uses a different title — see `getTeamTitle` below.
 */
const TITLE_MESSAGES: Record<EntityType, MessageDescriptor> = {
  user: msg`Архівувати користувача`,
  team: msg`Архівувати команду`,
  project: msg`Архівувати проєкт`,
}

// task-i18n-stage3a (Task 1), Step 6, fix-round 1 (SPEC-H-2): the old
// `ROLE_RU: Record<string, string>` had no `DROP` entry — a call site
// keying it by a live `role` value would silently fall through to
// `undefined` for DROP, or (worse) another call site could copy-paste
// `.SENIOR` and read the SENIOR word for a DROP entity. Removed; each
// call site below picks its own word directly via `select()`, so DROP
// gets its OWN form rather than borrowing SENIOR's.

/**
 * Builds the role-aware warning text shown above the confirmation input.
 * Numbers (N, M, K) come from `GET /<entity>s/:id/archive-impact`.
 */
function renderImpactText(
  entityType: EntityType,
  entityName: string,
  impact: ArchiveImpact | undefined,
): React.ReactNode {
  if (!impact)
    return (
      <span className="text-muted-foreground">
        <Trans>Рахуємо, що зміниться…</Trans>
      </span>
    )

  if (entityType === 'user' && impact.type === 'user') {
    const role = impact.role
    // task-archive-pending-modal (AC7/AC9, owner decision 2026-08-19): SENIOR
    // and DROP cascade команда+проекты as one operation; HR/ACCOUNTANT on the
    // team and JUNIOR on the projects keep their membership and keep earning
    // off their own `archivedAt` — the cascade never touches it.
    if (role === 'SENIOR' || role === 'DROP') {
      // Template E (select, 2 variants used inline — no `other` reachable
      // through this guard, but the macro's signature still requires one).
      // Stryker disable next-line ObjectLiteral: Lingui's babel macro needs
      // this options object to stay a literal it can statically read at
      // compile time — replacing it with `{}` (the ObjectLiteral mutator)
      // makes the macro transform itself throw ("props is not iterable"),
      // failing BEFORE any test runs. Not a coverage gap — the mutation is
      // unrepresentable for this macro's call shape (same reasoning as
      // DropDashboard.tsx's plural() call).
      const roleGenitive = select(role, {
        SENIOR: 'сеньйора',
        DROP: 'дропа',
        other: 'співробітника',
      })
      // Stryker disable next-line ObjectLiteral: same reasoning as above.
      const pairWord = select(role, { SENIOR: 'сеньйор', DROP: 'дроп', other: 'співробітник' })
      const projectNames = impact.projectNames ?? []
      return (
        <>
          <Trans>
            <strong className="text-foreground">{entityName}</strong>
            {impact.teamName ? (
              <>
                {' '}
                та команда «<strong>{impact.teamName}</strong>»
              </>
            ) : null}{' '}
            — пов'язана пара, прибрати по одному не можна. Будуть архівовані: профіль {roleGenitive}
            , команда і всі її проєкти (
            <Plural
              value={impact.projectsCount ?? 0}
              one="# проєкт"
              few="# проєкти"
              many="# проєктів"
              other="# проєктів"
            />
            {projectNames.length > 0 ? `: ${projectNames.join(', ')}` : ''}
            ).
          </Trans>{' '}
          <Trans>
            HR/бухгалтери в команді (
            <Plural
              value={impact.hrAccountantsOnTeam ?? 0}
              one="# HR/бухгалтер"
              few="# HR/бухгалтери"
              many="# HR/бухгалтерів"
              other="# HR/бухгалтерів"
            />
            ) і джуніори на цих проєктах (
            <Plural
              value={impact.juniorsAffected ?? 0}
              one="# джуніор"
              few="# джуніори"
              many="# джуніорів"
              other="# джуніорів"
            />
            ) залишаються активними учасниками і продовжують отримувати оплату — архівація
            команди/проєктів їх не стосується.
          </Trans>{' '}
          <Trans>
            Відновлення можливе — пара «{pairWord}+команда» повернеться, але проєкти відновлювати
            окремо.
          </Trans>
        </>
      )
    }
    if (role === 'HR') {
      return (
        <Trans>
          <strong className="text-foreground">{entityName}</strong> буде архівований і прибраний з{' '}
          <strong>
            <Plural
              value={impact.teamsCount ?? 0}
              one="# команда"
              few="# команди"
              many="# команд"
              other="# команд"
            />
          </strong>{' '}
          (роль HR). Самі команди залишаться активними.
        </Trans>
      )
    }
    if (role === 'ACCOUNTANT') {
      return (
        <Trans>
          <strong className="text-foreground">{entityName}</strong> буде архівований і прибраний з{' '}
          <strong>
            <Plural
              value={impact.teamsCount ?? 0}
              one="# команда"
              few="# команди"
              many="# команд"
              other="# команд"
            />
          </strong>{' '}
          (бухгалтерська роль). Самі команди залишаться активними.
        </Trans>
      )
    }
    if (role === 'JUNIOR') {
      return (
        <Trans>
          <strong className="text-foreground">{entityName}</strong> буде архівований і прибраний з{' '}
          <strong>
            <Plural
              value={impact.projectsCount ?? 0}
              one="# активний проєкт"
              few="# активні проєкти"
              many="# активних проєктів"
              other="# активних проєктів"
            />
          </strong>
          . Самі проєкти залишаться активними.
        </Trans>
      )
    }
    if (role === 'ADMIN') {
      return (
        <Trans>
          <strong className="text-foreground">{entityName}</strong> буде архівований. Нічого
          пов'язаного архівувати не треба.
        </Trans>
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
      return (
        <>
          <Trans>
            Команда <strong className="text-foreground">{impact.teamName}</strong> і її дроп{' '}
            <strong>{dropName}</strong> — пов'язана пара, прибрати по одному не можна. В архів
            підуть: профіль <strong>дропа</strong>, команда і всі її drop-проєкти (
            <Plural
              value={impact.projectsCount}
              one="# проєкт"
              few="# проєкти"
              many="# проєктів"
              other="# проєктів"
            />
            {projectNamesSuffix}).
          </Trans>{' '}
          <Trans>
            HR/бухгалтери в команді (
            <Plural
              value={impact.membersAffected}
              one="# HR/бухгалтер"
              few="# HR/бухгалтери"
              many="# HR/бухгалтерів"
              other="# HR/бухгалтерів"
            />
            ) залишаються активними учасниками і продовжують отримувати оплату — архівація їх не
            стосується.
          </Trans>{' '}
          {impact.seniorWillBeDetached ? (
            <Trans>
              Активний сеньйор{impact.seniorName ? ` ${impact.seniorName}` : ''} від'єднається від
              команди без архівації
            </Trans>
          ) : (
            <Trans>Активного сеньйора в команді немає.</Trans>
          )}
        </>
      )
    }
    return (
      <>
        <Trans>
          <strong className="text-foreground">{impact.teamName}</strong> і її сеньйор{' '}
          <strong>{impact.seniorName || '—'}</strong> — пов'язана пара, прибрати по одному не можна.
          В архів підуть: профіль сеньйора, команда і всі його проєкти (
          <Plural
            value={impact.projectsCount}
            one="# проєкт"
            few="# проєкти"
            many="# проєктів"
            other="# проєктів"
          />
          {projectNamesSuffix}).
        </Trans>{' '}
        <Trans>
          HR/бухгалтери в команді (
          <Plural
            value={impact.membersAffected}
            one="# HR/бухгалтер"
            few="# HR/бухгалтери"
            many="# HR/бухгалтерів"
            other="# HR/бухгалтерів"
          />
          ) залишаються активними учасниками і продовжують отримувати оплату — архівація їх не
          стосується. Це еквівалентно архівації сеньйора <strong>{impact.seniorName || '—'}</strong>
          .
        </Trans>
      </>
    )
  }

  if (entityType === 'project' && impact.type === 'project') {
    return (
      <Trans>
        Проєкт <strong className="text-foreground">{entityName}</strong> буде архівований,{' '}
        <strong>
          <Plural
            value={impact.activeMembersCount}
            one="# активний джуніор"
            few="# активні джуніори"
            many="# активних джуніорів"
            other="# активних джуніорів"
          />
        </strong>{' '}
        будуть відв'язані. Сеньйор і команда <strong>не</strong> будуть архівовані. Фінансова
        історія (транзакції, інвойси) залишається доступною.
      </Trans>
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
  const { t, i18n } = useLingui()
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
    entityType === 'team' && isDropTeam
      ? t`Архівувати команду дропа`
      : i18n._(TITLE_MESSAGES[entityType])

  // Confirm-input prompt label — different by entity type + team variant.
  const confirmInputLabel =
    entityType === 'team'
      ? isDropTeam
        ? t`ім'я дропа`
        : t`ім'я сеньйора`
      : entityType === 'project'
        ? t`назва проєкту`
        : t`ім'я`

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* task-archive-pending-modal (round 2, design fidelity BLOCK): the
          original bare DialogContent had no max-height/overflow-y-auto, so
          on 320/375 with a real PENDING+cascade payload the dialog grew
          taller than the viewport with nothing to scroll it — header, close
          button, and (worst case) both footer buttons went off-screen.
          maxWidth="sm:max-w-lg" keeps this dialog's ORIGINAL width (the
          generic DialogContent's unconditional max-w-lg) — only the
          height/scroll behaviour changes here. */}
      <CrmDialogContent maxWidth="sm:max-w-lg">
        <CrmDialogHeader>
          <DialogTitle className="text-destructive">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Підтвердження архівації. Введіть ім'я для підтвердження дії.</Trans>
          </DialogDescription>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
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
                <Trans>Для підтвердження введіть {confirmInputLabel}:</Trans>{' '}
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
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <Trans>Скасувати</Trans>
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
            <Trans>Архівувати</Trans>
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
