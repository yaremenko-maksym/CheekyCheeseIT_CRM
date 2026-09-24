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
