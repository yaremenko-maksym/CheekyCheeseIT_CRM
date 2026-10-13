import type { Page } from '@playwright/test'
import { USERS, ALL_USERS, PROJECTS, INTERVIEWS, type MockUser } from './mock-data'
import { API_RE, jsonOk, noContent } from './route-helpers'

export async function mockProjectRoutes(page: Page, user: MockUser) {
  // Projects
  // task-junior-ux-2-hub: GET /projects/:id/hr-contact — allowlist DTO.
  // Must be registered BEFORE the generic /projects/:id$ route (LIFO: later wins).
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/hr-contact$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, { displayName: null, telegram: null, phone: null })
  })
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/members`), (r) =>
    r.request().method() === 'DELETE' ? noContent(r) : jsonOk(r, PROJECTS[0], 201),
  )
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, { ...PROJECTS[0], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  // Round 5: honor the `?archived=true|false` filter so the new «Все/Активные/Архив»
  // tabs return the expected slice of fixture projects. PROJECTS[0] is active
  // (archivedAt = null) and PROJECTS[1] is archived (archivedAt = timestamp).
  await page.route(new RegExp(`${API_RE}/projects(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') {
      return jsonOk(r, { ...PROJECTS[0], id: 'new-project-id' }, 201)
    }
    const url = new URL(r.request().url())
    const archivedParam = url.searchParams.get('archived')
    if (archivedParam === 'true') {
      return jsonOk(
        r,
        PROJECTS.filter((p) => p.archivedAt !== null),
      )
    }
    return jsonOk(
      r,
      PROJECTS.filter((p) => p.archivedAt === null),
    )
  })

  // Per-project credentials (PR #178). ProjectCredentialsSection mounts on
  // /project (JUNIOR hub) and /projects/$id (overview) and fires
  // GET /api/projects/:id/credentials. Unmocked → 401 → axios interceptor →
  // /login (same failure mode as legend/documents mocks above).
  // Default: empty list []. Specs that need real data register their own
  // handler AFTER mockAuthAs (LIFO) so it wins.
  // reveal/:id sub-route registered first so the generic credentials$ doesn't swallow it.
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/credentials/([^/?]+)/reveal$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    // Default reveal returns 200 with a placeholder — tests override per-credential.
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ password: 'mock-password' }),
    })
  })
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/credentials/([^/?]+)$`), (r) => {
    if (r.request().method() === 'DELETE') return r.fulfill({ status: 204, body: '' })
    if (r.request().method() === 'PATCH')
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      })
    return r.fallback()
  })
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/credentials$`), (r) => {
    if (r.request().method() === 'GET')
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    if (r.request().method() === 'POST')
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({}) })
    return r.fallback()
  })

  // Per-project legend (PR #164). Project-detail page renders ProjectLegendSection
  // for ADMIN/HR/JUNIOR → GET /api/projects/:id/legend on mount. Unmocked →
  // 401 → axios interceptor → /login (same failure mode as the notifications/
  // documents/contracts mocks above). /entries sub-route before the generic.
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/legend/entries$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(
          r,
          {
            id: 'legend-1-id',
            projectId: r.request().url().split('/').slice(-3, -2)[0],
            fullName: 'Alexander Petrenko',
            dateOfBirth: null,
            address: null,
            presentedRole: null,
            presentedStack: null,
            backstory: null,
            hobbies: null,
            notes: null,
            entries: [],
            createdAt: '2024-01-15T00:00:00.000Z',
            updatedAt: '2024-01-15T00:00:00.000Z',
          },
          201,
        )
      : r.fallback(),
  )
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/legend$`), (r) => {
    // GET (page load): default 404 "no legend" → section shows its empty state
    // (useLegend retry:false handles 403/404). Specs needing a real legend
    // register their own handler AFTER mockAuthAs (LIFO). PUT: echo.
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Легенда не найдена' }),
      })
    }
    if (r.request().method() === 'PUT') {
      return jsonOk(r, {
        id: 'legend-1-id',
        projectId: r.request().url().split('/').slice(-2, -1)[0],
        fullName: 'Alexander Petrenko',
        dateOfBirth: null,
        address: null,
        presentedRole: null,
        presentedStack: null,
        backstory: null,
        hobbies: null,
        notes: null,
        entries: [],
        createdAt: '2024-01-15T00:00:00.000Z',
        updatedAt: '2024-01-15T00:00:00.000Z',
      })
    }
    return r.fallback()
  })

  // Interviews
  await page.route(new RegExp(`${API_RE}/interviews/([^/?]+)/move`), (r) =>
    jsonOk(r, { ...INTERVIEWS[0], stage: 'ENGLISH_CHECK' }),
  )
  await page.route(new RegExp(`${API_RE}/interviews/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, { ...INTERVIEWS[0], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  await page.route(new RegExp(`${API_RE}/interviews(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { ...INTERVIEWS[0], id: 'new-interview-id' }, 201)
      : jsonOk(r, INTERVIEWS),
  )

  // Meeting Recorder UI mounts inside the interview detail sheet and fetches
  // linked recordings as soon as that sheet opens. Without this default mock,
  // the request reaches the real CI API, gets a 401 (the Playwright browser
  // does not carry the backend session), and the axios interceptor redirects
  // the whole test to /login. Specs that exercise recordings register their
  // own handler after mockAuthAs(), so Playwright's LIFO matching lets those
  // richer fixtures override this empty default.
  await page.route(new RegExp(`${API_RE}/interviews/([^/?]+)/recordings$`), (r) => jsonOk(r, []))

  // These two collection queries are likewise mounted by authenticated
  // Meeting Recorder pages. Keep safe empty defaults here so ordinary auth
  // fixtures never fall through to the live API; dedicated integration specs
  // override them after mockAuthAs().
  await page.route(new RegExp(`${API_RE}/interview-recordings/unmatched$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API_RE}/integrations/meeting-recorder/connections$`), (r) =>
    jsonOk(r, []),
  )
  // HR dashboard summary — registered AFTER the `/interviews/:id` route so it
  // wins under Playwright's LIFO route matching (last-registered handler runs
  // first). Without this ordering the `([^/?]+)` param matcher above would
  // swallow the literal `hr-summary` segment and return an interview row
  // (hrSummarySchema.parse would then throw → HRDashboard error-state).
  await page.route(new RegExp(`${API_RE}/interviews/hr-summary(\\?.*)?$`), (r) =>
    // Shape MUST match `hrSummarySchema` ({ openInterviews, hiredThisMonth,
    // activeProjects }) — the hook .parse()s the response, so a drifting shape
    // (e.g. the obsolete `mySalaryStatus` field + missing `activeProjects`) makes
    // HRDashboard render its error state and the RU KPI tokens never appear.
    jsonOk(r, {
      openInterviews: 3,
      hiredThisMonth: 1,
      activeProjects: 2,
    }),
  )
  // task-hr-drop-team-senior-board — GET /api/interviews/seniors is the board
  // selector's data source, replacing the client-side GET /users x GET /teams
  // intersection specs used to rely on. Registered AFTER the `/interviews/:id`
  // route above for the SAME reason as `hr-summary` immediately above it
  // (LIFO — last-registered wins; otherwise the `([^/?]+)` param matcher would
  // swallow the literal `seniors` segment and hand back an interview row,
  // which is not an array — every `.map`/`.find` on the selector's `seniors`
  // then throws). Mirrors the OLD intersection's OBSERVABLE result under the
  // default fixtures (ADMIN saw every SENIOR row from GET /users; HR saw
  // whichever senior(s) sat on GET /teams's one returned team — TEAMS[0] =
  // Alpha Team = USERS.senior only) so every existing selector-dependent spec
  // keeps working unchanged. A spec that needs a DIFFERENT senior list
  // (drop-team scenarios, empty scope, …) overrides this route itself, same
  // pattern as `/teams` above.
  await page.route(new RegExp(`${API_RE}/interviews/seniors(\\?.*)?$`), (r) => {
    const toBoardSenior = (u: {
      id: string
      displayName: string
      avatarUrl: string | null
      avatarDocumentId: string | null
    }) => ({
      id: u.id,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      avatarDocumentId: u.avatarDocumentId,
    })
    if (user.role === 'ADMIN') {
      return jsonOk(r, ALL_USERS.filter((u) => u.role === 'SENIOR').map(toBoardSenior))
    }
    if (user.role === 'HR') {
      return jsonOk(r, [toBoardSenior(USERS.senior)])
    }
    if (user.role === 'SENIOR') {
      return jsonOk(r, [toBoardSenior(user)])
    }
    return jsonOk(r, [])
  })
}
