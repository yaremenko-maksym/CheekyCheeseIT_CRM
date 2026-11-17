/**
 * use-logout — unit coverage for the logout-clear security contract (PR-B #47).
 *
 * Deterministic replacement for the (racy) E2E logout-clear assertion: verifies
 * that triggering logout clears the in-memory TanStack cache AND deletes the
 * persisted IndexedDB key — the exact key the persister writes (PERSIST_KEY).
 * This is the cross-user-leak guard on shared devices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { persistQueryClientSubscribe } from '@tanstack/react-query-persist-client'
import { createElement, type ReactNode } from 'react'

// Mocks via vi.hoisted so the factories can reference them under vitest 4's
// hoisting, and the captured fns carry a param signature (no spread → no TS2556).
const { delMock, postMock, setMock } = vi.hoisted(() => ({
  delMock: vi.fn((_key?: string) => Promise.resolve()),
  postMock: vi.fn((_url?: string) => Promise.resolve({ data: {} })),
  setMock: vi.fn((_key?: string, _value?: string) => Promise.resolve()),
}))
vi.mock('idb-keyval', () => ({ del: delMock, get: vi.fn(), set: setMock }))
vi.mock('@/lib/axios', () => ({ api: { post: postMock } }))

import { useLogout } from './use-logout'
import { PERSIST_KEY, persister } from './persister'
import { isLocaleConfirmedByUser, markLocaleConfirmedByUser } from './i18n'

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

describe('useLogout', () => {
  beforeEach(() => {
    delMock.mockClear()
    postMock.mockClear()
    // Stub the hard-redirect target so happy-dom does not attempt navigation.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    })
  })

  it('hits /auth/logout, clears TanStack cache, and deletes persist key crm-query-cache', async () => {
    const qc = new QueryClient()
    const clearSpy = vi.spyOn(qc, 'clear')

    const { result } = renderHook(() => useLogout(), { wrapper: makeWrapper(qc) })
    result.current()

    await vi.waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/auth/logout')
      expect(clearSpy).toHaveBeenCalledTimes(1)
      expect(delMock).toHaveBeenCalledWith(PERSIST_KEY)
    })

    // PERSIST_KEY is the security contract: the persister writes this exact key.
    expect(PERSIST_KEY).toBe('crm-query-cache')
  })

  it('still clears client state when the logout request fails (best-effort)', async () => {
    postMock.mockImplementationOnce(() => Promise.reject(new Error('network')))
    const qc = new QueryClient()
    const clearSpy = vi.spyOn(qc, 'clear')

    const { result } = renderHook(() => useLogout(), { wrapper: makeWrapper(qc) })
    result.current()

    await vi.waitFor(() => {
      expect(clearSpy).toHaveBeenCalledTimes(1)
      expect(delMock).toHaveBeenCalledWith(PERSIST_KEY)
    })
  })

  // CR-M-3 (fix-round 3, PR #706) — `lib/i18n.ts`'s `confirmedUserLocale`
  // marker is safe TODAY only because logout is a hard navigation, which
  // resets every module-level binding for free. This pins the belt-and-
  // suspenders fix instead: if a future refactor ever swapped the hard
  // `window.location.href` redirect for an in-SPA `navigate()`, a marker
  // left over from a switch made by the PREVIOUS user in this tab would
  // otherwise survive and silently block the NEXT user's own session-locale
  // sync (`AuthProvider`'s effect in `context/auth.tsx`). Deleting the
  // `resetLocaleConfirmation()` call in `use-logout.ts` — the one thing this
  // test actually exercises — makes this fail red.
  it('resets the lib/i18n.ts locale-confirmation marker (CR-M-3 — safe even if logout ever stops hard-navigating)', async () => {
    markLocaleConfirmedByUser('en')
    expect(isLocaleConfirmedByUser('en')).toBe(true)

    const qc = new QueryClient()
    const { result } = renderHook(() => useLogout(), { wrapper: makeWrapper(qc) })
    result.current()

    await vi.waitFor(() => {
      expect(isLocaleConfirmedByUser('en')).toBe(false)
    })
  })

  // PR #1334 SR-L-2: `clear()` runs the persister once per removed query, and the first of those
  // saves still holds the rows not yet removed. Its write lands after the delete unless logout
  // stops persisting first, as the impersonation purge does (`purgePersistedBeforeReload`).
  // Last in this file: the stop is one-way for the module.
  it('no persist write lands after the logout delete, not even one the clear itself started', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['projects', 'list'], [{ name: 'previous-user-project' }])
    qc.setQueryData(['interviews', 'list'], [{ name: 'previous-user-interview' }])
    persistQueryClientSubscribe({ queryClient: qc, persister })
    setMock.mockClear()

    const { result } = renderHook(() => useLogout(), { wrapper: makeWrapper(qc) })
    result.current()
    await vi.waitFor(() => expect(window.location.href).toBe('/login'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(delMock).toHaveBeenCalledWith(PERSIST_KEY)
    expect(setMock).not.toHaveBeenCalled()
  })
})
