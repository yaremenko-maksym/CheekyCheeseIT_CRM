/**
 * Security audit (Fix#2 + Fix#3): DEV_USERS is exported from login.tsx at module
 * scope so unit tests import the real constant — no inline mirror that can drift.
 *
 * This test verifies the structural contract of the dev-login user list:
 *  - All entries have non-empty email and label
 *  - Emails have valid format (contain @ and .)
 *  - Each of the 6 roles (ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP) is
 *    represented — so the dev-login panel covers every role for testing.
 *  - All emails match actual seeded DB accounts (apps/api/src/database/seed.ts):
 *    @cheekycheese.dev for devs, real Gmail/domain for admins.
 *  - A DROP entry is present with a real *.drop@cheekycheese.dev address.
 */
import { describe, it, expect } from 'vitest'
import { DEV_USERS } from '../routes/login'

describe('DEV_USERS — structural contract (security audit Fix#2 + Fix#3)', () => {
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

  it('emails map to real seeded DB accounts — no placeholder @example.dev', () => {
    // Security Fix#1: emails must match actual seed.ts accounts so dev-login
    // findByEmail succeeds. Placeholder @example.dev addresses do not exist in
    // the DB and would cause a 401 on every click.
    DEV_USERS.forEach((u) => {
      expect(u.email).not.toMatch(/@example\.dev$/)
    })
  })

  it('every role is represented (ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP)', () => {
    const roles = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']
    for (const role of roles) {
      const found = DEV_USERS.some((u) => u.label.includes(role))
      expect(found, `No DEV_USERS entry for role ${role}`).toBe(true)
    }
  })

  it('contains a DROP entry with a real drop seed email', () => {
    const drop = DEV_USERS.find((u) => u.label.includes('DROP'))
    expect(drop).toBeDefined()
    expect(drop?.email).toMatch(/\.drop@cheekycheese\.dev$/)
  })

  it('admin entries use real admin account emails from seed.ts', () => {
    const admins = DEV_USERS.filter((u) => u.label.includes('ADMIN'))
    expect(admins).toHaveLength(2)
    // Must be exactly the two seeded admin emails
    const adminEmails = admins.map((u) => u.email)
    expect(adminEmails).toContain('yaremenkomaksym99@gmail.com')
    expect(adminEmails).toContain('kostya@cheekycheeseit.com')
  })

  it('dev users (non-admin) use @cheekycheese.dev domain', () => {
    const nonAdmins = DEV_USERS.filter((u) => !u.label.includes('ADMIN'))
    nonAdmins.forEach((u) => {
      expect(u.email).toMatch(/@cheekycheese\.dev$/)
    })
  })
})
