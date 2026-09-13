/**
 * NotificationSettingsTab.test.tsx — task-notification-settings-ui
 * (position 7b), AC2/AC3/AC4.
 *
 * Strategy: mock `useAuth` (viewer role) and the
 * `use-notification-preferences` hooks directly (query/mutation are already
 * covered on their own in `use-notification-preferences.test.tsx`) so this
 * file focuses purely on the component's rendering/grouping/interaction
 * contract. Scoped to `within(screen.getByTestId('notification-settings-
 * desktop'|'-mobile'))` throughout — inlined at each call site (not behind a
 * helper function: `eslint-plugin-testing-library`'s `prefer-screen-queries`
 * cannot see through a wrapper function's return value, so a `desktop()`
 * helper gets flagged as if it were an un-scoped `render()` destructure) —
 * the mobile card stack renders the SAME rows simultaneously (CSS-only
 * breakpoint switch, design spec §8), so an unscoped query would hit Testing
 * Library's "multiple elements" ambiguity on every row.
 */
import { render, screen, within, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { NotificationSettingsTab } from '../NotificationSettingsTab'

let viewerRole: string | null = 'SENIOR'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: viewerRole === null ? null : { id: 'viewer-1', role: viewerRole } }),
}))

const mutateMock = vi.fn()
let queryState: {
  data: { items: Array<{ type: string; emailEnabled: boolean; locked: boolean }> } | undefined
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

vi.mock('@/hooks/use-notification-preferences', () => ({
  useNotificationPreferences: () => queryState,
  useUpdateNotificationPreference: () => ({ mutate: mutateMock }),
}))

const TEN_TYPES = [
  { type: 'TRANSACTION_ADDED', emailEnabled: true, locked: false },
  { type: 'TRANSACTION_STATUS_CHANGED', emailEnabled: true, locked: false },
  { type: 'TEAM_MEMBER_ADDED', emailEnabled: true, locked: false },
  { type: 'PROJECT_MEMBER_ADDED', emailEnabled: false, locked: false },
  { type: 'TEAM_NEW_MEMBER', emailEnabled: true, locked: false },
  { type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: true, locked: true },
  { type: 'SHARE_CONFIRM_REQUIRED', emailEnabled: true, locked: true },
  { type: 'DOCUMENT_SIGN_REQUIRED', emailEnabled: true, locked: true },
  { type: 'APPROVAL_CONFIRMED', emailEnabled: true, locked: false },
  { type: 'APPROVAL_REJECTED', emailEnabled: true, locked: false },
]

const refetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  viewerRole = 'SENIOR'
  queryState = {
    data: { items: TEN_TYPES },
    isLoading: false,
    isError: false,
    refetch: refetchMock,
  }
})

describe('NotificationSettingsTab — loading/error states', () => {
  it('renders exactly ten skeleton rows on both layouts while loading', () => {
    queryState = { data: undefined, isLoading: true, isError: false, refetch: refetchMock }
    render(<NotificationSettingsTab />)
    const desktopSkeletons = within(
      screen.getByTestId('notification-settings-loading-desktop'),
    ).getAllByRole('row')
    // header-less skeleton table — every row is a skeleton row (design spec
    // §6.1: ten identical bars, no fake group headers while loading).
    expect(desktopSkeletons).toHaveLength(10)
    expect(screen.getAllByTestId('notification-settings-loading-mobile-row')).toHaveLength(10)
  })

  it('shows the error message + Повторить, which calls refetch', () => {
    queryState = { data: undefined, isLoading: false, isError: true, refetch: refetchMock }
    render(<NotificationSettingsTab />)
    expect(screen.getByText('Не удалось загрузить настройки уведомлений.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(refetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('NotificationSettingsTab — AC2 grouping + titles', () => {
  it('renders all ten types, titles matching the shared NOTIFICATION_TITLES map', () => {
    // ADMIN viewer so the "Для администратора" group (and its two types)
    // also renders — this assertion is about every type's TITLE, not about
    // role-gating (that's the two admin-visibility tests below).
    viewerRole = 'ADMIN'
    render(<NotificationSettingsTab />)
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    for (const item of TEN_TYPES) {
      const title = NOTIFICATION_TITLES[item.type as keyof typeof NOTIFICATION_TITLES]
      expect(scope.getByText(title)).toBeInTheDocument()
    }
  })

  it('groups money types (TRANSACTION_*) under "Деньги"', () => {
    render(<NotificationSettingsTab />)
    expect(
      within(screen.getByTestId('notification-settings-desktop')).getByTestId(
        'notification-group-money',
      ),
    ).toBeInTheDocument()
  })

  it('groups action-required types under "Требуют ответа"', () => {
    render(<NotificationSettingsTab />)
    expect(
      within(screen.getByTestId('notification-settings-desktop')).getByTestId(
        'notification-group-action-required',
      ),
    ).toBeInTheDocument()
  })

  it('shows "Для администратора" group for an ADMIN viewer', () => {
    viewerRole = 'ADMIN'
    render(<NotificationSettingsTab />)
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    expect(scope.getByTestId('notification-group-admin')).toBeInTheDocument()
    expect(scope.getByText(NOTIFICATION_TITLES.APPROVAL_CONFIRMED)).toBeInTheDocument()
  })

  it('hides "Для администратора" group for a non-ADMIN viewer (SENIOR)', () => {
    viewerRole = 'SENIOR'
    render(<NotificationSettingsTab />)
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    expect(scope.queryByTestId('notification-group-admin')).not.toBeInTheDocument()
    expect(scope.queryByText(NOTIFICATION_TITLES.APPROVAL_CONFIRMED)).not.toBeInTheDocument()
  })

  it('no session (useAuth returns a null user) never crashes and never shows the admin group', () => {
    // Pins `viewer?.role` — a mutant turning this into a non-optional
    // `viewer.role` throws on a null user, which this test would catch as a
    // render exception (not just a failed assertion).
    viewerRole = null
    render(<NotificationSettingsTab />)
    expect(
      within(screen.getByTestId('notification-settings-desktop')).queryByTestId(
        'notification-group-admin',
      ),
    ).not.toBeInTheDocument()
  })

  it('an unknown type renders a generic row instead of crashing the tab', () => {
    queryState = {
      data: {
        items: [...TEN_TYPES, { type: 'FUTURE_TYPE_XYZ', emailEnabled: true, locked: false }],
      },
      isLoading: false,
      isError: false,
      refetch: refetchMock,
    }
    render(<NotificationSettingsTab />)
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    const title = scope.getByText('FUTURE_TYPE_XYZ')
    expect(title).toBeInTheDocument()
    // font-mono signals "this is a raw type code, not translated text"
    // (design spec §7) — pins the `!known` branch on the DESKTOP layout
    // specifically (the mobile equivalent is pinned separately below).
    expect(title.className).toContain('font-mono')
    expect(
      scope.getByText('Новый тип уведомления, ожидайте обновления интерфейса.'),
    ).toBeInTheDocument()
    // No header row renders for the untitled trailing "unknown" group on the
    // desktop table (`DesktopGroupHeader` returns `null` when `title` is
    // falsy) — unlike the mobile stack, which always wraps a group in a
    // `<div>` regardless of title.
    expect(scope.queryByTestId('notification-group-unknown')).not.toBeInTheDocument()
  })

  it('a known type on the desktop layout never gets the font-mono treatment', () => {
    render(<NotificationSettingsTab />)
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    const title = scope.getByText('Вам добавили транзакцию')
    expect(title.className).toContain('text-sm')
    expect(title.className).not.toContain('font-mono')
  })

  it('the switch aria-label names the exact type, not a generic label', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-TRANSACTION_ADDED',
    )
    expect(within(row).getByRole('switch')).toHaveAttribute(
      'aria-label',
      '«Вам добавили транзакцию» — письмо',
    )
  })

  it('a known, unlocked row shows no explanation text on either layout', () => {
    render(<NotificationSettingsTab />)
    const desktopRow = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-TRANSACTION_ADDED',
    )
    expect(
      within(desktopRow).queryByTestId('notification-pref-explain-desktop-TRANSACTION_ADDED'),
    ).not.toBeInTheDocument()
    const mobileRow = within(screen.getByTestId('notification-settings-mobile')).getByTestId(
      'notification-row-mobile-TRANSACTION_ADDED',
    )
    expect(
      within(mobileRow).queryByTestId('notification-pref-explain-mobile-TRANSACTION_ADDED'),
    ).not.toBeInTheDocument()
  })
})

describe('NotificationSettingsTab — AC3 locked rows', () => {
  it('locked switch is checked, aria-disabled, and clicking it never calls the mutation', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-PROJECT_CONFIRM_REQUIRED',
    )
    const sw = within(row).getByRole('switch')
    // The per-type-and-breakpoint testid is what E2E/Playwright locators rely
    // on (playwright-patterns skill) — pins the string is not silently
    // emptied.
    expect(within(row).getByTestId('notification-switch-desktop-PROJECT_CONFIRM_REQUIRED')).toBe(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(sw)
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('renders the locked explanation text, referenced by aria-describedby', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-SHARE_CONFIRM_REQUIRED',
    )
    const sw = within(row).getByRole('switch')
    const describedBy = sw.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    // Looked up via the accessible-name query, scoped to THIS row (not
    // `document.getElementById`, and not an unscoped `screen.getByText` —
    // all three locked rows share the identical explanation text, so an
    // unscoped query would hit "multiple elements" across rows AND
    // breakpoints). Asserts BOTH that the text renders in this row AND that
    // it carries the exact id `aria-describedby` points at.
    const explanationEl = within(row).getByText(
      'Письма о запросах на подтверждение и подпись отключить нельзя — без них процесс встанет.',
    )
    expect(explanationEl).toHaveAttribute('id', describedBy)
    // Same element, reachable by its OWN testid too (not just by text) — pins
    // the `data-testid` string against a mutant that empties it while the
    // `id` attribute (a separate string) stays intact.
    expect(
      within(row).getByTestId('notification-pref-explain-desktop-SHARE_CONFIRM_REQUIRED'),
    ).toBe(explanationEl)
  })
})

describe('NotificationSettingsTab — AC4 toggling a regular type', () => {
  it('clicking an unlocked switch calls the mutation with exactly that type', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-TRANSACTION_ADDED',
    )
    const sw = within(row).getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(sw)
    expect(mutateMock).toHaveBeenCalledTimes(1)
    expect(mutateMock).toHaveBeenCalledWith({ type: 'TRANSACTION_ADDED', emailEnabled: false })
  })

  it('toggling an OFF row back on sends emailEnabled: true', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-PROJECT_MEMBER_ADDED',
    )
    const sw = within(row).getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    expect(mutateMock).toHaveBeenCalledWith({ type: 'PROJECT_MEMBER_ADDED', emailEnabled: true })
  })
})

// ---------------------------------------------------------------------------
// Mobile card stack — same behavioral contract as desktop, scoped to
// `notification-settings-mobile` so the assertions exercise MobileRow /
// MobileStack directly instead of relying on the desktop table alone
// (design spec §8: two independent layouts, same data — both need coverage).
// ---------------------------------------------------------------------------

describe('NotificationSettingsTab — mobile card stack (same contract as desktop)', () => {
  it('renders group headings and every title', () => {
    viewerRole = 'ADMIN'
    render(<NotificationSettingsTab />)
    const scope = within(screen.getByTestId('notification-settings-mobile'))
    expect(scope.getByText('Требуют ответа')).toBeInTheDocument()
    expect(scope.getByText('Деньги')).toBeInTheDocument()
    expect(scope.getByText('Команда и проекты')).toBeInTheDocument()
    expect(scope.getByText('Для администратора')).toBeInTheDocument()
    for (const item of TEN_TYPES) {
      const title = NOTIFICATION_TITLES[item.type as keyof typeof NOTIFICATION_TITLES]
      expect(scope.getByText(title)).toBeInTheDocument()
    }
  })

  it('an unknown type renders a generic (font-mono) row with the "new type" explanation', () => {
    queryState = {
      data: {
        items: [...TEN_TYPES, { type: 'FUTURE_TYPE_XYZ', emailEnabled: true, locked: false }],
      },
      isLoading: false,
      isError: false,
      refetch: refetchMock,
    }
    render(<NotificationSettingsTab />)
    const scope = within(screen.getByTestId('notification-settings-mobile'))
    const title = scope.getByText('FUTURE_TYPE_XYZ')
    expect(title.className).toContain('font-mono')
    expect(
      scope.getByText('Новый тип уведомления, ожидайте обновления интерфейса.'),
    ).toBeInTheDocument()
    // The untitled trailing group still gets its wrapping div (unlike the
    // desktop table), but never a visible heading — pins `group.title && (...)`
    // in `MobileStack` against a mutant that renders the heading regardless.
    const unknownGroup = scope.getByTestId('notification-group-unknown')
    expect(within(unknownGroup).queryByTestId('notification-group-heading')).not.toBeInTheDocument()
  })

  it('a known type never gets the font-mono treatment, and keeps its base classes', () => {
    render(<NotificationSettingsTab />)
    const title = within(screen.getByTestId('notification-settings-mobile')).getByText(
      'Вам добавили транзакцию',
    )
    expect(title.className).toContain('text-sm')
    expect(title.className).toContain('font-medium')
    expect(title.className).not.toContain('font-mono')
  })

  it('locked row: checked, aria-disabled, opacity class, no mutation on click', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-mobile')).getByTestId(
      'notification-row-mobile-PROJECT_CONFIRM_REQUIRED',
    )
    const sw = within(row).getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveAttribute('aria-disabled', 'true')
    // Standalone token check — the base Switch styling always carries
    // `disabled:opacity-60` (a Tailwind variant prefix, unrelated to this
    // component's own `!interactive` class addition), so a naive substring
    // match would pass even when the extra classes are never appended.
    expect(sw.className).toMatch(/(?:^|\s)opacity-60(?:\s|$)/)
    expect(sw.className).toMatch(/(?:^|\s)cursor-not-allowed(?:\s|$)/)
    fireEvent.click(sw)
    expect(mutateMock).not.toHaveBeenCalled()

    const describedBy = sw.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    // Same id+testid pairing pinned as the desktop layout above — the
    // mobile explanation paragraph is a SEPARATE JSX element with its own
    // (independently mutable) `id` and `data-testid` strings.
    const explanationEl = within(row).getByTestId(
      'notification-pref-explain-mobile-PROJECT_CONFIRM_REQUIRED',
    )
    expect(explanationEl).toHaveAttribute('id', describedBy)
  })

  it('toggling an unlocked switch calls the mutation with exactly that type', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-mobile')).getByTestId(
      'notification-row-mobile-TRANSACTION_ADDED',
    )
    const sw = within(row).getByRole('switch')
    fireEvent.click(sw)
    expect(mutateMock).toHaveBeenCalledWith({ type: 'TRANSACTION_ADDED', emailEnabled: false })
  })

  it('an interactive switch never carries the standalone disabled styling', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-mobile')).getByTestId(
      'notification-row-mobile-TRANSACTION_ADDED',
    )
    const sw = within(row).getByRole('switch')
    expect(sw.className).not.toMatch(/(?:^|\s)opacity-60(?:\s|$)/)
    expect(sw.className).not.toMatch(/(?:^|\s)cursor-not-allowed(?:\s|$)/)
  })
})
