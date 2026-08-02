/**
 * VacanciesService — unit tests.
 *
 * Harness rationale (mirrors apps/api/src/documents/documents.service.spec.ts):
 * drizzle predicate objects are opaque/circular, so the harness does not try
 * to evaluate WHERE clauses. Instead:
 *   - `findFirst` calls are served from a per-test queue (the service's call
 *     ORDER within each method is fixed and known, since we wrote it).
 *   - `select().from(table)` is resolved by TABLE IDENTITY (vacancies vs
 *     vacancyApplications) — reliable since both are singleton imports.
 *
 * RBAC (403 for non ADMIN/HR), status-transition matrix, delete-guards, and
 * public-visibility 404s are ALSO covered end-to-end against a real DB in
 * vacancies.integration.spec.ts — this file focuses on the service's own
 * branching logic in isolation.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it, vi } from 'vitest'
import type { CreateVacancy, SessionUser } from '@crm/shared'
import type { Env } from '../config/env'
import { vacancies, vacancyApplications } from '../database/schema'
import type { GoogleIndexingService } from './google-indexing.service'
import { VacanciesService } from './vacancies.service'

const LANDING_ORIGIN = 'https://cheekycheese.tech'

/** Shared no-op stub — the notification hooks themselves are covered by the
 *  dedicated `update — Google Indexing hooks` describe block below, which
 *  builds its own spy-backed instance. Every OTHER test in this file only
 *  needs the constructor dependency satisfied without asserting on it. */
function makeGoogleIndexingStub(): GoogleIndexingService {
  return {
    notifyUpdated: vi.fn().mockResolvedValue(undefined),
    notifyDeleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as GoogleIndexingService
}

function makeConfigStub(): ConfigService<Env, true> {
  return { get: () => LANDING_ORIGIN } as unknown as ConfigService<Env, true>
}

type VacancyRow = typeof vacancies.$inferSelect

// task-vacancy-salary-range (AC1) — spread into every create() DTO fixture
// now that the 4 salary fields are mandatory (see CreateVacancy type).
const VALID_SALARY = {
  salaryMin: 3000,
  salaryMax: 5000,
  salaryCurrency: 'USDT' as const,
  salaryPeriod: 'MONTH' as const,
}

// Same range, but as `makeRow()`-shaped ROW overrides (numeric() columns
// round-trip as strings — AC2 fixtures for a row that's ALREADY filled in,
// as opposed to a dto being submitted).
const VALID_SALARY_ROW = {
  salaryMin: '3000.00',
  salaryMax: '5000.00',
  salaryCurrency: 'USDT' as const,
  salaryPeriod: 'MONTH' as const,
}

const ADMIN: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@x.com',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}
const HR: SessionUser = {
  id: 'hr-1',
  role: 'HR',
  displayName: 'HR',
  email: 'hr@x.com',
  avatarUrl: null,
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@x.com',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

function makeRow(overrides: Partial<VacancyRow> = {}): VacancyRow {
  return {
    id: overrides.id ?? 'vac-1',
    slug: overrides.slug ?? 'senior-frontend-engineer',
    title: overrides.title ?? 'Senior Frontend Engineer',
    descriptionMd: overrides.descriptionMd ?? 'Full description here.',
    domain: overrides.domain ?? 'AI',
    seniority: overrides.seniority ?? 'SENIOR',
    employmentType: overrides.employmentType ?? 'FULL_TIME',
    location: overrides.location ?? 'Remote',
    status: overrides.status ?? 'DRAFT',
    publishedAt: overrides.publishedAt ?? null,
    closedAt: overrides.closedAt ?? null,
    createdBy: overrides.createdBy ?? ADMIN.id,
    translations: overrides.translations ?? null,
    skills: overrides.skills ?? null,
    experienceMonths: overrides.experienceMonths ?? null,
    qualifications: overrides.qualifications ?? null,
    responsibilities: overrides.responsibilities ?? null,
    jobBenefits: overrides.jobBenefits ?? null,
    workHours: overrides.workHours ?? null,
    // task-vacancy-salary-range — null by default (AC3: legacy/unfilled row).
    salaryMin: overrides.salaryMin ?? null,
    salaryMax: overrides.salaryMax ?? null,
    salaryCurrency: overrides.salaryCurrency ?? null,
    salaryPeriod: overrides.salaryPeriod ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-07-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-07-01T00:00:00Z'),
  }
}

/**
 * Builds a fake `DatabaseService`.
 *
 * `findFirstQueue` — consumed in-order by every `db.query.vacancies.findFirst`
 * call the service makes. Callers seed exactly as many entries as the method
 * under test is expected to call findFirst.
 *
 * `applicationCounts` — rows returned by any `select().from(vacancyApplications)`
 * query (used by both the single-vacancy count and the grouped listAdmin count).
 */
function makeHarness(opts: {
  findFirstQueue?: (VacancyRow | undefined)[]
  applicationCounts?: { vacancyId: string; count: number }[]
  listRows?: VacancyRow[]
  /** Rows `findRelated()` (task C8) resolves to — defaults to none. */
  relatedRows?: VacancyRow[]
}) {
  const findFirstQueue = [...(opts.findFirstQueue ?? [])]
  const applicationCountRows = opts.applicationCounts ?? []
  const listRows = opts.listRows ?? []
  const relatedRows = opts.relatedRows ?? []

  let insertedRow: VacancyRow | null = null
  let updatedRow: VacancyRow | null = null
  let deletedId: string | null = null

  const db = {
    db: {
      query: {
        vacancies: {
          findFirst: async (_args: unknown) => findFirstQueue.shift(),
          findMany: async (_args: unknown) => relatedRows,
        },
      },
      select: (_fields?: unknown) => ({
        from: (table: unknown) => {
          if (table === vacancyApplications) {
            // Two shapes use this: countApplicationsFor (single-vacancy filter,
            // resolved via .where()) and applicationCounts (grouped, resolved
            // via .groupBy()). Both chains resolve to the same seeded rows —
            // tests seed exactly the rows relevant to the vacancyId(s) in play.
            const chain = {
              where: async (_pred: unknown) => applicationCountRows,
              groupBy: async (_col: unknown) => applicationCountRows,
            }
            return chain
          }
          if (table === vacancies) {
            return {
              // listAdmin(): select().from(vacancies).orderBy(...) — no filter.
              orderBy: async (_o: unknown) => listRows,
              // listPublic(): select().from(vacancies).where(...).orderBy(...).
              where: (_pred: unknown) => ({
                orderBy: async (_o: unknown) => listRows,
              }),
            }
          }
          return { orderBy: async () => [], where: async () => [] }
        },
      }),
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => ({
          returning: async () => {
            insertedRow = {
              id: 'new-vac-id',
              slug: vals['slug'] as string,
              title: vals['title'] as string,
              descriptionMd: vals['descriptionMd'] as string,
              domain: vals['domain'] as VacancyRow['domain'],
              seniority: vals['seniority'] as VacancyRow['seniority'],
              employmentType: vals['employmentType'] as VacancyRow['employmentType'],
              location: vals['location'] as string,
              status: 'DRAFT',
              publishedAt: null,
              closedAt: null,
              createdBy: vals['createdBy'] as string,
              translations: (vals['translations'] as VacancyRow['translations']) ?? null,
              skills: (vals['skills'] as VacancyRow['skills']) ?? null,
              experienceMonths: (vals['experienceMonths'] as number | null) ?? null,
              qualifications: (vals['qualifications'] as string | null) ?? null,
              responsibilities: (vals['responsibilities'] as string | null) ?? null,
              jobBenefits: (vals['jobBenefits'] as string | null) ?? null,
              workHours: (vals['workHours'] as string | null) ?? null,
              salaryMin: (vals['salaryMin'] as string | null) ?? null,
              salaryMax: (vals['salaryMax'] as string | null) ?? null,
              salaryCurrency: (vals['salaryCurrency'] as VacancyRow['salaryCurrency']) ?? null,
              salaryPeriod: (vals['salaryPeriod'] as VacancyRow['salaryPeriod']) ?? null,
              createdAt: new Date('2026-07-22T00:00:00Z'),
              updatedAt: new Date('2026-07-22T00:00:00Z'),
            }
            return [insertedRow]
          },
        }),
      }),
      update: (_table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: (_pred: unknown) => ({
            returning: async () => {
              const base = opts.findFirstQueue?.[0] ?? makeRow()
              updatedRow = { ...base, ...vals } as VacancyRow
              return [updatedRow]
            },
          }),
        }),
      }),
      delete: (_table: unknown) => ({
        where: async (_pred: unknown) => {
          deletedId = 'deleted'
          return undefined
        },
      }),
    },
  }

  return {
    db: db as unknown as ConstructorParameters<typeof VacanciesService>[0],
    googleIndexing: makeGoogleIndexingStub(),
    config: makeConfigStub(),
    getDeletedId: () => deletedId,
    getInsertedRow: () => insertedRow,
    getUpdatedRow: () => updatedRow,
  }
}

describe('VacanciesService', () => {
  describe('create', () => {
    it('creates a vacancy with applicationsCount=0', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.create(ADMIN, {
        title: 'Senior Frontend Engineer',
        slug: 'senior-frontend-engineer',
        descriptionMd: 'Full description here.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
        ...VALID_SALARY,
      })
      expect(result.slug).toBe('senior-frontend-engineer')
      expect(result.status).toBe('DRAFT')
      expect(result.applicationsCount).toBe(0)
      expect(result.salaryMin).toBe('3000')
      expect(result.salaryCurrency).toBe('USDT')
    })

    it('rejects with 409 when the slug already exists', async () => {
      const h = makeHarness({ findFirstQueue: [makeRow()] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(
        svc.create(ADMIN, {
          title: 'Senior Frontend Engineer',
          slug: 'senior-frontend-engineer',
          descriptionMd: 'Full description here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          ...VALID_SALARY,
        }),
      ).rejects.toThrow(ConflictException)
    })

    it('rejects with 403 for a non ADMIN/HR actor (defense-in-depth)', async () => {
      const h = makeHarness({})
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(
        svc.create(SENIOR, {
          title: 'Senior Frontend Engineer',
          slug: 'senior-frontend-engineer',
          descriptionMd: 'Full description here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
          ...VALID_SALARY,
        }),
      ).rejects.toThrow(ForbiddenException)
    })

    it('HR (not just ADMIN) can create', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.create(HR, {
        title: 'Senior Frontend Engineer',
        slug: 'senior-frontend-engineer',
        descriptionMd: 'Full description here.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
        ...VALID_SALARY,
      })
      expect(result.slug).toBe('senior-frontend-engineer')
    })

    // AC1 (defense-in-depth) — createVacancySchema already requires these 4
    // fields at parse-time; this proves the SERVICE also refuses to persist a
    // vacancy without them, independent of the schema (e.g. a caller that
    // bypasses `.parse()`).
    it('rejects with 400 when the DTO is missing the salary range (defense-in-depth, bypassing the schema)', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const dtoMissingSalary = {
        title: 'Senior Frontend Engineer',
        slug: 'senior-frontend-engineer',
        descriptionMd: 'Full description here.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      } as unknown as CreateVacancy
      await expect(svc.create(ADMIN, dtoMissingSalary)).rejects.toThrow(BadRequestException)
    })
  })

  describe('update — status transitions (§4)', () => {
    it('DRAFT → PUBLISHED sets publishedAt and clears closedAt', async () => {
      const draftRow = makeRow({ status: 'DRAFT', publishedAt: null, ...VALID_SALARY_ROW })
      const h = makeHarness({
        findFirstQueue: [draftRow],
        applicationCounts: [],
      })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.update(ADMIN, draftRow.id, { status: 'PUBLISHED' })
      expect(result.status).toBe('PUBLISHED')
      const updated = h.getUpdatedRow()
      expect(updated?.publishedAt).toBeInstanceOf(Date)
      expect(updated?.closedAt).toBeNull()
    })

    it('PUBLISHED → CLOSED sets closedAt', async () => {
      const publishedRow = makeRow({
        status: 'PUBLISHED',
        publishedAt: new Date('2026-07-01T00:00:00Z'),
      })
      const h = makeHarness({ findFirstQueue: [publishedRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.update(ADMIN, publishedRow.id, { status: 'CLOSED' })
      expect(result.status).toBe('CLOSED')
      expect(h.getUpdatedRow()?.closedAt).toBeInstanceOf(Date)
    })

    it('CLOSED → PUBLISHED (re-open) clears closedAt and keeps original publishedAt', async () => {
      const originalPublishedAt = new Date('2026-06-01T00:00:00Z')
      const closedRow = makeRow({
        status: 'CLOSED',
        publishedAt: originalPublishedAt,
        closedAt: new Date('2026-07-01T00:00:00Z'),
        ...VALID_SALARY_ROW,
      })
      const h = makeHarness({ findFirstQueue: [closedRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.update(ADMIN, closedRow.id, { status: 'PUBLISHED' })
      expect(result.status).toBe('PUBLISHED')
      const updated = h.getUpdatedRow()
      expect(updated?.closedAt).toBeNull()
      // publishedAt untouched — re-open does not reset the original publish date.
      expect(updated?.publishedAt).toEqual(originalPublishedAt)
    })

    it('rejects an invalid transition (DRAFT → CLOSED) with 409', async () => {
      const draftRow = makeRow({ status: 'DRAFT' })
      const h = makeHarness({ findFirstQueue: [draftRow] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.update(ADMIN, draftRow.id, { status: 'CLOSED' })).rejects.toThrow(
        ConflictException,
      )
    })

    it('rejects an invalid transition (PUBLISHED → DRAFT) with 409', async () => {
      const publishedRow = makeRow({ status: 'PUBLISHED' })
      const h = makeHarness({ findFirstQueue: [publishedRow] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.update(ADMIN, publishedRow.id, { status: 'DRAFT' })).rejects.toThrow(
        ConflictException,
      )
    })

    it('404 when the vacancy does not exist', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.update(ADMIN, 'missing-id', { title: 'New title' })).rejects.toThrow(
        NotFoundException,
      )
    })

    // AC3 regression pin — `row` has NO salary (makeRow()'s default), same as
    // the 3 vacancies already PUBLISHED on prod before this change: a plain
    // field PATCH must NOT be blocked by the publish-gate (it only fires on
    // an ACTUAL status transition, see assertSalaryFilled's call site).
    it('plain field update (no status change) leaves status untouched — works even without a salary range (AC3)', async () => {
      const row = makeRow({ status: 'PUBLISHED' })
      const h = makeHarness({ findFirstQueue: [row], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.update(ADMIN, row.id, { title: 'Updated Title' })
      expect(h.getUpdatedRow()?.status).toBe('PUBLISHED')
      expect(result.title).toBeDefined()
      expect(result.salaryMin).toBeNull()
    })
  })

  // task-vacancy-salary-range (AC2) — publishing (DRAFT→PUBLISHED or the
  // CLOSED→PUBLISHED re-open) is blocked without a filled salary range.
  describe('update — salary range gate on publish (AC2)', () => {
    it('rejects DRAFT → PUBLISHED with 400 when the row has no salary range', async () => {
      const draftRow = makeRow({ status: 'DRAFT' })
      const h = makeHarness({ findFirstQueue: [draftRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.update(ADMIN, draftRow.id, { status: 'PUBLISHED' })).rejects.toThrow(
        BadRequestException,
      )
    })

    it('rejects CLOSED → PUBLISHED (re-open) with 400 when the row has no salary range (a legacy vacancy stays blocked from re-opening until filled in)', async () => {
      const closedRow = makeRow({ status: 'CLOSED' })
      const h = makeHarness({ findFirstQueue: [closedRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.update(ADMIN, closedRow.id, { status: 'PUBLISHED' })).rejects.toThrow(
        BadRequestException,
      )
    })

    it('rejects when only SOME of the 4 salary fields are set on the row', async () => {
      const draftRow = makeRow({
        status: 'DRAFT',
        salaryMin: '3000.00',
        salaryMax: '5000.00',
        // salaryCurrency / salaryPeriod left null
      })
      const h = makeHarness({ findFirstQueue: [draftRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.update(ADMIN, draftRow.id, { status: 'PUBLISHED' })).rejects.toThrow(
        BadRequestException,
      )
    })

    it('succeeds when the row ALREADY has a filled salary range', async () => {
      const draftRow = makeRow({ status: 'DRAFT', ...VALID_SALARY_ROW })
      const h = makeHarness({ findFirstQueue: [draftRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.update(ADMIN, draftRow.id, { status: 'PUBLISHED' })
      expect(result.status).toBe('PUBLISHED')
    })

    it('succeeds when the SAME PATCH fills the salary range and publishes in one request (a legacy vacancy being fixed up)', async () => {
      const draftRow = makeRow({ status: 'DRAFT' }) // no salary on the row
      const h = makeHarness({ findFirstQueue: [draftRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.update(ADMIN, draftRow.id, {
        status: 'PUBLISHED',
        ...VALID_SALARY,
      })
      expect(result.status).toBe('PUBLISHED')
      expect(h.getUpdatedRow()?.salaryMin).toBe('3000')
    })
  })

  describe('update — Google Indexing hooks (task-google-indexing-api §2)', () => {
    it('DRAFT → PUBLISHED calls notifyUpdated with the careers URL (trailing slash)', async () => {
      const draftRow = makeRow({
        status: 'DRAFT',
        slug: 'senior-react-developer',
        ...VALID_SALARY_ROW,
      })
      const h = makeHarness({ findFirstQueue: [draftRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.update(ADMIN, draftRow.id, { status: 'PUBLISHED' })

      expect(h.googleIndexing.notifyUpdated).toHaveBeenCalledWith(
        'https://cheekycheese.tech/careers/senior-react-developer/',
      )
      expect(h.googleIndexing.notifyDeleted).not.toHaveBeenCalled()
    })

    it('CLOSED → PUBLISHED (re-open) also calls notifyUpdated (freshens the index entry again)', async () => {
      const closedRow = makeRow({
        status: 'CLOSED',
        slug: 'senior-react-developer',
        ...VALID_SALARY_ROW,
      })
      const h = makeHarness({ findFirstQueue: [closedRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.update(ADMIN, closedRow.id, { status: 'PUBLISHED' })

      expect(h.googleIndexing.notifyUpdated).toHaveBeenCalledWith(
        'https://cheekycheese.tech/careers/senior-react-developer/',
      )
      expect(h.googleIndexing.notifyDeleted).not.toHaveBeenCalled()
    })

    it('PUBLISHED → CLOSED calls notifyDeleted with the careers URL', async () => {
      const publishedRow = makeRow({ status: 'PUBLISHED', slug: 'senior-react-developer' })
      const h = makeHarness({ findFirstQueue: [publishedRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.update(ADMIN, publishedRow.id, { status: 'CLOSED' })

      expect(h.googleIndexing.notifyDeleted).toHaveBeenCalledWith(
        'https://cheekycheese.tech/careers/senior-react-developer/',
      )
      expect(h.googleIndexing.notifyUpdated).not.toHaveBeenCalled()
    })

    it('slug change while PUBLISHED calls notifyDeleted(old) then notifyUpdated(new)', async () => {
      const publishedRow = makeRow({ status: 'PUBLISHED', slug: 'old-slug' })
      // findFirstQueue: [0] getRowOrThrow → publishedRow; [1] assertSlugFree('new-slug') → undefined (free)
      const h = makeHarness({
        findFirstQueue: [publishedRow, undefined],
        applicationCounts: [],
      })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.update(ADMIN, publishedRow.id, { slug: 'new-slug' })

      expect(h.googleIndexing.notifyDeleted).toHaveBeenCalledWith(
        'https://cheekycheese.tech/careers/old-slug/',
      )
      expect(h.googleIndexing.notifyUpdated).toHaveBeenCalledWith(
        'https://cheekycheese.tech/careers/new-slug/',
      )
      const deletedCallOrder = (h.googleIndexing.notifyDeleted as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] as number
      const updatedCallOrder = (h.googleIndexing.notifyUpdated as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] as number
      expect(deletedCallOrder).toBeLessThan(updatedCallOrder)
    })

    it('plain field edit (no status/slug change) does not notify Google at all', async () => {
      const row = makeRow({ status: 'PUBLISHED' })
      const h = makeHarness({ findFirstQueue: [row], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.update(ADMIN, row.id, { title: 'Updated Title' })

      expect(h.googleIndexing.notifyUpdated).not.toHaveBeenCalled()
      expect(h.googleIndexing.notifyDeleted).not.toHaveBeenCalled()
    })

    it('slug change on a DRAFT vacancy does not notify Google (never indexed)', async () => {
      const row = makeRow({ status: 'DRAFT', slug: 'old-slug' })
      const h = makeHarness({ findFirstQueue: [row, undefined], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.update(ADMIN, row.id, { slug: 'new-slug' })

      expect(h.googleIndexing.notifyUpdated).not.toHaveBeenCalled()
      expect(h.googleIndexing.notifyDeleted).not.toHaveBeenCalled()
    })

    it('AC4: a GoogleIndexingService failure does NOT break the transition — update() still resolves and returns the new status (defense-in-depth: the real service never rejects, but the call site catches anyway)', async () => {
      const draftRow = makeRow({
        status: 'DRAFT',
        slug: 'senior-react-developer',
        ...VALID_SALARY_ROW,
      })
      const h = makeHarness({ findFirstQueue: [draftRow], applicationCounts: [] })
      ;(h.googleIndexing.notifyUpdated as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Google Indexing API unreachable'),
      )
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)

      const result = await svc.update(ADMIN, draftRow.id, { status: 'PUBLISHED' })
      expect(result.status).toBe('PUBLISHED')
    })
  })

  // task-vacancy-delete-closed: gate softened from "DRAFT only" to
  // "DRAFT or CLOSED, and applicationsCount === 0". PUBLISHED still can
  // never be deleted directly (close it first); applications still block
  // delete regardless of status (R2 files + history, retention cron only).
  describe('remove', () => {
    it('rejects with 409 when the vacancy is PUBLISHED', async () => {
      const row = makeRow({ status: 'PUBLISHED' })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.remove(ADMIN, row.id)).rejects.toThrow(ConflictException)
    })

    it('rejects with 409 when the DRAFT vacancy already has applications', async () => {
      const row = makeRow({ status: 'DRAFT' })
      const h = makeHarness({
        findFirstQueue: [row],
        applicationCounts: [{ vacancyId: row.id, count: 2 }],
      })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.remove(ADMIN, row.id)).rejects.toThrow(ConflictException)
    })

    it('rejects with 409 when the CLOSED vacancy already has applications', async () => {
      const row = makeRow({ status: 'CLOSED', closedAt: new Date('2026-07-05T00:00:00Z') })
      const h = makeHarness({
        findFirstQueue: [row],
        applicationCounts: [{ vacancyId: row.id, count: 1 }],
      })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.remove(ADMIN, row.id)).rejects.toThrow(ConflictException)
    })

    it('deletes a DRAFT vacancy with zero applications', async () => {
      const row = makeRow({ status: 'DRAFT' })
      const h = makeHarness({ findFirstQueue: [row], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.remove(ADMIN, row.id)
      expect(h.getDeletedId()).toBe('deleted')
    })

    it('deletes a CLOSED vacancy with zero applications (owner report: was impossible before this task)', async () => {
      const row = makeRow({ status: 'CLOSED', closedAt: new Date('2026-07-05T00:00:00Z') })
      const h = makeHarness({ findFirstQueue: [row], applicationCounts: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await svc.remove(ADMIN, row.id)
      expect(h.getDeletedId()).toBe('deleted')
    })
  })

  describe('public read paths', () => {
    it('getPublicBySlug throws 404 for a DRAFT vacancy', async () => {
      const row = makeRow({ status: 'DRAFT' })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.getPublicBySlug(row.slug)).rejects.toThrow(NotFoundException)
    })

    it('getPublicBySlug throws 404 for a missing slug', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.getPublicBySlug('does-not-exist')).rejects.toThrow(NotFoundException)
    })

    it('getPublicBySlug returns the detail DTO for a PUBLISHED vacancy', async () => {
      const row = makeRow({ status: 'PUBLISHED', publishedAt: new Date('2026-07-01T00:00:00Z') })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.getPublicBySlug(row.slug)
      expect(result.slug).toBe(row.slug)
      expect(result.descriptionMd).toBe(row.descriptionMd)
      expect(result.isFallback).toBe(false)
      expect(result.relatedVacancies).toEqual([])
    })

    // AC3 — a legacy vacancy without a salary range still returns a valid
    // detail DTO (all 4 keys present, `null`), nothing throws.
    it('getPublicBySlug returns null salary fields for a legacy vacancy without a range (AC3)', async () => {
      const row = makeRow({ status: 'PUBLISHED', publishedAt: new Date('2026-07-01T00:00:00Z') })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.getPublicBySlug(row.slug)
      expect(result.salaryMin).toBeNull()
      expect(result.salaryMax).toBeNull()
      expect(result.salaryCurrency).toBeNull()
      expect(result.salaryPeriod).toBeNull()
    })

    it('getPublicBySlug returns the filled salary range when present', async () => {
      const row = makeRow({
        status: 'PUBLISHED',
        publishedAt: new Date('2026-07-01T00:00:00Z'),
        ...VALID_SALARY_ROW,
      })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.getPublicBySlug(row.slug)
      expect(result.salaryMin).toBe('3000.00')
      expect(result.salaryMax).toBe('5000.00')
      expect(result.salaryCurrency).toBe('USDT')
      expect(result.salaryPeriod).toBe('MONTH')
    })

    // task C5 — a CLOSED (formerly-live) posting is 410 Gone, distinct from
    // a DRAFT/missing slug's 404 (task-careers-seo-v2 §3: stronger de-index
    // signal to Google than a plain "not found").
    it('getPublicBySlug throws 410 Gone for a CLOSED vacancy', async () => {
      const row = makeRow({ status: 'CLOSED' })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.getPublicBySlug(row.slug)).rejects.toThrow(HttpException)
      const h2 = makeHarness({ findFirstQueue: [row] })
      const svc2 = new VacanciesService(h2.db, h2.googleIndexing, h2.config)
      await expect(svc2.getPublicBySlug(row.slug)).rejects.toMatchObject({
        status: 410,
      })
    })

    it('getPublishedRowBySlug throws 410 Gone for a CLOSED vacancy (shared with ApplicationsService.apply)', async () => {
      const row = makeRow({ status: 'CLOSED' })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.getPublishedRowBySlug(row.slug)).rejects.toMatchObject({ status: 410 })
    })

    // task C2 (plan §3) — `?locale=` resolution + isFallback flag.
    describe('locale resolution', () => {
      const translatedRow = makeRow({
        status: 'PUBLISHED',
        publishedAt: new Date('2026-07-01T00:00:00Z'),
        title: 'Senior Frontend Engineer',
        descriptionMd: 'EN description.',
        translations: {
          uk: { title: 'Провідний Frontend-інженер', description: 'UK опис.' },
          ru: { title: 'Ведущий Frontend-инженер', description: 'RU описание.' },
        },
      })

      it('defaults to en (original row copy) when no locale is passed', async () => {
        const h = makeHarness({ findFirstQueue: [translatedRow] })
        const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
        const result = await svc.getPublicBySlug(translatedRow.slug)
        expect(result.title).toBe('Senior Frontend Engineer')
        expect(result.descriptionMd).toBe('EN description.')
        expect(result.isFallback).toBe(false)
      })

      it.each(['uk', 'ru'] as const)(
        'returns the %s translation with isFallback=false when present',
        async (locale) => {
          const h = makeHarness({ findFirstQueue: [translatedRow] })
          const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
          const result = await svc.getPublicBySlug(translatedRow.slug, locale)
          expect(result.title).toBe(translatedRow.translations![locale]!.title)
          expect(result.descriptionMd).toBe(translatedRow.translations![locale]!.description)
          expect(result.isFallback).toBe(false)
        },
      )

      it.each(['es', 'pt'] as const)(
        'falls back to the EN row + isFallback=true when the %s translation is missing',
        async (locale) => {
          const h = makeHarness({ findFirstQueue: [translatedRow] })
          const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
          const result = await svc.getPublicBySlug(translatedRow.slug, locale)
          expect(result.title).toBe('Senior Frontend Engineer')
          expect(result.descriptionMd).toBe('EN description.')
          expect(result.isFallback).toBe(true)
        },
      )

      it('listPublic resolves each row to the requested locale too', async () => {
        const h = makeHarness({ listRows: [translatedRow] })
        const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
        const [result] = await svc.listPublic('ru')
        expect(result?.title).toBe('Ведущий Frontend-инженер')
        expect(result?.isFallback).toBe(false)
      })
    })

    // task C8 — up to 3 related PUBLISHED vacancies, same locale resolution.
    it('getPublicBySlug includes relatedVacancies resolved to the same locale', async () => {
      const row = makeRow({ status: 'PUBLISHED', publishedAt: new Date('2026-07-01T00:00:00Z') })
      const related = makeRow({
        id: 'vac-2',
        slug: 'lead-backend-engineer',
        status: 'PUBLISHED',
        publishedAt: new Date('2026-07-02T00:00:00Z'),
        translations: { uk: { title: 'Ведучий Backend-інженер', description: 'опис' } },
      })
      const h = makeHarness({ findFirstQueue: [row], relatedRows: [related] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.getPublicBySlug(row.slug, 'uk')
      expect(result.relatedVacancies).toHaveLength(1)
      expect(result.relatedVacancies[0]?.slug).toBe('lead-backend-engineer')
      expect(result.relatedVacancies[0]?.title).toBe('Ведучий Backend-інженер')
      expect(result.relatedVacancies[0]?.isFallback).toBe(false)
    })

    it('listAdmin merges applicationsCount per vacancy (0 when absent from the grouped counts)', async () => {
      const rowA = makeRow({ id: 'vac-a', slug: 'vac-a' })
      const rowB = makeRow({ id: 'vac-b', slug: 'vac-b' })
      const h = makeHarness({
        listRows: [rowA, rowB],
        applicationCounts: [{ vacancyId: 'vac-a', count: 3 }],
      })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      const result = await svc.listAdmin(ADMIN)
      const a = result.find((r) => r.id === 'vac-a')
      const b = result.find((r) => r.id === 'vac-b')
      expect(a?.applicationsCount).toBe(3)
      expect(b?.applicationsCount).toBe(0)
    })

    it('listAdmin rejects with 403 for a non ADMIN/HR actor', async () => {
      const h = makeHarness({ listRows: [] })
      const svc = new VacanciesService(h.db, h.googleIndexing, h.config)
      await expect(svc.listAdmin(SENIOR)).rejects.toThrow(ForbiddenException)
    })
  })
})
