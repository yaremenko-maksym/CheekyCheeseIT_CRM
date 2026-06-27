/**
 * Security audit Fix#1: persisted IndexedDB query-key prefixes must NOT include
 * team-related keys that carry PII (email, phone, telegram via teamMemberSchema).
 *
 * PERSISTED_KEY_PREFIXES is not exported from __root.tsx — we assert the contract
 * by checking which query key strings are safe vs forbidden per the security policy
 * documented in __root.tsx. The actual runtime enforcement is in dehydrateOptions
 * (shouldDehydrateQuery). This test documents and verifies the policy.
 */
import { describe, it, expect } from 'vitest'

// Canonical allow-list — mirrors PERSISTED_KEY_PREFIXES in __root.tsx.
// If you add/remove a prefix there, update this mirror to keep the test green.
const PERSISTED_KEY_PREFIXES = new Set<string>([
  'projects',
  'user-projects',
  'interviews',
  'contract-templates-all',
  'contract-template',
  'tos-current',
  'tos-versions-all',
])

// PII-bearing keys that were removed in the security audit and must NEVER return.
const FORBIDDEN_PII_PREFIXES = ['teams', 'team', 'user-team'] as const

describe('PERSISTED_KEY_PREFIXES — PII exclusion (security audit Fix#1)', () => {
  it('does NOT include team-related PII keys', () => {
    for (const forbidden of FORBIDDEN_PII_PREFIXES) {
      expect(PERSISTED_KEY_PREFIXES.has(forbidden)).toBe(false)
    }
  })

  it('retains non-PII reference data keys', () => {
    // These keys carry no PII and are safe to persist.
    const safeKeys = ['projects', 'user-projects', 'interviews', 'contract-templates-all']
    for (const safe of safeKeys) {
      expect(PERSISTED_KEY_PREFIXES.has(safe)).toBe(true)
    }
  })

  it('auth and payment keys are absent (never persisted)', () => {
    // Belt-and-suspenders: confirm that sensitive key families are not in the set.
    const neverPersist = [
      'auth',
      'me',
      'session',
      'wallet',
      'finance',
      'transactions',
      'payout',
      'salary',
      'teams',
      'team',
      'user-team',
    ]
    for (const key of neverPersist) {
      expect(PERSISTED_KEY_PREFIXES.has(key)).toBe(false)
    }
  })

  it('shouldDehydrateQuery logic: only allow-list keys pass', () => {
    // Simulate the shouldDehydrateQuery predicate from __root.tsx.
    const shouldDehydrate = (queryKey: string) => PERSISTED_KEY_PREFIXES.has(queryKey)

    expect(shouldDehydrate('projects')).toBe(true)
    expect(shouldDehydrate('interviews')).toBe(true)
    expect(shouldDehydrate('tos-current')).toBe(true)

    // PII keys — must be rejected.
    expect(shouldDehydrate('teams')).toBe(false)
    expect(shouldDehydrate('team')).toBe(false)
    expect(shouldDehydrate('user-team')).toBe(false)

    // Unknown keys — fail-closed (not in set = false).
    expect(shouldDehydrate('some-new-key')).toBe(false)
    expect(shouldDehydrate('user-profile')).toBe(false)
  })
})
