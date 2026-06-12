import { describe, expect, it } from 'vitest'
import type { Role } from './route-access'
import { isRouteAllowed, navRolesFor, resolveRoleHome } from './route-access'

const ALL: Role[] = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

describe('route-access · resolveRoleHome', () => {
  it('JUNIOR → /crm/project', () => {
    expect(resolveRoleHome('JUNIOR')).toBe('/crm/project')
  })
  it('DROP → /crm/profile', () => {
    expect(resolveRoleHome('DROP')).toBe('/crm/profile')
  })
  it('ADMIN/SENIOR/HR/ACCOUNTANT → /crm/dashboard', () => {
    for (const r of ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT'] as Role[]) {
      expect(resolveRoleHome(r)).toBe('/crm/dashboard')
    }
  })
})

describe('route-access · isRouteAllowed (JUNIOR lockdown — task §4)', () => {
  // The core security guarantee: JUNIOR by direct URL must be denied these.
  const juniorForbidden = [
    '/crm/projects',
    '/crm/projects/abc-123',
    '/crm/team',
    '/crm/team/team-1',
    '/crm/users',
    '/crm/interviews',
    '/crm/stats',
    '/crm/dashboard',
    '/crm/admin/templates/contracts',
  ]
  for (const path of juniorForbidden) {
    it(`JUNIOR denied: ${path}`, () => {
      expect(isRouteAllowed(path, 'JUNIOR')).toBe(false)
    })
  }

  const juniorAllowed = [
    '/crm/project',
    '/crm/legend',
    '/crm/finance',
    '/crm/documents',
    '/crm/profile',
    '/crm/profile/some-user-id',
  ]
  for (const path of juniorAllowed) {
    it(`JUNIOR allowed: ${path}`, () => {
      expect(isRouteAllowed(path, 'JUNIOR')).toBe(true)
    })
  }
})

describe('route-access · isRouteAllowed (other roles not broken)', () => {
  it('ADMIN allowed everywhere in map', () => {
    for (const path of [
      '/crm/projects',
      '/crm/team',
      '/crm/users',
      '/crm/finance',
      '/crm/interviews',
      '/crm/stats',
      '/crm/admin/templates/tos/new',
      '/crm/dashboard',
    ]) {
      expect(isRouteAllowed(path, 'ADMIN')).toBe(true)
    }
  })

  it('SENIOR denied /crm/project (junior hub) and /crm/users/stats', () => {
    expect(isRouteAllowed('/crm/project', 'SENIOR')).toBe(false)
    expect(isRouteAllowed('/crm/users', 'SENIOR')).toBe(false)
    expect(isRouteAllowed('/crm/stats', 'SENIOR')).toBe(false)
  })
  it('SENIOR allowed projects/team/interviews/finance/documents', () => {
    for (const path of [
      '/crm/projects',
      '/crm/team',
      '/crm/interviews',
      '/crm/finance',
      '/crm/documents',
    ]) {
      expect(isRouteAllowed(path, 'SENIOR')).toBe(true)
    }
  })

  it('DROP allowed team/finance/profile, denied projects/dashboard/documents/interviews', () => {
    expect(isRouteAllowed('/crm/team', 'DROP')).toBe(true)
    expect(isRouteAllowed('/crm/finance', 'DROP')).toBe(true)
    expect(isRouteAllowed('/crm/profile', 'DROP')).toBe(true)
    expect(isRouteAllowed('/crm/projects', 'DROP')).toBe(false)
    expect(isRouteAllowed('/crm/dashboard', 'DROP')).toBe(false)
    expect(isRouteAllowed('/crm/documents', 'DROP')).toBe(false)
    expect(isRouteAllowed('/crm/interviews', 'DROP')).toBe(false)
  })

  it('HR allowed dashboard/team/projects/interviews/finance/documents, denied users/stats/junior-hub', () => {
    for (const path of [
      '/crm/dashboard',
      '/crm/team',
      '/crm/projects',
      '/crm/interviews',
      '/crm/finance',
      '/crm/documents',
    ]) {
      expect(isRouteAllowed(path, 'HR')).toBe(true)
    }
    expect(isRouteAllowed('/crm/users', 'HR')).toBe(false)
    expect(isRouteAllowed('/crm/stats', 'HR')).toBe(false)
    expect(isRouteAllowed('/crm/project', 'HR')).toBe(false)
  })

  it('ACCOUNTANT allowed dashboard/team/projects/finance/documents, denied users/interviews/stats/junior-hub', () => {
    for (const path of [
      '/crm/dashboard',
      '/crm/team',
      '/crm/projects',
      '/crm/finance',
      '/crm/documents',
    ]) {
      expect(isRouteAllowed(path, 'ACCOUNTANT')).toBe(true)
    }
    expect(isRouteAllowed('/crm/users', 'ACCOUNTANT')).toBe(false)
    expect(isRouteAllowed('/crm/interviews', 'ACCOUNTANT')).toBe(false)
    expect(isRouteAllowed('/crm/stats', 'ACCOUNTANT')).toBe(false)
    expect(isRouteAllowed('/crm/project', 'ACCOUNTANT')).toBe(false)
  })
})

describe('route-access · uncovered paths fail-open', () => {
  it('unknown/service paths allowed for everyone (e.g. /crm/login, /crm root index)', () => {
    for (const r of ALL) {
      expect(isRouteAllowed('/crm/login', r)).toBe(true)
      expect(isRouteAllowed('/crm', r)).toBe(true)
      // /crm trailing slash root index handled by CrmDashboard component redirect,
      // not by the map — fail-open is intentional here.
      expect(isRouteAllowed('/crm/', r)).toBe(true)
    }
  })

  it('longest-prefix: /crm/projects does NOT match /crm/project (junior hub)', () => {
    // /crm/project (JUNIOR) and /crm/projects (no JUNIOR) must not collide.
    expect(isRouteAllowed('/crm/projects', 'JUNIOR')).toBe(false)
    expect(isRouteAllowed('/crm/project', 'JUNIOR')).toBe(true)
    // SENIOR opposite
    expect(isRouteAllowed('/crm/projects', 'SENIOR')).toBe(true)
    expect(isRouteAllowed('/crm/project', 'SENIOR')).toBe(false)
  })
})

describe('route-access · navRolesFor (nav sync source-of-truth)', () => {
  it('returns roles for known nav routes', () => {
    expect(navRolesFor('/crm/project')).toEqual(['JUNIOR'])
    expect(navRolesFor('/crm/legend')).toEqual(['JUNIOR'])
    expect(navRolesFor('/crm/users')).toEqual(['ADMIN'])
    expect(navRolesFor('/crm/dashboard')).toContain('ADMIN')
    expect(navRolesFor('/crm/dashboard')).not.toContain('JUNIOR')
  })
  it('throws for nav route missing from the map (drift guard)', () => {
    expect(() => navRolesFor('/crm/does-not-exist')).toThrow(/no access entry/)
  })
})
