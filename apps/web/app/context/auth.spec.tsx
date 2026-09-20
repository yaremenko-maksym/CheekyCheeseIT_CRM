/**
 * Unit tests for AuthProvider — isRestoring race-fix (PR-B #47)
 *
 * Verifies that when useIsRestoring() returns true, the AuthContext exposes
 * isLoading=true even when the underlying useQuery has isPending=true and
 * isFetching=false (the transient window that caused the redirect bug).
 *
 * This is the central contract of the isRestoring Option A fix in auth.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// We need to control useIsRestoring and useQuery return values.
// Mock both at the module level so we can override per-test via a shared ref.
// Using a mutable ref avoids generic type issues with vi.fn<> signatures.
// ---------------------------------------------------------------------------
let isRestoringValue = false
let queryResult: { data: unknown; isPending: boolean; isFetching: boolean } = {
  data: undefined,
  isPending: false,
  isFetching: false,
}

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...original,
    useIsRestoring: () => isRestoringValue,
    useQuery: () => queryResult,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  }
})

// task-i18n-stage2 (Task 6) — `activateLocale` alone is mocked; `i18n` stays
// the REAL `@lingui/core` singleton (`importOriginal`). `I18n#locale` is a
// getter with no public setter (only `.activate()`/`.loadAndActivate()` can
// change it — see @lingui/core's type declarations), so a hand-rolled fake
// object typed as `I18n` would not typecheck; the real instance plus
// `i18n.load('uk', {})` + `i18n.activate('uk')` (the exact pattern
// `i18n-smoke.test.tsx` already uses) sidesteps that without needing the
// real dynamic `.po` import at all — this file tests the EFFECT's calling
// logic, not `activateLocale`'s own implementation (that is
// `app/lib/__tests__/i18n.test.tsx`'s job; the real DOM `<html lang>`
// end-to-end proof is `apps/e2e/tests/auth.spec.ts`).
vi.mock('../lib/i18n', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/i18n')>()
  return {
    ...original,
    activateLocale: vi.fn(),
  }
})

// Import after mocks
import { AuthProvider, useAuth } from './auth'
import { i18n, activateLocale } from '../lib/i18n'

// ---------------------------------------------------------------------------
// Wrapper factory
// ---------------------------------------------------------------------------
function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProvider — isRestoring race-fix', () => {
  beforeEach(() => {
    isRestoringValue = false
    queryResult = { data: undefined, isPending: false, isFetching: false }
  })

  it('isLoading=true when isRestoring=true even if query is not fetching', () => {
    // This is the exact race-condition window:
    // PersistQueryClientProvider is restoring IDB → isRestoring=true
    // Query has not started yet → isPending=true, isFetching=false
    // Old behaviour: isLoading = isPending && isFetching = false → redirect bug
    // New behaviour: isLoading = isRestoring || (isPending && isFetching) = true
    isRestoringValue = true
    queryResult = { data: undefined, isPending: true, isFetching: false }

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(true)
    expect(result.current.user).toBeNull()
  })

  it('isLoading=true when isRestoring=false but query is fetching (normal network wait)', () => {
    // After restore completes, the real /api/auth/me is in-flight.
    isRestoringValue = false
    queryResult = { data: undefined, isPending: true, isFetching: true }

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(true)
    expect(result.current.user).toBeNull()
  })

  it('isLoading=false and user set after successful auth (isRestoring=false, query done)', () => {
    const mockUser = {
      id: 'a0000000-0000-4000-8000-000000000001',
      email: 'admin@cheekycheese.dev',
      displayName: 'Admin User',
      role: 'ADMIN',
    }
    isRestoringValue = false
    queryResult = { data: mockUser, isPending: false, isFetching: false }

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.user).toEqual(mockUser)
  })

  it('isLoading=false and user=null when auth/me returns null (unauthenticated)', () => {
    isRestoringValue = false
    queryResult = { data: null, isPending: false, isFetching: false }

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.user).toBeNull()
  })

  it('isLoading=true when both isRestoring=true AND query is fetching', () => {
    // Edge case: both conditions active simultaneously.
    isRestoringValue = true
    queryResult = { data: undefined, isPending: true, isFetching: true }

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(true)
  })
})

describe('AuthProvider — locale activation from /auth/me', () => {
  const mockUser = {
    id: 'a0000000-0000-4000-8000-000000000001',
    email: 'admin@cheekycheese.dev',
    displayName: 'Admin User',
    role: 'ADMIN',
  }

  beforeEach(() => {
    isRestoringValue = false
    queryResult = { data: undefined, isPending: false, isFetching: false }
    vi.mocked(activateLocale).mockClear()
    // Real i18n singleton, no dynamic .po import needed — `.load()` with an
    // empty catalog is enough for `.activate()` to accept the locale (same
    // pattern as `i18n-smoke.test.tsx`).
    i18n.load('uk', {})
    i18n.activate('uk')
  })

  it('calls activateLocale when the session locale differs from the active one', () => {
    queryResult = { data: { ...mockUser, locale: 'en' }, isPending: false, isFetching: false }

    renderHook(() => useAuth(), { wrapper })

    expect(activateLocale).toHaveBeenCalledWith('en')
  })

  it('does not call activateLocale when the session locale already matches the active one', () => {
    queryResult = { data: { ...mockUser, locale: 'uk' }, isPending: false, isFetching: false }

    renderHook(() => useAuth(), { wrapper })

    expect(activateLocale).not.toHaveBeenCalled()
  })

  it('re-fires on a LATER render when the session locale changes, not only on mount', () => {
    // Kills a `[data?.locale] → []` dependency-array mutant: with an empty
    // array the effect would run once on mount and never again, so a locale
    // that only becomes known on a later render (the realistic case — the
    // very first render has `data: undefined`, /auth/me resolves after)
    // would silently never activate.
    queryResult = { data: { ...mockUser, locale: 'uk' }, isPending: false, isFetching: false }
    const { rerender } = renderHook(() => useAuth(), { wrapper })
    expect(activateLocale).not.toHaveBeenCalled()

    queryResult = { data: { ...mockUser, locale: 'en' }, isPending: false, isFetching: false }
    rerender()

    expect(activateLocale).toHaveBeenCalledWith('en')
    expect(activateLocale).toHaveBeenCalledTimes(1)
  })
})
