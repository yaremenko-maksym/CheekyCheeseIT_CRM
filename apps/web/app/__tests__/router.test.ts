/**
 * PR #1330 SR-M-1 — the app's router hands every `beforeLoad` an `isNavigation` bound to ITSELF:
 * true for the router's own latest location (what a real load loads), false for any location it
 * built for a link (what a hover preload loads). The behaviour on a real router lives in
 * routes/_authenticated/__tests__/route.preload.test.ts; this pins the app's own wiring.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('idb-keyval', () => ({ del: vi.fn(), get: vi.fn(), set: vi.fn() }))

import { createRouter } from '../router'

describe('createRouter context (SR-M-1)', () => {
  it("isNavigation is true for the router's own latest location only", () => {
    const router = createRouter()
    const { isNavigation } = router.options.context

    expect(isNavigation(router.latestLocation)).toBe(true)
    expect(isNavigation(router.buildLocation({ to: router.latestLocation.pathname }))).toBe(false)
  })
})
