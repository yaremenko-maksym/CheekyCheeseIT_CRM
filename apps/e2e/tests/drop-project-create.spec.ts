/**
 * drop-project-create.spec.ts — task-drop-phase2-e2e (AC5).
 *
 * REAL-API UI flow: ADMIN creates a drop-project through `/projects`.
 *
 *   1. Pre-step: provision a fresh DROP user (so the drop Select has at
 *      least one option). Backend test endpoint creates DROP + drop-team.
 *   2. UI flow: ADMIN navigates to /projects → «Новый проект» dialog.
 *   3. Fill the form: name, company, domain stays default, choose senior
 *      from Select, choose the drop user from the new «Дроп» Select
 *      (data-testid="create-project-drop-select"), set rate.
 *   4. Submit → assertions:
 *      - Toast/navigation to detail page is implicit (the dialog closes,
 *        the new project appears in the list).
 *      - The project's `dropId` field matches the chosen DROP user
 *        (verified via REST GET).
 *      - The detail page renders the «Drop-проект» badge.
 *      - The detail page renders the distribution breakdown (
 *        `data-testid="project-drop-distribution"`) with senior + drop +
 *        partner shares matching the canonical 26 / 5 / 50-50 split.
 *
 * Cleanup: cascade-archive the drop (removes the project too).
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  findUserByEmailViaApi,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

const REAL_API = 'http://localhost:3001/api'

test.describe('Drop-project create — UI flow (AC5)', () => {
  test('ADMIN selects «Дроп» in the create form → drop-project saved + badge + breakdown', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-ac5-${suffix}@cheekycheese.dev`
    const dropDisplayName = `Drop AC5 ${suffix}`
    const projectName = `Drop UI Project ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: dropDisplayName,
    })

    try {
      // ADMIN is already logged in. Land on /projects.
      await page.goto('/projects')

      // Open «Новый проект» dialog.
      await page.getByRole('button', { name: 'Новый проект' }).first().click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 10_000 })

      // Project name + company name. Labels in the dialog aren't associated
      // via `for/id` so we match on placeholder text instead — same text
      // the seed users see ("AI Platform v2" / "TechCorp AI").
      await dialog.getByPlaceholder('AI Platform v2').fill(projectName)
      await dialog.getByPlaceholder('TechCorp AI').fill('Drop UI Co')

      // Senior Select — the form renders 3 native <select> elements in
      // order: domain, senior, drop (the drop one has the data-testid).
      // Domain stays at default; senior is the SECOND select.
      const seniorSelect = dialog.locator('select').nth(1)
      const seniorUser = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(seniorUser).toBeTruthy()
      await seniorSelect.selectOption(seniorUser!.id)

      // Drop Select — should be visible because we provisioned a DROP user.
      const dropSelect = dialog.getByTestId('create-project-drop-select')
      await expect(dropSelect).toBeVisible({ timeout: 5_000 })
      await dropSelect.selectOption(dropId)

      // Rate — keep currency as default USDT, just type the rate.
      // The AmountCurrencyInput uses placeholder="5000" — find by placeholder.
      await dialog.getByPlaceholder('5000').fill('5000')

      // Submit. The dialog's submit button is labelled «Создать».
      const createButtonInDialog = dialog.getByRole('button', { name: /Создать/i })
      // Intercept the POST so we can read the created project id immediately
      // (the dialog doesn't auto-navigate to the new detail page).
      const postPromise = page.waitForResponse(
        (resp) => resp.url().endsWith('/api/projects') && resp.request().method() === 'POST',
      )
      await createButtonInDialog.click()
      const postResp = await postPromise
      expect(postResp.status()).toBeLessThan(400)
      const created = (await postResp.json()) as { id: string; dropId: string | null }

      // Backend assertions: dropId is set and matches our drop.
      expect(created.dropId).toBe(dropId)

      // Dialog should close after success.
      await expect(dialog).toBeHidden({ timeout: 5_000 })

      // Navigate to detail and verify badges + breakdown.
      await page.goto(`/projects/${created.id}`)
      await expect(page.getByTestId('project-drop-badge')).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText('Drop-проект', { exact: false })).toBeVisible()

      // Distribution breakdown lives on the «Финансы» tab — switch to it.
      // SegmentedToggle renders the tab as a <button role="tab"> with
      // data-testid="tab-finance" (set on the option in $projectId.tsx).
      await page.getByTestId('tab-finance').click()

      const breakdown = page.getByTestId('project-drop-distribution')
      await expect(breakdown).toBeVisible({ timeout: 10_000 })

      // Spec §8.1 canonical: senior 26%, drop 5%, partners 50-50 of $345 each
      // on a $1000 income. Senior share defaults to 26 from the seed.
      await expect(breakdown.getByTestId('dist-senior-share')).toContainText('$260')
      await expect(breakdown.getByTestId('dist-drop-share')).toContainText('$50')
      await expect(breakdown.getByTestId('dist-partner-share')).toContainText('$345')

      // Backend sanity (REST) — drop id matches.
      const projectRes = await page.request.get(`${REAL_API}/projects/${created.id}`)
      expect(projectRes.status()).toBe(200)
      const projectDto = (await projectRes.json()) as { dropId: string | null }
      expect(projectDto.dropId).toBe(dropId)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
