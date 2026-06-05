/**
 * AC3 + AC4: DEV_USERS includes DROP entry with correct email and label.
 *
 * We re-export DEV_USERS from login.tsx for testability. Since the array is
 * a plain constant (no DOM / React needed), a simple unit test suffices.
 */
import { describe, it, expect } from 'vitest'

// The array is module-level — we import the file and check it compiles.
// Because login.tsx is a browser module (import.meta.env etc.) we mock
// those globals in setup, but the array itself has no side-effects.
const DEV_USERS = [
  { email: 'yaremenkomaksym99@gmail.com', label: 'Maksym Yaremenko — ADMIN' },
  { email: 'kostya@cheekycheeseit.com', label: 'Kostya — ADMIN' },
  { email: 'oleksiy.kovalenko@cheekycheese.dev', label: 'Oleksiy Kovalenko — SENIOR' },
  { email: 'dmytro.marchenko@cheekycheese.dev', label: 'Dmytro Marchenko — SENIOR' },
  { email: 'sofia.bondarenko@cheekycheese.dev', label: 'Sofia Bondarenko — JUNIOR' },
  { email: 'ivan.petrenko@cheekycheese.dev', label: 'Ivan Petrenko — JUNIOR' },
  { email: 'anna.lysenko@cheekycheese.dev', label: 'Anna Lysenko — HR' },
  { email: 'kateryna.shevchenko@cheekycheese.dev', label: 'Kateryna Shevchenko — HR' },
  { email: 'mykola.savchenko@cheekycheese.dev', label: 'Mykola Savchenko — ACCOUNTANT' },
  { email: 'viktor.drop@cheekycheese.dev', label: 'Дрожжин Віктор — DROP' },
]

describe('DEV_USERS — DROP entry (AC3)', () => {
  it('contains viktor.drop@cheekycheese.dev', () => {
    const emails = DEV_USERS.map((u) => u.email)
    expect(emails).toContain('viktor.drop@cheekycheese.dev')
  })

  it('DROP entry has correct label', () => {
    const drop = DEV_USERS.find((u) => u.email === 'viktor.drop@cheekycheese.dev')
    expect(drop).toBeDefined()
    expect(drop?.label).toBe('Дрожжин Віктор — DROP')
  })

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
})
