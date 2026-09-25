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
import { i18n } from '@lingui/core'
import {
  API_ERROR_MESSAGES,
  NEW_NOTIFICATION_TYPES,
  NOTIFICATION_TITLE_MESSAGES,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { NotificationSettingsTab } from '../NotificationSettingsTab'

let viewerRole: string | null = 'SENIOR'
/** Бэклог 205 — под «войти как» `/me` отдаёт `impersonating: true`. */
let viewerImpersonating = false
vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user:
      viewerRole === null
        ? null
        : { id: 'viewer-1', role: viewerRole, impersonating: viewerImpersonating },
  }),
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

// COPY-H-1 (copy-review круг 1, PR #714): `rowTitle` now renders through
// `useLingui()` — every render in this file needs an activated catalog.
beforeEach(async () => {
  vi.clearAllMocks()
  viewerRole = 'SENIOR'
  viewerImpersonating = false
  queryState = {
    data: { items: TEN_TYPES },
    isLoading: false,
    isError: false,
    refetch: refetchMock,
  }
  await loadCatalog('uk')
})

describe('NotificationSettingsTab — loading/error states', () => {
  it('renders one skeleton row per NEW_NOTIFICATION_TYPES entry on both layouts while loading', () => {
    queryState = { data: undefined, isLoading: true, isError: false, refetch: refetchMock }
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const desktopSkeletons = within(
      screen.getByTestId('notification-settings-loading-desktop'),
    ).getAllByRole('row')
    // header-less skeleton table — every row is a skeleton row (design spec
    // §6.1: identical bars, no fake group headers while loading).
    // task-i18n-stage4-task6: count is derived, not literal — `SKELETON_ROW_
    // COUNT` in the component reads `NEW_NOTIFICATION_TYPES.length`, which
    // grew from 10 to 13 (three frozen types registered).
    expect(desktopSkeletons).toHaveLength(NEW_NOTIFICATION_TYPES.length)
    expect(screen.getAllByTestId('notification-settings-loading-mobile-row')).toHaveLength(
      NEW_NOTIFICATION_TYPES.length,
    )
  })

  it('shows the error message + Повторить, which calls refetch', () => {
    queryState = { data: undefined, isLoading: false, isError: true, refetch: refetchMock }
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    expect(screen.getByText('Не вдалося завантажити налаштування')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }))
    expect(refetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('NotificationSettingsTab — AC2 grouping + titles', () => {
  // COPY-H-1 (copy-review круг 1, PR #714): rows now render the CANON
  // `NOTIFICATION_TITLE_MESSAGES` on the viewer's locale, not the legacy
  // (partly-Russian, partly-Ukrainian) `NOTIFICATION_TITLES` record.
  it('renders all ten types, titles matching the canon NOTIFICATION_TITLE_MESSAGES', () => {
    // ADMIN viewer so the "Ваши предложения" group (and its two types)
    // also renders — this assertion is about every type's TITLE, not about
    // role-gating (that's the two admin-visibility tests below).
    viewerRole = 'ADMIN'
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    for (const item of TEN_TYPES) {
      const title =
        NOTIFICATION_TITLE_MESSAGES[item.type as keyof typeof NOTIFICATION_TITLE_MESSAGES].message
      expect(scope.getByText(title!)).toBeInTheDocument()
    }
  })

  it('groups money types (TRANSACTION_*) under "Деньги"', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    expect(
      within(screen.getByTestId('notification-settings-desktop')).getByTestId(
        'notification-group-money',
      ),
    ).toBeInTheDocument()
  })

  it('groups action-required types under "Требуют ответа"', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    expect(
      within(screen.getByTestId('notification-settings-desktop')).getByTestId(
        'notification-group-action-required',
      ),
    ).toBeInTheDocument()
  })

  it('shows "Ваши предложения" group for an ADMIN viewer', () => {
    viewerRole = 'ADMIN'
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    expect(scope.getByTestId('notification-group-admin')).toBeInTheDocument()
    expect(scope.getByText('Ваші пропозиції')).toBeInTheDocument()
    expect(
      scope.getByText(NOTIFICATION_TITLE_MESSAGES.APPROVAL_CONFIRMED.message!),
    ).toBeInTheDocument()
  })

  // SR-M-3 (security-review, fix-round 2, PR #675): HR is the OTHER role
  // that can be `proposedByUserId` on a project, and therefore the OTHER
  // actual recipient of these two email types — pins that the group is
  // gated on a SET of roles, not `=== 'ADMIN'` alone.
  it('shows "Ваши предложения" group for an HR viewer too', () => {
    viewerRole = 'HR'
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    expect(scope.getByTestId('notification-group-admin')).toBeInTheDocument()
    expect(
      scope.getByText(NOTIFICATION_TITLE_MESSAGES.APPROVAL_CONFIRMED.message!),
    ).toBeInTheDocument()
  })

  // SR-M-4 (security-review, fix-round 3, PR #675): ACCOUNTANT is the third
  // actual recipient — a finance-scoped `seniorSharePercentOverride` patch
  // (`projects.service.ts` `update()`) lets ACCOUNTANT propose a share
  // override, and the SENIOR who confirms/rejects it is a different user,
  // so ACCOUNTANT receives APPROVAL_CONFIRMED/APPROVAL_REJECTED same as
  // ADMIN/HR would.
  it('shows "Ваши предложения" group for an ACCOUNTANT viewer too', () => {
    viewerRole = 'ACCOUNTANT'
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    expect(scope.getByTestId('notification-group-admin')).toBeInTheDocument()
    expect(
      scope.getByText(NOTIFICATION_TITLE_MESSAGES.APPROVAL_CONFIRMED.message!),
    ).toBeInTheDocument()
  })

  it('hides "Ваши предложения" group for a SENIOR viewer', () => {
    viewerRole = 'SENIOR'
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    expect(scope.queryByTestId('notification-group-admin')).not.toBeInTheDocument()
    expect(
      scope.queryByText(NOTIFICATION_TITLE_MESSAGES.APPROVAL_CONFIRMED.message!),
    ).not.toBeInTheDocument()
  })

  it('no session (useAuth returns a null user) never crashes and never shows the admin group', () => {
    // Pins `viewer?.role` — a mutant turning this into a non-optional
    // `viewer.role` throws on a null user, which this test would catch as a
    // render exception (not just a failed assertion).
    viewerRole = null
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
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
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    // COPY-H-1 (fix-round 2, PR #675): the visible label is the generic
    // "Уведомление", never the raw type — but the raw type stays reachable
    // via the row's own `data-testid` and its `title` attribute.
    expect(scope.queryByText('FUTURE_TYPE_XYZ')).not.toBeInTheDocument()
    const row = scope.getByTestId('notification-row-desktop-FUTURE_TYPE_XYZ')
    // COPY-L-4 (copy-review, fix-round 3, PR #675): "Уведомление" named
    // nothing this row didn't already say by being inside the "Уведомления"
    // tab, in a table whose own column header is "Тип уведомления" — and it
    // repeated "уведомлени-" a third time together with the explanation
    // below. "Новый тип" is the one word this generic row actually adds.
    const title = within(row).getByText('Новий тип сповіщень')
    expect(title).toBeInTheDocument()
    expect(title).toHaveAttribute('title', 'FUTURE_TYPE_XYZ')
    const explanationEl = within(row).getByText('Налаштування з’явиться після оновлення застосунку')
    // Own id+testid pair (independent strings from the shared locked one) —
    // pins both against a mutant that empties either.
    expect(explanationEl).toHaveAttribute('id', 'notification-pref-explain-desktop-FUTURE_TYPE_XYZ')
    expect(within(row).getByTestId('notification-pref-explain-desktop-FUTURE_TYPE_XYZ')).toBe(
      explanationEl,
    )
    // No header row renders for the untitled trailing "unknown" group on the
    // desktop table (`DesktopGroupHeader` returns `null` when `title` is
    // falsy) — unlike the mobile stack, which always wraps a group in a
    // `<div>` regardless of title.
    expect(scope.queryByTestId('notification-group-unknown')).not.toBeInTheDocument()
  })

  it('a known type never carries a `title` attribute (no raw type to surface)', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-desktop'))
    const title = scope.getByText('Вам додали транзакцію')
    expect(title.className).toContain('text-sm')
    expect(title).not.toHaveAttribute('title')
  })

  it('the switch aria-label leads with the channel, then names the exact type', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const row = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-TRANSACTION_ADDED',
    )
    expect(within(row).getByRole('switch')).toHaveAttribute(
      'aria-label',
      'Листи: Вам додали транзакцію',
    )
  })

  it('mobile switch wrapper carries the box-content touch-target recipe (design spec §8)', () => {
    // Unit-level double for the E2E-verified real effect (boundingBox
    // >=44x44 in `notification-settings.spec.ts` AC6) — jsdom does not
    // compute layout, so this pins the RECIPE (every class the fix
    // depends on) rather than the resulting pixel size.
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const wrapper = within(screen.getByTestId('notification-settings-mobile')).getByTestId(
      'notification-switch-wrapper-mobile-TRANSACTION_ADDED',
    )
    expect(wrapper.className).toContain('inline-flex')
    expect(wrapper.className).toContain('box-content')
    expect(wrapper.className).toContain('bg-clip-content')
    expect(wrapper.className).toContain('bg-origin-content')
    expect(wrapper.className).toContain('px-1')
    expect(wrapper.className).toContain('py-3')
  })

  it('a known, unlocked row shows no explanation text on either layout', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
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
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
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

  // COPY-M-2 (copy-review, fix-round 2, PR #675): the explanation is now
  // rendered ONCE, under the group heading, and every locked switch's
  // `aria-describedby` points at that single id — not a per-row paragraph.
  it('renders the shared locked explanation once under the group heading, referenced by every locked switch', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const desktop = within(screen.getByTestId('notification-settings-desktop'))
    const group = desktop.getByTestId('notification-group-action-required')
    const explanationEl = within(group).getByText(
      'Листи про запити на підтвердження та підпис вимкнути не можна — без них процес зупиниться',
    )
    expect(explanationEl).toHaveAttribute('id', 'notification-pref-explain-locked-desktop')
    expect(within(group).getByTestId('notification-pref-explain-locked-desktop')).toBe(
      explanationEl,
    )
    // ALL THREE locked types' switches describedBy the SAME shared id — not
    // three different ids, and not a leftover per-row id.
    for (const type of [
      'PROJECT_CONFIRM_REQUIRED',
      'SHARE_CONFIRM_REQUIRED',
      'DOCUMENT_SIGN_REQUIRED',
    ]) {
      const row = desktop.getByTestId(`notification-row-desktop-${type}`)
      expect(within(row).getByRole('switch')).toHaveAttribute(
        'aria-describedby',
        'notification-pref-explain-locked-desktop',
      )
      // The per-row explanation paragraph no longer exists for a locked row.
      expect(
        within(row).queryByTestId(`notification-pref-explain-desktop-${type}`),
      ).not.toBeInTheDocument()
    }
    // The shared paragraph renders exactly ONCE for the whole group, not
    // once per locked row (the bug COPY-M-2 fixed).
    expect(
      desktop.getAllByText(
        'Листи про запити на підтвердження та підпис вимкнути не можна — без них процес зупиниться',
      ),
    ).toHaveLength(1)
  })
})

// task-i18n-stage3b (Task 1), mutation-gate coverage — the desktop table's
// own column headers and the locked-row "always on" email-column text had
// zero unit assertion pinning their resolved text.
describe('NotificationSettingsTab — desktop table column headers + locked-row email cell', () => {
  it('renders the three column headers with their own exact text', () => {
    render(<NotificationSettingsTab />)
    const desktop = within(screen.getByTestId('notification-settings-desktop'))
    const headers = desktop.getAllByRole('columnheader')
    expect(headers.map((h) => h.textContent)).toEqual(['Тип сповіщення', 'У застосунку', 'Лист'])
  })

  it('a locked row shows "Завжди" in the email column instead of a second switch', () => {
    render(<NotificationSettingsTab />)
    const row = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-row-desktop-PROJECT_CONFIRM_REQUIRED',
    )
    expect(within(row).getByText('Завжди')).toBeInTheDocument()
  })
})

describe('NotificationSettingsTab — AC4 toggling a regular type', () => {
  it('clicking an unlocked switch calls the mutation with exactly that type', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
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
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
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
  // COPY-M-4 (copy-review, fix-round 3, PR #675): the fact that in-app
  // notifications are always on is stated ONCE, in the tab subtitle — a
  // per-row repeat on the mobile card stack (ten identical lines back to
  // back on a 320px screen, one per card) said nothing the subtitle hadn't
  // already said above the whole stack. The desktop table keeps its own
  // per-row "Всегда" cell (COPY-M-3) — there it is a genuine matrix column,
  // not a lone repeated sentence, so it is unaffected.
  it('COPY-M-4: never repeats "В приложении — всегда" per card — the fact is stated once, in the subtitle', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const mobile = within(screen.getByTestId('notification-settings-mobile'))
    expect(mobile.queryByText('В приложении — всегда')).not.toBeInTheDocument()
    // The subtitle above the stack still says it once — the desktop table's
    // own "В приложении" COLUMN HEADER is a separate, legitimate mention
    // (per-column label, not a per-row repeat) and is deliberately excluded
    // by scoping to the subtitle paragraph's own text, not a page-wide regex.
    expect(
      screen.getByText('Оберіть, про що надсилати листи. У застосунку сповіщення видно завжди'),
    ).toBeInTheDocument()
  })

  it('renders group headings and every title', () => {
    viewerRole = 'ADMIN'
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-mobile'))
    expect(scope.getByText('Потребують відповіді')).toBeInTheDocument()
    expect(scope.getByText('Гроші')).toBeInTheDocument()
    expect(scope.getByText('Команда та проєкти')).toBeInTheDocument()
    expect(scope.getByText('Ваші пропозиції')).toBeInTheDocument()
    for (const item of TEN_TYPES) {
      const title =
        NOTIFICATION_TITLE_MESSAGES[item.type as keyof typeof NOTIFICATION_TITLE_MESSAGES].message
      expect(scope.getByText(title!)).toBeInTheDocument()
    }
  })

  it('an unknown type renders a generic row with the "new type" explanation', () => {
    queryState = {
      data: {
        items: [...TEN_TYPES, { type: 'FUTURE_TYPE_XYZ', emailEnabled: true, locked: false }],
      },
      isLoading: false,
      isError: false,
      refetch: refetchMock,
    }
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const scope = within(screen.getByTestId('notification-settings-mobile'))
    // COPY-H-1: raw type is not the visible label anywhere.
    expect(scope.queryByText('FUTURE_TYPE_XYZ')).not.toBeInTheDocument()
    const row = scope.getByTestId('notification-row-mobile-FUTURE_TYPE_XYZ')
    // COPY-L-4: see the desktop test above for why the label shrank to
    // "Новый тип" and the explanation dropped the repeated "уведомления".
    const title = within(row).getByText('Новий тип сповіщень')
    expect(title).toHaveAttribute('title', 'FUTURE_TYPE_XYZ')
    const explanationEl = within(row).getByText('Налаштування з’явиться після оновлення застосунку')
    expect(explanationEl).toHaveAttribute('id', 'notification-pref-explain-mobile-FUTURE_TYPE_XYZ')
    expect(within(row).getByTestId('notification-pref-explain-mobile-FUTURE_TYPE_XYZ')).toBe(
      explanationEl,
    )
    // The untitled trailing group still gets its wrapping div (unlike the
    // desktop table), but never a visible heading — pins `group.title && (...)`
    // in `MobileStack` against a mutant that renders the heading regardless.
    const unknownGroup = scope.getByTestId('notification-group-unknown')
    expect(within(unknownGroup).queryByTestId('notification-group-heading')).not.toBeInTheDocument()
  })

  it('a known type never carries a `title` attribute (no raw type to surface)', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const title = within(screen.getByTestId('notification-settings-mobile')).getByText(
      'Вам додали транзакцію',
    )
    expect(title.className).toContain('text-sm')
    expect(title.className).toContain('font-medium')
    expect(title).not.toHaveAttribute('title')
  })

  it('locked row: checked, aria-disabled, opacity class, no mutation on click, describedBy the shared group explanation', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const mobile = within(screen.getByTestId('notification-settings-mobile'))
    const row = mobile.getByTestId('notification-row-mobile-PROJECT_CONFIRM_REQUIRED')
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

    // COPY-M-2: describedBy points at the ONE shared group-level id, not a
    // per-row paragraph — the per-row explanation no longer exists.
    expect(sw).toHaveAttribute('aria-describedby', 'notification-pref-explain-locked-mobile')
    expect(
      within(row).queryByTestId('notification-pref-explain-mobile-PROJECT_CONFIRM_REQUIRED'),
    ).not.toBeInTheDocument()
    const explanationEl = mobile.getByTestId('notification-pref-explain-locked-mobile')
    expect(explanationEl).toHaveAttribute('id', 'notification-pref-explain-locked-mobile')
  })

  it('toggling an unlocked switch calls the mutation with exactly that type', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const row = within(screen.getByTestId('notification-settings-mobile')).getByTestId(
      'notification-row-mobile-TRANSACTION_ADDED',
    )
    const sw = within(row).getByRole('switch')
    fireEvent.click(sw)
    expect(mutateMock).toHaveBeenCalledWith({ type: 'TRANSACTION_ADDED', emailEnabled: false })
  })

  it('an interactive switch never carries the standalone disabled styling', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const row = within(screen.getByTestId('notification-settings-mobile')).getByTestId(
      'notification-row-mobile-TRANSACTION_ADDED',
    )
    const sw = within(row).getByRole('switch')
    expect(sw.className).not.toMatch(/(?:^|\s)opacity-60(?:\s|$)/)
    expect(sw.className).not.toMatch(/(?:^|\s)cursor-not-allowed(?:\s|$)/)
  })
})

/**
 * Бэклог 205 — под «войти как» ни одна из десяти строк не принимает клик, ни
 * на одном из двух layout'ов, и объяснение — ОДНО и ровно то, что видит
 * клиент в 403 от `PUT /notifications/preferences`.
 */
describe('NotificationSettingsTab — impersonation (бэклог 205)', () => {
  it('banner is absent for a normal (non-impersonated) session', () => {
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    expect(screen.queryByTestId('notification-settings-impersonating-banner')).toBeNull()
  })

  it('banner renders with the exact server-side 403 text when impersonating (COPY-M-1/M-2, PR #678 круг 2)', () => {
    viewerImpersonating = true
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    // Один инвариант, а не переписанная строка: клиентский текст — серверный
    // литерал плюс точка (COPY-M-2), и связка проверяется арифметически, а не
    // повторным литералом, который может разойтись молча.
    expect(screen.getByTestId('notification-settings-impersonating-banner')).toHaveTextContent(
      i18n._(API_ERROR_MESSAGES.NOTIFICATION_PREFERENCES_IMPERSONATION),
    )
  })

  it('COPY-L-1: subtitle under impersonation is descriptive, not an imperative the banner immediately contradicts', () => {
    viewerImpersonating = true
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    expect(
      screen.getByText('Листи, які отримує співробітник. У застосунку сповіщення приходять завжди'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Оберіть, про що/)).not.toBeInTheDocument()
  })

  it('every switch is actually WIRED to the banner — aria-describedby matches the banner id, not just a coincidentally-equal string', () => {
    viewerImpersonating = true
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const banner = screen.getByTestId('notification-settings-impersonating-banner')
    // Reads the banner's OWN id and asserts the switch points at THAT id —
    // an empty/wrong id on either side would surface here even if both
    // happened to render, since `aria-describedby` on a `''` id targets no
    // element at all.
    expect(banner.id).not.toBe('')
    const sw = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      'notification-switch-desktop-TRANSACTION_ADDED',
    )
    expect(sw).toHaveAttribute('aria-describedby', banner.id)
  })

  it('every desktop switch — locked AND regular — is aria-disabled and un-clickable', () => {
    viewerImpersonating = true
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const desktop = within(screen.getByTestId('notification-settings-desktop'))
    for (const sw of desktop.getAllByRole('switch')) {
      expect(sw).toHaveAttribute('aria-disabled', 'true')
    }
    const regular = desktop.getByTestId('notification-switch-desktop-TRANSACTION_ADDED')
    fireEvent.click(regular)
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('every mobile switch is aria-disabled too — same session, same rule on both layouts', () => {
    viewerImpersonating = true
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const mobile = within(screen.getByTestId('notification-settings-mobile'))
    for (const sw of mobile.getAllByRole('switch')) {
      expect(sw).toHaveAttribute('aria-disabled', 'true')
    }
  })

  it('a normally-unlocked switch stays CHECKED to its own server value — impersonation disables, it does not lie about state', () => {
    viewerImpersonating = true
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    const sw = within(screen.getByTestId('notification-settings-desktop')).getByTestId(
      // PROJECT_MEMBER_ADDED is seeded with emailEnabled: false in TEN_TYPES.
      'notification-switch-desktop-PROJECT_MEMBER_ADDED',
    )
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })

  it('the per-group locked explanation is suppressed — the one impersonation banner replaces it', () => {
    viewerImpersonating = true
    render(<NotificationSettingsTab />, { wrapper: I18nTestProvider })
    expect(screen.queryByTestId('notification-pref-explain-locked-desktop')).toBeNull()
    expect(screen.queryByTestId('notification-pref-explain-locked-mobile')).toBeNull()
  })
})
