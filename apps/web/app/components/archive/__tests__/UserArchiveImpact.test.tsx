/**
 * task-i18n-stage3b (Task 2 / PR2), Step 1. `UserArchiveImpact` is the
 * single source of "what archiving this person changes" copy, rendered by
 * `components/archive/ArchiveConfirmDialog` (entityType='user'),
 * `components/users/ArchiveUserConfirmDialog` and
 * `user-profile/admin-actions/ArchiveUserDialog`. Covers all six roles,
 * both locales, and the deferred copy fixes COPY-L-31/L-32.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ArchiveImpact } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UserArchiveImpact } from '../UserArchiveImpact'

type UserImpact = Extract<ArchiveImpact, { type: 'user' }>
const base = { type: 'user' as const, pendingTransactions: [] }

const cases: Array<[string, UserImpact]> = [
  [
    'archive-warning-senior',
    {
      ...base,
      role: 'SENIOR',
      teamName: 'Alpha',
      projectsCount: 2,
      projectNames: ['P1', 'P2'],
      hrAccountantsOnTeam: 1,
      juniorsAffected: 3,
    },
  ],
  ['archive-warning-senior', { ...base, role: 'DROP', teamName: null, projectsCount: 1 }],
  ['archive-warning-hr', { ...base, role: 'HR', teamsCount: 5 }],
  ['archive-warning-accountant', { ...base, role: 'ACCOUNTANT', teamsCount: 1 }],
  ['archive-warning-junior', { ...base, role: 'JUNIOR', projectsCount: 2 }],
  ['archive-warning-admin', { ...base, role: 'ADMIN' }],
]

describe('UserArchiveImpact', () => {
  it.each(cases)(
    '%s renders for role, keeps the name testid, no raw enum or jargon',
    async (testId, impact) => {
      for (const locale of ['uk', 'en'] as const) {
        await loadCatalog(locale)
        const { unmount } = render(
          <UserArchiveImpact entityName="Олена Коваль" impact={impact} />,
          {
            wrapper: I18nTestProvider,
          },
        )
        const block = screen.getByTestId(testId)
        expect(screen.getByTestId('archive-confirm-user-name')).toHaveTextContent('Олена Коваль')
        expect(block.textContent).not.toMatch(
          /\b(SENIOR|JUNIOR|ACCOUNTANT|DROP|ADMIN)\b|senior\+team|cascade/,
        )
        unmount()
      }
    },
  )

  it('COPY-L-32: uk text never agrees with the person’s gender (no «архівований»/«архівована»)', async () => {
    await loadCatalog('uk')
    for (const [, impact] of cases) {
      const { container, unmount } = render(
        <UserArchiveImpact entityName="Олена" impact={impact} />,
        {
          wrapper: I18nTestProvider,
        },
      )
      expect(container.textContent).not.toMatch(/архівован(ий|а)/)
      unmount()
    }
  })

  it('COPY-L-31: the SENIOR/DROP branch without a team still says it can be restored', async () => {
    await loadCatalog('uk')
    render(<UserArchiveImpact entityName="Олена" impact={cases[1]![1]} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByTestId('archive-warning-senior')).toHaveTextContent('Відновлення можливе')
  })

  it('SENIOR/DROP without a team: exact text, distinct from the with-team branch (mutation-gate round)', async () => {
    // Pins the no-team branch byte-for-byte: catches the `projectNames ?? []`
    // ArrayDeclaration default, the `!impact.teamName` guard being forced
    // false/emptied (which would fall through to the WITH-team text even
    // though teamName is null), the `projectsCount ?? 0` LogicalOperator
    // inside the Plural, and the joining `{' '}` between the two <Trans>
    // nodes (a `toHaveTextContent` substring check would miss all of these
    // — only an exact, normalized-whitespace comparison catches them).
    await loadCatalog('uk')
    render(
      <UserArchiveImpact
        entityName="Олена"
        impact={{ ...base, role: 'DROP', teamName: null, projectsCount: 1 }}
      />,
      { wrapper: I18nTestProvider },
    )
    const block = screen.getByTestId('archive-warning-senior')
    const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim()
    expect(text).toBe(
      'В архів піде профіль Олена разом з усіма проєктами (1 проєкт). ' +
        'Профіль більше не зможе увійти в CRM. ' +
        'Відновлення можливе — профіль повернеться, але проєкти відновлювати окремо.',
    )
  })

  it('SENIOR with a team: exact text, distinct branch, project-names suffix, genitive plurals', async () => {
    await loadCatalog('uk')
    render(
      <UserArchiveImpact
        entityName="Олена"
        impact={{
          ...base,
          role: 'SENIOR',
          teamName: 'Alpha',
          projectsCount: 2,
          projectNames: ['P1', 'P2'],
          hrAccountantsOnTeam: 1,
          juniorsAffected: 3,
        }}
      />,
      { wrapper: I18nTestProvider },
    )
    const block = screen.getByTestId('archive-warning-senior')
    const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim()
    expect(text).toBe(
      'Олена та команда «Alpha» — пов’язана пара, прибрати по одному не можна. ' +
        'В архів підуть: профіль сеньйора, команда і всі її проєкти (2 проєкти: P1, P2). ' +
        'Профіль більше не зможе увійти в CRM. ' +
        'У команді 1 HR/бухгалтер, на її проєктах — 3 джуніори: їхні профілі залишаються активними, ' +
        'оплату вони отримують як і раніше. ' +
        'Після відновлення HR/бухгалтерів доведеться додати в команду заново. ' +
        'Відновлення можливе — пара «сеньйор+команда» повернеться, але проєкти відновлювати окремо.',
    )
  })

  it('HR/ACCOUNTANT/JUNIOR/ADMIN: each branch is role-unique, not confusable with a neighbour (mutation-gate round)', async () => {
    // mutation-gate survivors: the ACCOUNTANT guard's `'ACCOUNTANT'` literal
    // forced to `''`/its condition forced `false`/its block emptied all fall
    // through to the next `if` (JUNIOR) or the ADMIN fallback; the JUNIOR
    // guard forced `true` renders JUNIOR text even for ADMIN. A per-role
    // UNIQUE substring, checked on every OTHER role's output too, catches
    // every one of these branch-confusion mutants at once.
    await loadCatalog('uk')
    const rows: Array<[UserImpact, string]> = [
      [{ ...base, role: 'HR', teamsCount: 3 }, '(роль HR)'],
      [{ ...base, role: 'ACCOUNTANT', teamsCount: 3 }, '(роль бухгалтера)'],
      [{ ...base, role: 'JUNIOR', projectsCount: 2 }, 'Самі проєкти залишаться активними'],
      [{ ...base, role: 'ADMIN' }, 'Нічого пов’язаного архівувати не треба'],
    ]
    for (const [impact, unique] of rows) {
      const { container, unmount } = render(
        <UserArchiveImpact entityName="Олена" impact={impact} />,
        { wrapper: I18nTestProvider },
      )
      expect(container.textContent).toContain(unique)
      for (const [, otherUnique] of rows) {
        if (otherUnique === unique) continue
        expect(container.textContent).not.toContain(otherUnique)
      }
      unmount()
    }
  })

  it('HR: exact text, including the joining space and the teamsCount plural value', async () => {
    // mutation-gate survivors: the `{' '}` between "прибрано з" and the
    // <strong>/<Plural> element, the one CLOSING the </strong>, and the
    // `teamsCount ?? 0` LogicalOperator inside the Plural (a `&&` mutant
    // turns a truthy 3 into 0 — "few"/"many" share the SAME uk word
    // "команд", so only the exact NUMBER distinguishes them).
    await loadCatalog('uk')
    render(
      <UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'HR', teamsCount: 3 }} />,
      {
        wrapper: I18nTestProvider,
      },
    )
    const text = (screen.getByTestId('archive-warning-hr').textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    expect(text).toBe(
      'В архів піде профіль Олена; його буде прибрано з 3 команд (роль HR). Самі команди ' +
        'залишаться активними. Профіль більше не зможе увійти в CRM. ' +
        'Профіль можна відновити з архіву.',
    )
  })

  it('ACCOUNTANT: exact text, including the joining space and the teamsCount plural value', async () => {
    await loadCatalog('uk')
    render(
      <UserArchiveImpact
        entityName="Олена"
        impact={{ ...base, role: 'ACCOUNTANT', teamsCount: 3 }}
      />,
      { wrapper: I18nTestProvider },
    )
    const text = (screen.getByTestId('archive-warning-accountant').textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    expect(text).toBe(
      'В архів піде профіль Олена; його буде прибрано з 3 команд (роль бухгалтера). Самі команди ' +
        'залишаться активними. Профіль більше не зможе увійти в CRM. ' +
        'Профіль можна відновити з архіву.',
    )
  })

  it('JUNIOR: exact text, including the joining space before "Профіль можна відновити"', async () => {
    // CI Mutation Gate (@crm/web) survivor round B: the `{' '}` between this
    // branch's own Trans and the trailing restore-sentence Trans was added
    // by round B (COPY-M-3) but never covered by an exact-text assertion —
    // only HR/ACCOUNTANT got one in round A, since those branches existed
    // before round B's trailing sentence was added to JUNIOR/ADMIN too.
    await loadCatalog('uk')
    render(
      <UserArchiveImpact
        entityName="Олена"
        impact={{ ...base, role: 'JUNIOR', projectsCount: 2 }}
      />,
      { wrapper: I18nTestProvider },
    )
    const text = (screen.getByTestId('archive-warning-junior').textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    expect(text).toBe(
      'В архів піде профіль Олена; його буде прибрано з 2 активних проєктів. Самі проєкти ' +
        'залишаться активними. Профіль більше не зможе увійти в CRM. ' +
        'Профіль можна відновити з архіву.',
    )
  })

  it('ADMIN: exact text, including the joining space before "Профіль можна відновити"', async () => {
    // Same CI survivor class as the JUNIOR test above, for the ADMIN branch.
    await loadCatalog('uk')
    render(<UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'ADMIN' }} />, {
      wrapper: I18nTestProvider,
    })
    const text = (screen.getByTestId('archive-warning-admin').textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    expect(text).toBe(
      'В архів піде профіль Олена. Нічого пов’язаного архівувати не треба. ' +
        'Профіль більше не зможе увійти в CRM. Профіль можна відновити з архіву.',
    )
  })

  it('HR/JUNIOR counts after «з» are genitive in uk (1 команди, 5 команд, 2 активних проєктів)', async () => {
    await loadCatalog('uk')
    const { rerender } = render(
      <UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'HR', teamsCount: 1 }} />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('archive-warning-hr')).toHaveTextContent('з 1 команди')
    rerender(
      <UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'HR', teamsCount: 5 }} />,
    )
    expect(screen.getByTestId('archive-warning-hr')).toHaveTextContent('з 5 команд')
    rerender(
      <UserArchiveImpact
        entityName="Олена"
        impact={{ ...base, role: 'JUNIOR', projectsCount: 2 }}
      />,
    )
    expect(screen.getByTestId('archive-warning-junior')).toHaveTextContent('з 2 активних проєктів')
  })
})
