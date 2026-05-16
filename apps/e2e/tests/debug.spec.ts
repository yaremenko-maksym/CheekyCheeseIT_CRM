import { test } from '@playwright/test'
import { mockAuthAs, USERS, INTERVIEWS } from './fixtures'

test('debug interviews render', async ({ page }) => {
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message + '\n' + err.stack))

  await mockAuthAs(page, USERS.senior)
  await page.goto('/crm/interviews')
  await page.waitForLoadState('networkidle')

  const { writeFileSync } = await import('fs')
  writeFileSync('/tmp/e2e-debug4.txt', [
    'URL: ' + page.url(),
    '',
    '=== CONSOLE ERRORS ===',
    ...errors,
    '',
    '=== PAGE CONTENT (first 500 chars) ===',
    (await page.content()).slice(0, 500),
  ].join('\n'))
})
