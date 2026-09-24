/**
 * UserProfileHeader.test.tsx — code-review round 2 (task-candidate-card-resume).
 *
 * Pins the telegram-link behaviour after switching from an unvalidated
 * `href={`https://t.me/${user.telegram.replace(/^@/, '')}`}` to
 * `safeTelegramHref` (had zero prior coverage — golden rule #9 blast-radius
 * pin before/while changing an existing render path).
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { UserProfileDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UserProfileHeader } from '../UserProfileHeader'

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

beforeEach(() => loadCatalog('uk'))

// RAW_ROLE — task-i18n-stage3b (Task 1), Step 2: after the role badge moves
// off the legacy `ROLE_LABELS` map onto `ROLE_LABEL_MESSAGES`, this asserts
// no consumer of `UserProfileHeader` can leak the raw `Role` enum into the
// rendered screen on either locale.
const RAW_ROLE = /\b(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)\b/

describe('role badge comes from ROLE_LABEL_MESSAGES (task-i18n-stage3b)', () => {
  it.each([
    ['uk', 'SENIOR', 'Сеньйор'],
    ['uk', 'DROP', 'Дроп'],
    ['en', 'SENIOR', 'Senior'],
    ['en', 'ADMIN', 'Admin'],
  ] as const)('%s: %s badge reads %s and no raw enum leaks', async (locale, role, label) => {
    await loadCatalog(locale)
    const { container } = render(<UserProfileHeader user={makeUser({ role })} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.textContent ?? '').not.toMatch(RAW_ROLE)
  })
})

// task-i18n-stage2-task8 (audit §2, COPY-H-ppl-4): the local ROLE_LABELS map
// this component used to carry had no DROP entry, and the `?? user.role`
// fallback silently printed the raw enum on a drop's own profile. Now
// sourced from the canonical `ROLE_LABEL_MESSAGES` (`@/components/ui/role-select`),
// which has all six roles.
describe('UserProfileHeader — role label (audit COPY-H-ppl-4)', () => {
  it('shows the DROP role label from the shared map', () => {
    render(<UserProfileHeader user={makeUser({ role: 'DROP' })} />, { wrapper: I18nTestProvider })
    expect(screen.getByText('Дроп')).toBeInTheDocument()
  })

  // Kills the `ROLE_VARIANT[user.role] ?? 'outline'` mutants (Stryker
  // StringLiteral/LogicalOperator on this line): `ROLE_VARIANT` (unchanged
  // by this task, see UserProfileHeader.tsx) has no DROP entry, so the
  // Badge falls back to the `outline` variant — `border-border` is that
  // variant's own class (badge.tsx), not shared with any other variant used
  // on this component.
  it("DROP badge falls back to the 'outline' variant (no dedicated color yet)", () => {
    render(<UserProfileHeader user={makeUser({ role: 'DROP' })} />, { wrapper: I18nTestProvider })
    expect(screen.getByText('Дроп')).toHaveClass('border-border')
  })
})

describe('UserProfileHeader — telegram link (code-review round 2)', () => {
  // Role queries instead of `closest('a')` / `document.querySelector`
  // (task-lint-teeth) — same guarantees, asserted the way the link is actually
  // perceived rather than through DOM ancestry.
  it('valid handle renders as a clickable https://t.me/ link', () => {
    render(<UserProfileHeader user={makeUser({ telegram: '@armghyan' })} />, {
      wrapper: I18nTestProvider,
    })
    const link = screen.getByRole('link', { name: '@armghyan' })
    expect(link).toHaveAttribute('href', 'https://t.me/armghyan')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('invalid telegram value stays plain, non-clickable text', () => {
    render(<UserProfileHeader user={makeUser({ telegram: 'not a real handle!!' })} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText('not a real handle!!')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'not a real handle!!' })).toBeNull()
  })

  it('renders no t.me link when telegram is null', () => {
    render(<UserProfileHeader user={makeUser({ telegram: null })} />, { wrapper: I18nTestProvider })
    expect(screen.queryByRole('link', { name: /t\.me/i })).not.toBeInTheDocument()
    expect(
      screen
        .queryAllByRole('link')
        .filter((a) => a.getAttribute('href')?.startsWith('https://t.me/')),
    ).toHaveLength(0)
  })
})

// §4.4 (task-user-emails-dual-login): personal address on file, shown next
// to the work email — zero prior coverage for this render path.
describe('UserProfileHeader — personalEmail (§4.4)', () => {
  it('renders a mailto: link for the personal address when set', () => {
    render(<UserProfileHeader user={makeUser({ personalEmail: 'ivan.personal@gmail.com' })} />, {
      wrapper: I18nTestProvider,
    })
    const link = screen.getByRole('link', { name: 'ivan.personal@gmail.com' })
    expect(link).toHaveAttribute('href', 'mailto:ivan.personal@gmail.com')
  })

  it('renders nothing for the personal address when null (the common case)', () => {
    render(<UserProfileHeader user={makeUser({ personalEmail: null })} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.queryByRole('link', { name: 'ivan.personal@gmail.com' })).not.toBeInTheDocument()
  })

  it('the work email link is unaffected by a set personal address', () => {
    render(
      <UserProfileHeader
        user={makeUser({ email: 'ivan@work.com', personalEmail: 'ivan.personal@gmail.com' })}
      />,
      { wrapper: I18nTestProvider },
    )
    const workLink = screen.getByRole('link', { name: 'ivan@work.com' })
    expect(workLink).toHaveAttribute('href', 'mailto:ivan@work.com')
  })
})

// task-user-emails-invite (spec §5): the "не підтверджено" status badge next
// to the personal address — zero prior coverage for this render path.
describe('UserProfileHeader — personal-email invite status badge', () => {
  it('shows "не підтверджено" when personalEmailCanLogin is false', () => {
    render(
      <UserProfileHeader
        user={makeUser({
          personalEmail: 'ivan.personal@gmail.com',
          personalContactVisible: true,
          personalEmailCanLogin: false,
        })}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('personal-email-not-confirmed-badge')).toHaveTextContent(
      'не підтверджено',
    )
  })

  it('hides the badge once personalEmailCanLogin is true (invite accepted)', () => {
    render(
      <UserProfileHeader
        user={makeUser({
          personalEmail: 'ivan.personal@gmail.com',
          personalContactVisible: true,
          personalEmailCanLogin: true,
        })}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.queryByTestId('personal-email-not-confirmed-badge')).not.toBeInTheDocument()
  })

  it('hides the badge when there is no personal address at all', () => {
    render(<UserProfileHeader user={makeUser({ personalEmail: null })} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.queryByTestId('personal-email-not-confirmed-badge')).not.toBeInTheDocument()
  })
})
