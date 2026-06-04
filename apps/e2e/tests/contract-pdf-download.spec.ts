import { test, expect, USERS, mockAuthAs } from './fixtures'

/**
 * E2E: Phase 6 polish — contract PDF download (Phase 2)
 *
 * Frontend wiring coverage: the «PDF» button on a signed-contract card opens
 * the binary download endpoint. The PDF rendering itself (determinism,
 * pagination, Cyrillic) is unit-tested in contract-pdf.service.spec.ts.
 *
 * Uses the shared /me/audit-trail mock (fixtures) which seeds a contract with
 * id `sc-mock-1`.
 */
test.describe('/crm/profile/audit — contract PDF download', () => {
  test('ADMIN: PDF download button is present on the contract card', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/profile/audit')

    await expect(page.getByTestId('audit-contract-card')).toBeVisible()
    await expect(page.getByTestId('audit-contract-pdf')).toBeVisible()
  })

  test('SENIOR: PDF button is present (self-service for all roles)', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.goto('/crm/profile/audit')

    await expect(page.getByTestId('audit-contract-pdf')).toBeVisible()
  })

  test('ADMIN: clicking «PDF» opens the correct contract PDF endpoint URL', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/profile/audit')
    await expect(page.getByTestId('audit-contract-pdf')).toBeVisible()

    // Stub window.open to capture the target URL — the real endpoint streams a
    // binary attachment (browser download), so a popup never navigates. The
    // PDF generation itself is covered by contract-pdf.service.spec.ts.
    type OpenCapture = { __openedUrl?: string }
    await page.evaluate(() => {
      ;(window as unknown as OpenCapture).__openedUrl = undefined
      window.open = (url?: string | URL): Window | null => {
        ;(window as unknown as OpenCapture).__openedUrl = String(url)
        return null
      }
    })

    await page.getByTestId('audit-contract-pdf').click()

    const openedUrl = await page.evaluate(() => (window as unknown as OpenCapture).__openedUrl)
    // Wiring check: button targets the contract's own PDF endpoint (id format-agnostic).
    expect(openedUrl).toMatch(/\/api\/contracts\/.+\/pdf$/)
  })
})
