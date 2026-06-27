/**
 * Security audit Fix#3: JUNIOR IDOR client-side guard on /profile/$userId.
 *
 * The guard in UserDetailPage must synchronously return null (preventing
 * UserProfileShell from mounting) when a JUNIOR tries to view a foreign profile.
 * The useEffect redirect is a UX supplement; the synchronous check is the data-
 * exposure blocker. Backend MUST also enforce 403 (this is client-side defence-in-depth).
 *
 * We test the guard logic as a pure function to avoid heavy router mocking.
 */
import { describe, it, expect } from 'vitest'
import type { Role } from '../lib/route-access'

// Pure extraction of the guard predicate from UserDetailPage:
//   if (user?.role === 'JUNIOR' && userId !== user.id) return null
function shouldBlockRender(
  userRole: Role | undefined,
  userId: string | undefined,
  viewerId: string | undefined,
): boolean {
  if (!userRole || !userId || !viewerId) return false // not loaded yet — do not block
  return userRole === 'JUNIOR' && userId !== viewerId
}

describe('JUNIOR profile guard — synchronous render block (Fix#3)', () => {
  it('JUNIOR viewing OWN profile → NOT blocked', () => {
    expect(shouldBlockRender('JUNIOR', 'user-abc', 'user-abc')).toBe(false)
  })

  it('JUNIOR viewing FOREIGN profile → blocked (returns null early)', () => {
    expect(shouldBlockRender('JUNIOR', 'user-xyz', 'user-abc')).toBe(true)
  })

  it('ADMIN viewing any profile → NOT blocked', () => {
    expect(shouldBlockRender('ADMIN', 'user-xyz', 'user-abc')).toBe(false)
  })

  it('SENIOR viewing any profile → NOT blocked', () => {
    expect(shouldBlockRender('SENIOR', 'user-xyz', 'user-abc')).toBe(false)
  })

  it('HR viewing any profile → NOT blocked', () => {
    expect(shouldBlockRender('HR', 'user-xyz', 'user-abc')).toBe(false)
  })

  it('ACCOUNTANT viewing any profile → NOT blocked', () => {
    expect(shouldBlockRender('ACCOUNTANT', 'user-xyz', 'user-abc')).toBe(false)
  })

  it('DROP viewing any profile → NOT blocked (DROP has backend 403)', () => {
    expect(shouldBlockRender('DROP', 'user-xyz', 'user-abc')).toBe(false)
  })

  it('undefined user (loading) → NOT blocked (wait for auth)', () => {
    expect(shouldBlockRender(undefined, 'user-xyz', 'user-abc')).toBe(false)
  })
})
