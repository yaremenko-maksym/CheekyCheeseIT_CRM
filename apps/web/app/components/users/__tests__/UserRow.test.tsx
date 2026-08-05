/**
 * UserRow.test.tsx — code-review round 2 (task-candidate-card-resume).
 *
 * Pins the telegram-link behaviour after switching from an unvalidated
 * `href={`https://t.me/${user.telegram.replace(/^@/, '')}`}` to
 * `safeTelegramHref` (had zero prior coverage — golden rule #9 blast-radius
 * pin before/while changing an existing render path).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { UserProfileDto } from '@crm/shared'
import { UserRow } from '../UserRow'

// Stub TanStack Router Link — no router context available in unit tests.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, ...props }: { children?: ReactNode; to?: string }) => (
      <a href={props.to ?? '#'}>{children}</a>
    ),
  }
})

function makeUser(overrides: Partial<UserProfileDto> = {}): UserProfileDto {
  return {
    id: 'user-1',
    email: 'ivan@example.com',
    displayName: 'Иван Петров',
    avatarUrl: null,
    avatarDocumentId: null,
    role: 'SENIOR',
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    seniorSharePercent: 26,
    dropSharePercent: null,
    legalFullName: null,
    registrationAddress: null,
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function renderRow(user: UserProfileDto) {
  return render(
    <UserRow
      user={user}
      isSelf={false}
      onEdit={vi.fn()}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
    />,
  )
}

describe('UserRow — telegram link (code-review round 2)', () => {
  it('valid handle renders as a clickable https://t.me/ link', () => {
    renderRow(makeUser({ telegram: '@armghyan' }))
    const link = screen.getByText('@armghyan').closest('a')
    expect(link).toHaveAttribute('href', 'https://t.me/armghyan')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('invalid telegram value stays plain, non-clickable text', () => {
    renderRow(makeUser({ telegram: 'not a real handle!!' }))
    const text = screen.getByText('not a real handle!!')
    expect(text.closest('a')).toBeNull()
  })

  it('renders no t.me link when telegram is null', () => {
    renderRow(makeUser({ telegram: null }))
    expect(document.querySelector('a[href^="https://t.me/"]')).toBeNull()
  })
})
