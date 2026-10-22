import type { Page } from '@playwright/test'
import { REAL_API_BASE, withThrottleRetry } from './common'

export async function loginViaApi(page: Page, email: string): Promise<void> {
  const res = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/auth/dev-login`, { data: { email } }),
    `dev-login(${email})`,
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(`dev-login failed for ${email}: HTTP ${res.status()} — ${await res.text()}`)
  }
}

/**
 * Resolve a seed user by email through GET /api/users. Returns `null` if
 * the user isn't found. Useful when a test needs the seed HR / accountant
 * UUIDs to build a CreateDropDto payload.
 */
export async function findUserByEmailViaApi(
  page: Page,
  email: string,
): Promise<{ id: string; displayName: string; role: string } | null> {
  const res = await page.request.get(`${REAL_API_BASE}/api/users`)
  if (res.status() !== 200) return null
  const users = (await res.json()) as Array<{
    id: string
    email: string
    displayName: string
    role: string
  }>
  const found = users.find((u) => u.email === email)
  return found ? { id: found.id, displayName: found.displayName, role: found.role } : null
}
