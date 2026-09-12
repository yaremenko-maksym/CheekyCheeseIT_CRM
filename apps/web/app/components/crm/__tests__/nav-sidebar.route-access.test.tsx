/**
 * `NAV_ITEMS` is built at MODULE LOAD from `route-access`'s `navRolesFor`,
 * which THROWS for a route id that has no entry there (that is the whole
 * point of the SSOT: a menu item cannot quietly exist with no role map).
 * This file pins that load-time invariant.
 *
 * Why a separate file with a DYNAMIC import, rather than a case inside
 * `nav-sidebar.test.tsx`: a module-level failure only happens while the
 * module is being evaluated, and a static `import` at the top of a spec is
 * evaluated during collection — before any individual test runs. A case
 * added to the existing file would therefore observe the already-cached
 * module and could never see the failure. Importing inside the test body,
 * from a file that never imports the module statically, is what makes the
 * invariant observable at all (and is also what lets the mutation gate see
 * it — a broken nav `to` is otherwise an unkillable load-time mutant).
 */
import { describe, expect, it } from 'vitest'

describe('NavSidebar — every nav `to` is a real route-access entry', () => {
  it('the module loads: a nav route id missing from ROUTE_ACCESS fails HERE, not with a role-less menu item in production', async () => {
    const mod = await import('../nav-sidebar')

    expect(typeof mod.NavSidebar).toBe('function')
  })

  it('«Ждут решения» (/pending) is one of those entries — its roles come from the SSOT, not from a literal in the menu', async () => {
    const { navRolesFor } = await import('@/lib/route-access')

    // If `/pending` were not registered, the nav module above could not have
    // loaded at all; this is the positive half of the same fact, and it
    // names the roles the screen is actually reachable by.
    expect(navRolesFor('/pending')).toContain('SENIOR')
    expect(() => navRolesFor('')).toThrow()
  })
})
