/**
 * senior-teamless.spec.ts — Drop role - phase 1 (AC5/AC7).
 *
 * Verifies the teamless-senior surfacing across:
 *   - `/profile` → banner + «Создать или выбрать команду» CTA
 *   - `/projects` → full-page empty state with rejoin CTA
 *   - `/interviews` → empty state with rejoin CTA
 *   - sidebar — Projects/Interviews entries should disappear for the
 *     teamless senior
 *
 * Mock-based — uses an authenticated senior whose `/api/teams` response
 * carries no team containing them as an active member.
 */

import { test as base, expect, mockAuthAs, USERS } from './fixtures'

const API = 'http://localhost:3001/api'

/**
 * Authenticate as the orphan senior + serve a teams list where the senior
 * is absent. `useActiveTeam` will then resolve `isTeamless=true`.
 */
const test = base.extend<{ asTeamlessSenior: import('@playwright/test').Page }>({
  asTeamlessSenior: async ({ page }, use) => {
    await mockAuthAs(page, USERS.seniorOrphan)
    // Override `/teams` AFTER mockAuthAs so the orphan senior sees an
    // empty list — no active membership anywhere.
    await page.route(new RegExp(`${API}/teams(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    )
    await use(page)
  },
})

test.describe('Senior teamless surfaces — AC5/AC7', () => {
  test('Profile banner + rejoin CTA visible on /profile', async ({ asTeamlessSenior: page }) => {
    await page.goto('/profile')

    // Banner uses a dedicated testid (UserProfileShell:profile-teamless-banner).
    await expect(page.getByTestId('profile-teamless-banner')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText(/У вас нет активной команды/i)).toBeVisible()
    await expect(page.getByTestId('profile-rejoin-button')).toBeVisible()
  })

  test('Clicking «Создать или выбрать команду» on profile opens the rejoin dialog', async ({
    asTeamlessSenior: page,
  }) => {
    await page.goto('/profile')

    await expect(page.getByTestId('profile-rejoin-button')).toBeVisible({ timeout: 8_000 })
    await page.getByTestId('profile-rejoin-button').click()

    const dialog = page.getByTestId('rejoin-team-dialog')
    await expect(dialog).toBeVisible()
    // Both team-mode options should surface.
    await expect(dialog.getByTestId('rejoin-team-mode-create-new')).toBeVisible()
    await expect(dialog.getByTestId('rejoin-team-mode-join-drop')).toBeVisible()
  })

  test('/projects shows full-page empty state with rejoin CTA', async ({
    asTeamlessSenior: page,
  }) => {
    await page.goto('/projects')

    await expect(page.getByTestId('projects-teamless-empty-state')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText(/У вас нет активной команды/i)).toBeVisible()
    // Empty state CTA opens the same rejoin dialog.
    await page.getByRole('button', { name: /Создать или выбрать команду/i }).click()
    await expect(page.getByTestId('rejoin-team-dialog')).toBeVisible()
  })

  test('/interviews shows empty state with rejoin CTA', async ({ asTeamlessSenior: page }) => {
    await page.goto('/interviews')

    await expect(page.getByTestId('interviews-teamless-empty-state')).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.getByText(/У вас нет активной команды/i)).toBeVisible()
    await page.getByRole('button', { name: /Создать или выбрать команду/i }).click()
    await expect(page.getByTestId('rejoin-team-dialog')).toBeVisible()
  })

  test('Sidebar hides «Проекты» and «Собеседования» for the teamless senior', async ({
    asTeamlessSenior: page,
  }) => {
    await page.goto('/profile')
    // Wait for sidebar mount + `useActiveTeam` to resolve. Profile is
    // always present so its sidebar link serves as the anchor.
    await expect(page.locator('a[href="/profile"]').first()).toBeVisible({ timeout: 8_000 })

    // Projects + interviews links must be hidden — the sidebar gate uses
    // `useActiveTeam.isTeamless` to drop them for SENIOR.
    await expect(page.locator('a[href="/projects"]')).toHaveCount(0)
    await expect(page.locator('a[href="/interviews"]')).toHaveCount(0)

    // Team + Finance entries stay — the gate is scoped to projects/interviews.
    await expect(page.locator('a[href="/team"]').first()).toBeVisible()
    await expect(page.locator('a[href="/finance"]').first()).toBeVisible()
  })
})
