/**
 * locale-switcher.spec.ts — task-i18n-stage2 (Task 7), AC7.
 *
 * Companion to `auth.spec.ts`'s two Task 6 cases (`<html lang>` follows
 * `/auth/me`'s `locale`) — this covers the OTHER half of the round trip:
 * choosing a locale on the viewer's own profile PATCHes `/users/me` and
 * activates it client-side, end to end (real dynamic `.po` import +
 * `<I18nProvider>` re-render — nothing a unit test's jsdom/happy-dom can
 * see; see `LanguageSection.test.tsx` for the mocked-network version of
 * the same contract).
 *
 * Pattern: mock-based (`mockAuthAs`), same as `profile-self-edit.spec.ts`
 * right next to it in this shard — `mockAuthAs`'s generic `/users/me`
 * PATCH handler already echoes back `{ ...user, ...body }`, so no extra
 * route registration is needed here.
 */
import { test, expect, USERS, mockAuthAs } from './fixtures'

test.describe('Interface language switcher — own profile only (AC7)', () => {
  test('clicking "English" PATCHes /users/me and activates <html lang="en">', async ({ page }) => {
    await mockAuthAs(page, { ...USERS.senior, locale: 'uk' })
    await page.goto('/profile')
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    const enOption = page.getByTestId('locale-option-en')
    await expect(enOption).toBeVisible()
    await expect(enOption).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('locale-option-uk')).toHaveAttribute('aria-checked', 'true')
    // Starting state — the switcher must not have jumped ahead of the
    // session before any click (no optimistic switch either, at page load).
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk')
    // The section title comes from the REAL compiled `.po` catalog (unit
    // tests only assert role/testid, never this text — COPY-L-2, PR #696
    // fix-round 1) — a dropped `<Trans>` or a swapped msgstr would pass
    // every other assertion here and only show up as a missing string.
    await expect(page.getByText('Мова інтерфейсу')).toBeVisible()

    const patchReq = page.waitForRequest(
      (req) => req.url().includes('/users/me') && req.method() === 'PATCH',
      { timeout: 8000 },
    )

    await enOption.click()

    const req = await patchReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body).toEqual({ locale: 'en' })

    // activateLocale runs AFTER the PATCH resolves — the real end-to-end
    // effect no unit test can see (real `.po` import + `<I18nProvider>`).
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(enOption).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('Interface language')).toBeVisible()
  })

  test("the switcher is absent from another user's profile", async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    await expect(page.getByTestId('locale-option-uk')).toHaveCount(0)
    await expect(page.getByTestId('locale-option-en')).toHaveCount(0)
  })

  // CR-M-3 / UX-M-1 (PR #696 fix-round 1) — `foundation.md`'s ≥44px mobile
  // touch target, measured directly rather than inferred from classnames
  // (the SegmentedToggle unit test only asserts the `min-h-11` class exists,
  // not what it computes to in a real viewport).
  test('locale buttons are at least 44px tall on a 320px mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await mockAuthAs(page, { ...USERS.senior, locale: 'uk' })
    await page.goto('/profile')
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    const ukOption = page.getByTestId('locale-option-uk')
    await expect(ukOption).toBeVisible()
    const box = await ukOption.boundingBox()
    expect(box).not.toBeNull()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  })
})
