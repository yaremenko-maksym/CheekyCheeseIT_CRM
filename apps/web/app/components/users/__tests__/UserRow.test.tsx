/**
 * UserRow.test.tsx — code-review round 2 (task-candidate-card-resume).
 *
 * Pins the telegram-link behaviour after switching from an unvalidated
 * `href={`https://t.me/${user.telegram.replace(/^@/, '')}`}` to
 * `safeTelegramHref` (had zero prior coverage — golden rule #9 blast-radius
 * pin before/while changing an existing render path).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import type { UserProfileDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UserRow } from '../UserRow'

// Stub TanStack Router Link — no router context available in unit tests.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      params: _params,
      ...rest
    }: {
      children?: ReactNode
      to?: string
      params?: unknown
      'aria-label'?: string
      className?: string
    }) => (
      <a href={to ?? '#'} {...rest}>
        {children}
      </a>
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
    { wrapper: I18nTestProvider },
  )
}

describe('UserRow — telegram link (code-review round 2)', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  // Queried by role rather than by walking up from the text with `closest('a')`
  // (task-lint-teeth). `getByRole('link', { name })` asserts the same thing —
  // this handle IS a link — and asserts it the way a user and a screen reader
  // encounter it, instead of via DOM ancestry that a markup refactor can shift
  // without changing behaviour.
  it('valid handle renders as a clickable https://t.me/ link', () => {
    renderRow(makeUser({ telegram: '@armghyan' }))
    const link = screen.getByRole('link', { name: '@armghyan' })
    expect(link).toHaveAttribute('href', 'https://t.me/armghyan')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('invalid telegram value stays plain, non-clickable text', () => {
    renderRow(makeUser({ telegram: 'not a real handle!!' }))
    expect(screen.getByText('not a real handle!!')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'not a real handle!!' })).toBeNull()
  })

  it('renders no t.me link when telegram is null', () => {
    renderRow(makeUser({ telegram: null }))
    expect(
      screen
        .queryAllByRole('link')
        .filter((a) => a.getAttribute('href')?.startsWith('https://t.me/')),
    ).toHaveLength(0)
  })
})

describe('UserRow — aria-labels, titles, role badge variant (task-i18n-stage3b PR2)', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('the profile link carries the display name in its aria-label', () => {
    renderRow(makeUser({ displayName: 'Иван Петров' }))
    expect(screen.getByRole('link', { name: 'Відкрити профіль Иван Петров' })).toBeInTheDocument()
  })

  it('edit button has the "Редагувати {name}" aria-label and title (COPY-M-5: screen reader needs the name)', () => {
    renderRow(makeUser())
    const btn = screen.getByTestId('user-row-edit-user-1')
    expect(btn).toHaveAttribute('aria-label', 'Редагувати Иван Петров')
    expect(btn).toHaveAttribute('title', 'Редагувати Иван Петров')
  })

  it('archive button: "Архівувати {name}" for another user, "Не можна архівувати себе" for self', () => {
    const { unmount } = render(
      <UserRow
        user={makeUser()}
        isSelf={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
      { wrapper: I18nTestProvider },
    )
    const other = screen.getByTestId('user-row-archive-user-1')
    expect(other).toHaveAttribute('aria-label', 'Архівувати Иван Петров')
    expect(other).toHaveAttribute('title', 'Архівувати Иван Петров')
    unmount()

    render(
      <UserRow
        user={makeUser()}
        isSelf={true}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
      { wrapper: I18nTestProvider },
    )
    const self = screen.getByTestId('user-row-archive-user-1')
    expect(self).toHaveAttribute('aria-label', 'Не можна архівувати себе')
    expect(self).toHaveAttribute('title', 'Не можна архівувати себе')
  })

  it('role badge uses the role-specific variant class, not the "outline" fallback', () => {
    renderRow(makeUser({ role: 'SENIOR' }))
    // ROLE_VARIANT['SENIOR'] ?? 'outline' — SENIOR is a defined key, so the
    // real 'senior' variant (blue) must win over the 'outline' fallback
    // (text-foreground/border-border) a `??`→`&&` mutant would substitute.
    const badge = screen.getByText('Сеньйор')
    expect(badge.className).toContain('bg-blue-500/15')
    expect(badge.className).not.toContain('border-border')
  })
})
