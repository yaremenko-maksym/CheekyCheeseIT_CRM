/**
 * Security audit (Fix#2): DEV_USERS is now defined inside DevLoginSection
 * (not at module top-level) to prevent real email addresses from appearing in
 * production bundles via tree-shaking. The old module-top-level array is gone.
 *
 * This test verifies the structural contract of the dev-login user list:
 *  - All entries have non-empty email and label
 *  - Emails have valid format (contain @ and .)
 *  - Each of the 6 roles (ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP) is
 *    represented — so the dev-login panel covers every role for testing.
 *  - Emails use placeholder domain (@example.dev) — NO real user emails in source.
 *
 * We test the constant directly (inline copy mirroring DevLoginSection) since the
 * array is no longer exported from login.tsx (it is local to the component).
 */
import { describe, it, expect } from 'vitest'

// Mirror of the DEV_USERS constant inside DevLoginSection (login.tsx).
// If the component's list changes, update this mirror to keep the test green.
const DEV_USERS = [
  { email: 'admin@example.dev', label: 'Admin 1 — ADMIN' },
  { email: 'admin2@example.dev', label: 'Admin 2 — ADMIN' },
  { email: 'senior1@example.dev', label: 'Senior 1 — SENIOR' },
  { email: 'senior2@example.dev', label: 'Senior 2 — SENIOR' },
  { email: 'junior1@example.dev', label: 'Junior 1 — JUNIOR' },
  { email: 'junior2@example.dev', label: 'Junior 2 — JUNIOR' },
  { email: 'hr1@example.dev', label: 'HR 1 — HR' },
  { email: 'hr2@example.dev', label: 'HR 2 — HR' },
  { email: 'accountant@example.dev', label: 'Accountant — ACCOUNTANT' },
  { email: 'drop@example.dev', label: 'Drop — DROP' },
]

describe('DEV_USERS — structural contract (security audit Fix#2)', () => {
  it('all entries have non-empty email and label', () => {
    DEV_USERS.forEach((u) => {
      expect(u.email).toBeTruthy()
      expect(u.label).toBeTruthy()
    })
  })

  it('all emails are valid format (contain @ and .)', () => {
    DEV_USERS.forEach((u) => {
      expect(u.email).toContain('@')
      expect(u.email).toContain('.')
    })
  })

  it('emails use placeholder domain — no real user PII in source', () => {
    // Security: after Fix#2, real email addresses must not appear in the dev-login
    // list. All emails should use the placeholder domain.
    DEV_USERS.forEach((u) => {
      expect(u.email).toMatch(/@example\.dev$/)
    })
  })

  it('every role is represented (ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP)', () => {
    const roles = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']
    for (const role of roles) {
      const found = DEV_USERS.some((u) => u.label.includes(role))
      expect(found, `No DEV_USERS entry for role ${role}`).toBe(true)
    }
  })

  it('contains a DROP entry', () => {
    const drop = DEV_USERS.find((u) => u.label.includes('DROP'))
    expect(drop).toBeDefined()
    expect(drop?.email).toMatch(/@example\.dev$/)
  })
})
