import type { ArchiveImpact } from '@crm/shared'
import { select } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'

type UserImpact = Extract<ArchiveImpact, { type: 'user' }>

const TESTID_BY_ROLE: Record<UserImpact['role'], string> = {
  SENIOR: 'archive-warning-senior',
  DROP: 'archive-warning-senior',
  HR: 'archive-warning-hr',
  ACCOUNTANT: 'archive-warning-accountant',
  JUNIOR: 'archive-warning-junior',
  ADMIN: 'archive-warning-admin',
}

/** Single source of the "what archiving this person changes" copy — rendered by
 *  `components/archive/ArchiveConfirmDialog` (entityType='user'),
 *  `components/users/ArchiveUserConfirmDialog` and
 *  `user-profile/admin-actions/ArchiveUserDialog`. Gender-neutral by construction
 *  (the subject is «профіль», COPY-L-32). */
export function UserArchiveImpact({
  entityName,
  impact,
}: {
  entityName: string
  impact: UserImpact
}) {
  return <div data-testid={TESTID_BY_ROLE[impact.role]}>{renderBody(entityName, impact)}</div>
}

/** Inside <Trans> this becomes a numbered component slot (<0>…</0>), so the name keeps
 *  its markup and testid in every locale without being glued outside the sentence. */
function Name({ children }: { children: React.ReactNode }) {
  return (
    <strong className="text-foreground" data-testid="archive-confirm-user-name">
      {children}
    </strong>
  )
}

function renderBody(entityName: string, impact: UserImpact): React.ReactNode {
  const projectNames = impact.projectNames ?? []
  const namesSuffix = projectNames.length > 0 ? `: ${projectNames.join(', ')}` : ''

  if (impact.role === 'SENIOR' || impact.role === 'DROP') {
    if (!impact.teamName) {
      return (
        <>
          <Trans>
            В архів піде профіль <Name>{entityName}</Name> разом з усіма проєктами (
            <Plural
              value={impact.projectsCount ?? 0}
              one="# проєкт"
              few="# проєкти"
              many="# проєктів"
              other="# проєкту"
            />
            {namesSuffix}). Профіль більше не зможе увійти в CRM.
          </Trans>{' '}
          <Trans>Відновлення можливе — профіль повернеться, але проєкти відновлювати окремо.</Trans>
        </>
      )
    }
    // Stryker disable next-line ObjectLiteral,StringLiteral: Lingui's select() macro must read this options object as a literal at compile time (the `{}` mutant makes the transform throw before any test runs); `other` is unreachable inside the SENIOR|DROP guard
    const roleGenitive = select(impact.role, {
      SENIOR: 'сеньйора',
      DROP: 'дропа',
      // Stryker disable next-line StringLiteral: `other` is unreachable inside the SENIOR|DROP guard above — see the ObjectLiteral disable comment two lines up (a multi-line object literal needs its own per-line disable; "next-line" does not cascade past the opening `{`)
      other: 'співробітника',
    })
    // Stryker disable next-line ObjectLiteral,StringLiteral: same literal-options requirement and the same unreachable `other` as roleGenitive above
    const pairWord = select(impact.role, { SENIOR: 'сеньйор', DROP: 'дроп', other: 'співробітник' })
    return (
      <>
        <Trans>
          <Name>{entityName}</Name> та команда «<strong>{impact.teamName}</strong>» — пов’язана
          пара, прибрати по одному не можна. В архів підуть: профіль {roleGenitive}, команда і всі
          її проєкти (
          <Plural
            value={impact.projectsCount ?? 0}
            one="# проєкт"
            few="# проєкти"
            many="# проєктів"
            other="# проєкту"
          />
          {namesSuffix}). Профіль більше не зможе увійти в CRM.
        </Trans>{' '}
        <Trans>
          У команді{' '}
          <Plural
            value={impact.hrAccountantsOnTeam ?? 0}
            one="# HR/бухгалтер"
            few="# HR/бухгалтери"
            many="# HR/бухгалтерів"
            other="# HR/бухгалтера"
          />
          , на її проєктах —{' '}
          <Plural
            value={impact.juniorsAffected ?? 0}
            one="# джуніор"
            few="# джуніори"
            many="# джуніорів"
            other="# джуніора"
          />
          : їхні профілі залишаються активними, оплату вони отримують як і раніше. Після відновлення
          HR/бухгалтерів доведеться додати в команду заново.
        </Trans>{' '}
        <Trans>
          Відновлення можливе — пара «{pairWord}+команда» повернеться, але проєкти відновлювати
          окремо.
        </Trans>
      </>
    )
  }

  if (impact.role === 'HR') {
    return (
      <>
        <Trans>
          В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
          <strong>
            <Plural
              value={impact.teamsCount ?? 0}
              one="# команди"
              few="# команд"
              many="# команд"
              other="# команди"
            />
          </strong>{' '}
          (роль HR). Самі команди залишаться активними. Профіль більше не зможе увійти в CRM.
        </Trans>{' '}
        <Trans>Профіль можна відновити з архіву.</Trans>
      </>
    )
  }

  if (impact.role === 'ACCOUNTANT') {
    return (
      <>
        <Trans>
          В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
          <strong>
            <Plural
              value={impact.teamsCount ?? 0}
              one="# команди"
              few="# команд"
              many="# команд"
              other="# команди"
            />
          </strong>{' '}
          (роль бухгалтера). Самі команди залишаться активними. Профіль більше не зможе увійти в
          CRM.
        </Trans>{' '}
        <Trans>Профіль можна відновити з архіву.</Trans>
      </>
    )
  }

  if (impact.role === 'JUNIOR') {
    return (
      <>
        <Trans>
          В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
          <strong>
            <Plural
              value={impact.projectsCount ?? 0}
              one="# активного проєкту"
              few="# активних проєктів"
              many="# активних проєктів"
              other="# активного проєкту"
            />
          </strong>
          . Самі проєкти залишаться активними. Профіль більше не зможе увійти в CRM.
        </Trans>{' '}
        <Trans>Профіль можна відновити з архіву.</Trans>
      </>
    )
  }

  // ADMIN — the only remaining member of the role union.
  return (
    <>
      <Trans>
        В архів піде профіль <Name>{entityName}</Name>. Нічого пов’язаного архівувати не треба.
        Профіль більше не зможе увійти в CRM.
      </Trans>{' '}
      <Trans>Профіль можна відновити з архіву.</Trans>
    </>
  )
}
