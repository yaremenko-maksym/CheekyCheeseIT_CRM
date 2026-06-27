import { describe, expect, it } from 'vitest'
import type { Role } from './route-access'
import {
  DASHBOARD_NAV_ROLES,
  isRouteAllowed,
  navRolesFor,
  resolveRoleHome,
  resolveRouteAccess,
} from './route-access'

const ALL: Role[] = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

describe('route-access · resolveRoleHome', () => {
  it('JUNIOR → /project', () => {
    expect(resolveRoleHome('JUNIOR')).toBe('/project')
  })
  // Dashboard consolidation: home для всех ролей (вкл. DROP/ACCOUNTANT/HR) — корень
  // /, который рендерит роль-зависимый дашборд. Отдельного /dashboard больше нет.
  it('DROP → /', () => {
    expect(resolveRoleHome('DROP')).toBe('/')
  })
  it('ADMIN/SENIOR/HR/ACCOUNTANT → /', () => {
    for (const r of ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT'] as Role[]) {
      expect(resolveRoleHome(r)).toBe('/')
    }
  })
})

describe('route-access · isRouteAllowed (JUNIOR lockdown — task §4)', () => {
  // The core security guarantee: JUNIOR by direct URL must be denied these.
  const juniorForbidden = [
    '/projects',
    '/projects/abc-123',
    '/team',
    '/team/team-1',
    '/users',
    '/interviews',
    '/stats',
    '/admin/contracts',
  ]
  for (const path of juniorForbidden) {
    it(`JUNIOR denied: ${path}`, () => {
      expect(isRouteAllowed(path, 'JUNIOR')).toBe(false)
    })
  }

  const juniorAllowed = [
    '/project',
    '/legend',
    '/finance',
    '/documents',
    '/profile',
    '/profile/some-user-id',
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
      '/projects',
      '/team',
      '/users',
      '/finance',
      '/interviews',
      '/stats',
      '/admin/tos/new',
      '/', // consolidated dashboard root
    ]) {
      expect(isRouteAllowed(path, 'ADMIN')).toBe(true)
    }
  })

  it('SENIOR denied /project (junior hub) and /users/stats', () => {
    expect(isRouteAllowed('/project', 'SENIOR')).toBe(false)
    expect(isRouteAllowed('/users', 'SENIOR')).toBe(false)
    expect(isRouteAllowed('/stats', 'SENIOR')).toBe(false)
  })
  it('SENIOR allowed projects/team/interviews/finance/documents', () => {
    for (const path of ['/projects', '/team', '/interviews', '/finance', '/documents']) {
      expect(isRouteAllowed(path, 'SENIOR')).toBe(true)
    }
  })

  it('DROP allowed root/routing/team/finance/profile/documents, denied projects/interviews', () => {
    // Dashboard consolidation: DROP home — корень / (fail-open, доступен всем).
    // /routing — deprecated редирект-роут (→ /), остаётся DROP-only.
    // /documents — DROP имеет отдельную страницу документов (page-not-tab model).
    expect(isRouteAllowed('/', 'DROP')).toBe(true)
    expect(isRouteAllowed('/routing', 'DROP')).toBe(true)
    expect(isRouteAllowed('/team', 'DROP')).toBe(true)
    expect(isRouteAllowed('/finance', 'DROP')).toBe(true)
    expect(isRouteAllowed('/profile', 'DROP')).toBe(true)
    expect(isRouteAllowed('/documents', 'DROP')).toBe(true)
    expect(isRouteAllowed('/projects', 'DROP')).toBe(false)
    expect(isRouteAllowed('/interviews', 'DROP')).toBe(false)
    // /routing is DROP-only: other roles denied.
    expect(isRouteAllowed('/routing', 'SENIOR')).toBe(false)
    expect(isRouteAllowed('/routing', 'ADMIN')).toBe(false)
    expect(isRouteAllowed('/routing', 'JUNIOR')).toBe(false)
  })

  it('HR allowed root/team/projects/interviews/finance/documents, denied users/stats/junior-hub', () => {
    for (const path of [
      '/', // consolidated dashboard root
      '/team',
      '/projects',
      '/interviews',
      '/finance',
      '/documents',
    ]) {
      expect(isRouteAllowed(path, 'HR')).toBe(true)
    }
    expect(isRouteAllowed('/users', 'HR')).toBe(false)
    expect(isRouteAllowed('/stats', 'HR')).toBe(false)
    expect(isRouteAllowed('/project', 'HR')).toBe(false)
  })

  it('ACCOUNTANT allowed root/team/projects/finance/documents/stats, denied users/interviews/junior-hub', () => {
    for (const path of [
      '/', // consolidated dashboard root
      '/team',
      '/projects',
      '/finance',
      '/documents',
      // task-accountant-stats: ACCOUNTANT gets the stats section (economic part
      // only — non-economic sub-sections are gated ADMIN-only inside stats.tsx).
      '/stats',
    ]) {
      expect(isRouteAllowed(path, 'ACCOUNTANT')).toBe(true)
    }
    expect(isRouteAllowed('/users', 'ACCOUNTANT')).toBe(false)
    expect(isRouteAllowed('/interviews', 'ACCOUNTANT')).toBe(false)
    expect(isRouteAllowed('/project', 'ACCOUNTANT')).toBe(false)
  })
})

describe('route-access · uncovered paths — fail-open for service, fail-closed for CRM', () => {
  it('service paths / and /login remain fail-open for all roles', () => {
    for (const r of ALL) {
      // /login — pre-auth page outside _authenticated layout.
      expect(isRouteAllowed('/login', r)).toBe(true)
      // / root — role-dispatch dashboard; intentionally not in ROUTE_ACCESS
      // (accessible to all authenticated roles; per-role content in component).
      expect(isRouteAllowed('/', r)).toBe(true)
    }
  })

  it('unknown CRM path not in ROUTE_ACCESS is fail-CLOSED (security hardening)', () => {
    // Security fix (audit): previously any unmapped path returned `true` (fail-open).
    // Now: only explicit service paths (/ and /login) are exempted.
    // A forgotten ROUTE_ACCESS entry → denied at runtime, not silently opened.
    for (const r of ALL) {
      expect(isRouteAllowed('/unknown-crm-section', r)).toBe(false)
      expect(isRouteAllowed('/some/nested/path', r)).toBe(false)
    }
  })

  // Dashboard consolidation (AC5): корень / — единственная home-страница CRM и
  // рендерит роль-зависимый дашборд. Он ДОЛЖЕН быть доступен ВСЕМ аутентифицированным
  // ролям (вкл. DROP), иначе роль ловит 403/пустую страницу на собственном home.
  it('AC5: / root is allowed for ALL authenticated roles incl DROP', () => {
    for (const r of ALL) {
      expect(isRouteAllowed('/', r)).toBe(true)
      expect(isRouteAllowed('/', r)).toBe(true)
    }
    expect(isRouteAllowed('/', 'DROP')).toBe(true)
  })

  it('longest-prefix: /projects does NOT match /project (junior hub)', () => {
    // /project (JUNIOR) and /projects (no JUNIOR) must not collide.
    expect(isRouteAllowed('/projects', 'JUNIOR')).toBe(false)
    expect(isRouteAllowed('/project', 'JUNIOR')).toBe(true)
    // SENIOR opposite
    expect(isRouteAllowed('/projects', 'SENIOR')).toBe(true)
    expect(isRouteAllowed('/project', 'SENIOR')).toBe(false)
  })
})

describe('route-access · navRolesFor (nav sync source-of-truth)', () => {
  it('returns roles for known nav routes', () => {
    expect(navRolesFor('/project')).toEqual(['JUNIOR'])
    expect(navRolesFor('/legend')).toEqual(['JUNIOR'])
    expect(navRolesFor('/users')).toEqual(['ADMIN'])
  })
  // Dashboard consolidation: nav-пункт «Дашборд» ведёт на корень /; его роли —
  // отдельная константа DASHBOARD_NAV_ROLES (не route-access запись, т.к. / —
  // fail-open). Пункт виден всем, кроме JUNIOR (у них свой хаб «Мой проект»).
  it('DASHBOARD_NAV_ROLES: «Дашборд» visible to ADMIN+DROP, hidden for JUNIOR', () => {
    expect(DASHBOARD_NAV_ROLES).toContain('ADMIN')
    expect(DASHBOARD_NAV_ROLES).toContain('SENIOR')
    expect(DASHBOARD_NAV_ROLES).toContain('HR')
    expect(DASHBOARD_NAV_ROLES).toContain('ACCOUNTANT')
    expect(DASHBOARD_NAV_ROLES).toContain('DROP')
    expect(DASHBOARD_NAV_ROLES).not.toContain('JUNIOR')
  })
  // task-accountant-stats: «Статистика» nav item must surface for ACCOUNTANT
  // (so the section is reachable) and ADMIN — and STAY hidden for everyone else.
  it('/stats nav roles = ADMIN + ACCOUNTANT only', () => {
    const statsRoles = navRolesFor('/stats')
    expect(statsRoles).toContain('ADMIN')
    expect(statsRoles).toContain('ACCOUNTANT')
    for (const r of ['SENIOR', 'JUNIOR', 'HR', 'DROP'] as Role[]) {
      expect(statsRoles).not.toContain(r)
    }
  })
  it('throws for nav route missing from the map (drift guard)', () => {
    expect(() => navRolesFor('/does-not-exist')).toThrow(/no access entry/)
  })
})

// ── LOW-7 / Security-hardening: ROUTE_ACCESS coverage invariant ─────────────
// After the fail-closed fix (audit), unmapped routes return false at runtime.
// This invariant catches the mapping gap at test time (before push), while the
// runtime guard catches it in production: a forgotten map entry now denies the
// page instead of silently opening it to every role. Both layers are needed:
// tests give a clear "Add an entry to ROUTE_ACCESS" message; runtime denies if
// tests weren't run. This invariant enumerates every route FILE under
// routes/_authenticated/** and asserts each navigable route is mapped.
describe('route-access · ROUTE_ACCESS coverage invariant (no silent fail-open)', () => {
  // Enumerate route modules at build time (Vite glob). Keys are absolute-ish
  // module paths under app/routes/_authenticated (the pathless auth-shell layout
  // that wraps the whole CRM after the /crm/* → /* re-root).
  const routeFiles = Object.keys(
    import.meta.glob('../routes/_authenticated/**/*.{ts,tsx}', { eager: false }),
  )

  // Files that legitimately do NOT need a ROUTE_ACCESS entry:
  //  - `route.tsx`      → pathless layout wrapper, not a navigable leaf
  //  - `_authenticated/index.tsx` → `/` role-dispatch dashboard (fail-open by
  //    design — доступен всем аутентифицированным ролям; per-role контент в компоненте)
  //  - non-route modules colocated under routes/ (api/constants/hooks/sort/
  //    components/__tests__) — not navigable routes
  const isExempt = (rel: string): boolean => {
    if (rel.endsWith('/route.tsx')) return true
    if (rel === '_authenticated/index.tsx') return true // / root role-dispatch dashboard (fail-open)
    if (/\/(components|__tests__)\//.test(rel)) return true
    if (/\.(spec|test)\.tsx?$/.test(rel)) return true
    // Colocated non-route helpers (finance/api.ts, interviews/constants.ts, …).
    if (/\/(api|constants|sort|hooks)\.(ts|tsx)$/.test(rel)) return true
    if (rel.endsWith('.ts') && !rel.endsWith('index.ts')) return true
    return false
  }

  /**
   * Translate a TanStack file-based route path into a representative URL the
   * guard would see. The pathless `_authenticated/` layout segment is stripped
   * (it never appears in the URL). We only need the TOP-LEVEL section to assert
   * prefix coverage, so dynamic/flat segments collapse to a concrete-ish sample.
   *   _authenticated/stats.tsx                → /stats
   *   _authenticated/projects/$projectId.tsx  → /projects/sample
   *   _authenticated/admin/contracts.index.tsx → /admin/contracts
   *   _authenticated/team/$teamId.tsx         → /team/sample
   */
  const toPathname = (rel: string): string => {
    // Drop the pathless layout segment — it does not contribute a URL part.
    let p = rel.replace(/^_authenticated\//, '')
    p = p.replace(/\.tsx?$/, '')
    p = p.replace(/\/index$/, '') // index → parent dir
    // flat-route dots → path separators (contracts.index, initiate.$incomeId)
    p = p.replace(/\./g, '/').replace(/\/index$/, '')
    // dynamic params → a concrete sample segment
    p = p.replace(/\$[^/]+/g, 'sample')
    return `/${p}`
  }

  const navigableRoutes = routeFiles
    .map((f) => f.replace(/^\.\.\/routes\//, '')) // → _authenticated/stats.tsx
    .filter((rel) => !isExempt(rel))

  it('discovers a non-trivial set of crm route files (glob sanity)', () => {
    // Guard against the glob silently matching nothing (which would make the
    // whole invariant vacuously pass).
    expect(navigableRoutes.length).toBeGreaterThanOrEqual(10)
  })

  for (const rel of navigableRoutes) {
    const pathname = toPathname(rel)
    it(`route ${rel} (${pathname}) has a ROUTE_ACCESS entry`, () => {
      expect(
        resolveRouteAccess(pathname),
        `No ROUTE_ACCESS entry covers "${pathname}" (file routes/${rel}). ` +
          `Add a { prefix, roles } entry to ROUTE_ACCESS or mark the file exempt.`,
      ).not.toBeNull()
    })
  }
})
