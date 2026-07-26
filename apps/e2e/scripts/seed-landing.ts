#!/usr/bin/env tsx
/**
 * apps/e2e/scripts/seed-landing.ts — `pnpm --filter @crm/e2e seed:landing`
 * (task-landing-e2e-in-ci.md КОНТРАКТ).
 *
 * Idempotent: creates/reconciles EXACTLY the 3 vacancy fixtures
 * `../tests/landing/fixtures.ts` declares (`LANDING_VACANCY_FIXTURES`) — no
 * other landing-project data. Run AFTER `db:push` + `db:seed` against a
 * LIVE API instance: it needs (a) the schema, and (b) the seeded ADMIN user
 * `db:seed` creates (`SEED_LANDING_ADMIN_EMAIL`, default
 * `yaremenkomaksym99@gmail.com`) — both `dev-login` and `vacancies.created_by`
 * depend on that user already existing.
 *
 * Goes through the REAL admin vacancies HTTP API (dev-login →
 * `POST /api/vacancies` → `PATCH /api/vacancies/:id` for status
 * transitions), not a direct DB write — every fixture is therefore
 * guaranteed to be something the app itself could actually produce (same
 * `createVacancySchema`/`updateVacancySchema` validation + the
 * DRAFT→PUBLISHED→CLOSED transition table `VacanciesService` enforces), and
 * this script only needs an API base URL, never DB driver credentials.
 *
 * Env:
 *   SEED_LANDING_API_BASE    — default `http://localhost:3001`
 *   SEED_LANDING_ADMIN_EMAIL — default `yaremenkomaksym99@gmail.com` (must
 *                               already exist — see module doc above)
 */
import { LANDING_VACANCY_FIXTURES, type LandingVacancyFixture } from '../tests/landing/fixtures'

const API_BASE = process.env['SEED_LANDING_API_BASE'] ?? 'http://localhost:3001'
const ADMIN_EMAIL = process.env['SEED_LANDING_ADMIN_EMAIL'] ?? 'yaremenkomaksym99@gmail.com'

interface AdminVacancy {
  id: string
  slug: string
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED'
}

/** DRAFT→PUBLISHED→CLOSED transition table (mirrors `VacanciesService.VALID_TRANSITIONS`) — the ordered list of statuses to PATCH through to reach `target` from `from`. */
function transitionPath(
  from: AdminVacancy['status'],
  target: AdminVacancy['status'],
): AdminVacancy['status'][] {
  if (from === target) return []
  if (target === 'PUBLISHED') return ['PUBLISHED']
  // target === 'CLOSED': DRAFT can't go straight to CLOSED — publish first.
  if (from === 'DRAFT') return ['PUBLISHED', 'CLOSED']
  return ['CLOSED']
}

async function devLogin(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL }),
  })
  if (!res.ok) {
    throw new Error(
      `seed:landing — dev-login for "${ADMIN_EMAIL}" failed (${res.status}): ${await res.text()}. ` +
        'Did db:seed run against this DB first? Is SEED_LANDING_ADMIN_EMAIL a real seeded ADMIN?',
    )
  }
  const setCookie = res.headers.get('set-cookie')
  const jwt = setCookie?.match(/jwt=([^;]+)/)?.[1]
  if (!jwt) {
    throw new Error('seed:landing — dev-login response carried no jwt cookie')
  }
  return `jwt=${jwt}`
}

async function apiJson<T>(cookie: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    throw new Error(
      `seed:landing — ${init.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text()}`,
    )
  }
  return res.json() as Promise<T>
}

/** The `createVacancySchema`/`updateVacancySchema` field subset this script writes — everything in `LandingVacancyFixture` except `targetStatus` (status is driven separately via `transitionPath`, never sent on create/update in the same call, matching the admin UI's own two-step publish flow). */
function toVacancyPayload(fixture: LandingVacancyFixture) {
  return {
    title: fixture.title,
    slug: fixture.slug,
    descriptionMd: fixture.descriptionMd,
    domain: fixture.domain,
    seniority: fixture.seniority,
    employmentType: fixture.employmentType,
    location: fixture.location,
    translations: fixture.translations ?? null,
  }
}

async function upsertFixture(
  cookie: string,
  existing: Map<string, AdminVacancy>,
  fixture: LandingVacancyFixture,
) {
  const payload = toVacancyPayload(fixture)
  let row = existing.get(fixture.slug)

  if (!row) {
    row = await apiJson<AdminVacancy>(cookie, '/api/vacancies', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    console.log(`  + created ${fixture.slug} (${row.id})`)
  } else {
    row = await apiJson<AdminVacancy>(cookie, `/api/vacancies/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    console.log(`  ~ reconciled ${fixture.slug} (${row.id}, was ${row.status})`)
  }

  for (const status of transitionPath(row.status, fixture.targetStatus)) {
    row = await apiJson<AdminVacancy>(cookie, `/api/vacancies/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
    console.log(`    -> ${status}`)
  }
}

async function main() {
  console.log(`seed:landing — API base: ${API_BASE}`)
  const cookie = await devLogin()

  const adminList = await apiJson<AdminVacancy[]>(cookie, '/api/vacancies')
  const existing = new Map(adminList.map((v) => [v.slug, v]))

  for (const fixture of LANDING_VACANCY_FIXTURES) {
    await upsertFixture(cookie, existing, fixture)
  }

  console.log(`seed:landing — done (${LANDING_VACANCY_FIXTURES.length} fixtures reconciled).`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
