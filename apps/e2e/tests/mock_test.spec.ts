import { test } from './fixtures'

test('debug edit dialog', async ({ asAdmin: page }) => {
  await page.goto('/crm/users')
  await page.waitForLoadState('networkidle')

  // Find and hover Senior Dev
  await page.getByText('Senior Dev').first().hover()
  await page.waitForTimeout(300)

  // Check what title buttons exist
  const allButtons = await page.getByRole('button').all()
  const buttonTitles = await Promise.all(allButtons.map(b => b.getAttribute('title').catch(() => null)))
  const editCount = await page.getByTitle('Редактировать').count()

  // Try clicking
  const editBtn = page.getByTitle('Редактировать').first()
  const editVisible = await editBtn.isVisible().catch(() => false)

  await editBtn.click({ force: true }).catch(() => {})
  await page.waitForTimeout(500)

  const dialogVisible = await page.getByRole('dialog').isVisible().catch(() => false)
  const inputs = await page.locator('input').all()
  const inputPlaceholders = await Promise.all(inputs.map(i => i.getAttribute('placeholder').catch(() => null)))

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('fs').writeFileSync('/tmp/e2e-edit-debug.txt', [
    'edit button count: ' + editCount,
    'edit button visible: ' + editVisible,
    'button titles: ' + JSON.stringify(buttonTitles.filter(Boolean)),
    'dialog visible: ' + dialogVisible,
    'input placeholders: ' + JSON.stringify(inputPlaceholders),
  ].join('\n'))
})
