/**
 * Security audit Fix#1: persisted IndexedDB query-key prefixes must NOT include
 * team-related keys that carry PII (email, phone, telegram via teamMemberSchema).
 *
 * PERSISTED_KEY_PREFIXES is exported from __root.tsx — we import the real constant
 * so any change to the allow-list is caught immediately (no stale mirror drift).
 */
import { describe, it, expect } from 'vitest'
import type { Query } from '@tanstack/react-query'
import { PERSISTED_KEY_PREFIXES, shouldDehydrateQuery } from '../routes/__root'
import { PENDING_QUERY_KEY } from '../hooks/use-pending-items'

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

  // SR-L-5 / CR-bm-2 (PR #646 fix-round 4), carried forward by
  // task-pending-screen onto the key that replaced PENDING_APPROVALS_QUERY_KEY.
  // Checks the REAL constant instead of a copy of its literal key, so a
  // future allow-list change is caught here, not just by a same-file mirror.
  it("SR-L-5 / CR-bm-2: PENDING_APPROVALS_QUERY_KEY's successor is NOT in the allow-list", () => {
    expect(PERSISTED_KEY_PREFIXES.has(String(PENDING_QUERY_KEY[0]))).toBe(false)
  })

  // AC3 (task-pending-screen, client half): the ACTUAL dehydrate predicate
  // __root.tsx uses, exercised against a real successful `pending` query
  // carrying a SHARE_APPROVAL item's `pendingPercent` — proves that field
  // never reaches whatever `shouldDehydrateQuery` decides gets written to
  // `crm-query-cache`, not just that the key's literal string is absent from
  // a Set.
  //
  // SR-L-4 (PR #667 fix-round 2): imports the REAL `shouldDehydrateQuery`
  // from `__root.tsx` instead of a same-file copy of the predicate — a copy
  // proves nothing about `__root.tsx` itself: change ITS keying (e.g.
  // `queryKey[1]`) or add an `||` branch there and a mirrored copy here
  // stays green while `pendingPercent` starts landing in `crm-query-cache`.
  it('AC3: shouldDehydrateQuery rejects a successful `pending` query outright — pendingPercent never reaches the dehydrated snapshot', () => {
    const pendingQuery = {
      state: { status: 'success' as const },
      queryKey: PENDING_QUERY_KEY,
      data: { mine: [{ kind: 'SHARE_APPROVAL', pendingPercent: 30 }], proposedByMe: [] },
    } as unknown as Query

    expect(shouldDehydrateQuery(pendingQuery)).toBe(false)
  })

  // mutation-gate (PR #667 fix-round 2): the AC3 case above only exercises
  // ONE outcome (false, via a disallowed key) — a mutant that forces
  // shouldDehydrateQuery to unconditionally return false, or that deletes
  // the status check entirely, changes nothing that single case can see.
  // These two pin the OTHER dimension: an allow-listed key still needs
  // status === 'success' (not merely truthy/present), and a genuinely
  // dehydratable query must come back true, not just "not this false case".
  it('shouldDehydrateQuery: an allow-listed key with status "success" is true', () => {
    const query = {
      state: { status: 'success' as const },
      queryKey: ['projects'],
    } as unknown as Query

    expect(shouldDehydrateQuery(query)).toBe(true)
  })

  it('shouldDehydrateQuery: an allow-listed key that is still pending (not "success") is false', () => {
    const query = {
      state: { status: 'pending' as const },
      queryKey: ['projects'],
    } as unknown as Query

    expect(shouldDehydrateQuery(query)).toBe(false)
  })
})
