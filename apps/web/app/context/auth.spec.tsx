/**
 * Unit tests for AuthProvider — isRestoring race-fix (PR-B #47)
 *
 * Verifies that when useIsRestoring() returns true, the AuthContext exposes
 * isLoading=true even when the underlying useQuery has isPending=true and
 * isFetching=false (the transient window that caused the redirect bug).
 *
 * This is the central contract of the isRestoring Option A fix in auth.tsx.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// We need to control useIsRestoring and useQuery return values.
// Mock both at the module level so we can override per-test.
// ---------------------------------------------------------------------------
const mockUseIsRestoring = vi.fn<[], boolean>()
const mockUseQuery = vi.fn()
const mockUseQueryClient = vi.fn(() => ({
  invalidateQueries: vi.fn(),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...original,
    useIsRestoring: () => mockUseIsRestoring(),
    useQuery: () => mockUseQuery(),
    useQueryClient: () => mockUseQueryClient(),
  }
})

// Import after mocks
import { AuthProvider, useAuth } from './auth'

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
  it('isLoading=true when isRestoring=true even if query is not fetching', () => {
    // This is the exact race-condition window:
    // PersistQueryClientProvider is restoring IDB → isRestoring=true
    // Query has not started yet → isPending=true, isFetching=false
    // Old behaviour: isLoading = isPending && isFetching = false → redirect bug
    // New behaviour: isLoading = isRestoring || (isPending && isFetching) = true
    mockUseIsRestoring.mockReturnValue(true)
    mockUseQuery.mockReturnValue({ data: undefined, isPending: true, isFetching: false })

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(true)
    expect(result.current.user).toBeNull()
  })

  it('isLoading=true when isRestoring=false but query is fetching (normal network wait)', () => {
    // After restore, the real /api/auth/me is in-flight.
    mockUseIsRestoring.mockReturnValue(false)
    mockUseQuery.mockReturnValue({ data: undefined, isPending: true, isFetching: true })

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(true)
    expect(result.current.user).toBeNull()
  })

  it('isLoading=false and user=ADMIN after successful auth (isRestoring=false, query done)', () => {
    const mockUser = {
      id: 'a0000000-0000-4000-8000-000000000001',
      email: 'admin@cheekycheese.dev',
      displayName: 'Admin User',
      role: 'ADMIN',
    }
    mockUseIsRestoring.mockReturnValue(false)
    mockUseQuery.mockReturnValue({ data: mockUser, isPending: false, isFetching: false })

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.user).toEqual(mockUser)
  })

  it('isLoading=false and user=null when auth/me returns null (unauthenticated)', () => {
    mockUseIsRestoring.mockReturnValue(false)
    mockUseQuery.mockReturnValue({ data: null, isPending: false, isFetching: false })

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.user).toBeNull()
  })

  it('isLoading=true when both isRestoring=true AND query is fetching', () => {
    // Edge case: both conditions active simultaneously (shouldn't normally happen
    // but must not cause isLoading=false).
    mockUseIsRestoring.mockReturnValue(true)
    mockUseQuery.mockReturnValue({ data: undefined, isPending: true, isFetching: true })

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(true)
  })
})
