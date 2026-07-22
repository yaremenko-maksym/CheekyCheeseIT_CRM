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
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { vacancies, vacancyApplications } from '../database/schema'
import { VacanciesService } from './vacancies.service'

type VacancyRow = typeof vacancies.$inferSelect

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
}) {
  const findFirstQueue = [...(opts.findFirstQueue ?? [])]
  const applicationCountRows = opts.applicationCounts ?? []
  const listRows = opts.listRows ?? []

  let insertedRow: VacancyRow | null = null
  let updatedRow: VacancyRow | null = null
  let deletedId: string | null = null

  const db = {
    db: {
      query: {
        vacancies: {
          findFirst: async (_args: unknown) => findFirstQueue.shift(),
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
              orderBy: async (_o: unknown) => listRows,
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
    getDeletedId: () => deletedId,
    getInsertedRow: () => insertedRow,
    getUpdatedRow: () => updatedRow,
  }
}

describe('VacanciesService', () => {
  describe('create', () => {
    it('creates a vacancy with applicationsCount=0', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db)
      const result = await svc.create(ADMIN, {
        title: 'Senior Frontend Engineer',
        slug: 'senior-frontend-engineer',
        descriptionMd: 'Full description here.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.slug).toBe('senior-frontend-engineer')
      expect(result.status).toBe('DRAFT')
      expect(result.applicationsCount).toBe(0)
    })

    it('rejects with 409 when the slug already exists', async () => {
      const h = makeHarness({ findFirstQueue: [makeRow()] })
      const svc = new VacanciesService(h.db)
      await expect(
        svc.create(ADMIN, {
          title: 'Senior Frontend Engineer',
          slug: 'senior-frontend-engineer',
          descriptionMd: 'Full description here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        }),
      ).rejects.toThrow(ConflictException)
    })

    it('rejects with 403 for a non ADMIN/HR actor (defense-in-depth)', async () => {
      const h = makeHarness({})
      const svc = new VacanciesService(h.db)
      await expect(
        svc.create(SENIOR, {
          title: 'Senior Frontend Engineer',
          slug: 'senior-frontend-engineer',
          descriptionMd: 'Full description here.',
          domain: 'AI',
          seniority: 'SENIOR',
          employmentType: 'FULL_TIME',
          location: 'Remote',
        }),
      ).rejects.toThrow(ForbiddenException)
    })

    it('HR (not just ADMIN) can create', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db)
      const result = await svc.create(HR, {
        title: 'Senior Frontend Engineer',
        slug: 'senior-frontend-engineer',
        descriptionMd: 'Full description here.',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
      })
      expect(result.slug).toBe('senior-frontend-engineer')
    })
  })

  describe('update — status transitions (§4)', () => {
    it('DRAFT → PUBLISHED sets publishedAt and clears closedAt', async () => {
      const draftRow = makeRow({ status: 'DRAFT', publishedAt: null })
      const h = makeHarness({
        findFirstQueue: [draftRow],
        applicationCounts: [],
      })
      const svc = new VacanciesService(h.db)
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
      const svc = new VacanciesService(h.db)
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
      })
      const h = makeHarness({ findFirstQueue: [closedRow], applicationCounts: [] })
      const svc = new VacanciesService(h.db)
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
      const svc = new VacanciesService(h.db)
      await expect(svc.update(ADMIN, draftRow.id, { status: 'CLOSED' })).rejects.toThrow(
        ConflictException,
      )
    })

    it('rejects an invalid transition (PUBLISHED → DRAFT) with 409', async () => {
      const publishedRow = makeRow({ status: 'PUBLISHED' })
      const h = makeHarness({ findFirstQueue: [publishedRow] })
      const svc = new VacanciesService(h.db)
      await expect(svc.update(ADMIN, publishedRow.id, { status: 'DRAFT' })).rejects.toThrow(
        ConflictException,
      )
    })

    it('404 when the vacancy does not exist', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db)
      await expect(svc.update(ADMIN, 'missing-id', { title: 'New title' })).rejects.toThrow(
        NotFoundException,
      )
    })

    it('plain field update (no status change) leaves status untouched', async () => {
      const row = makeRow({ status: 'PUBLISHED' })
      const h = makeHarness({ findFirstQueue: [row], applicationCounts: [] })
      const svc = new VacanciesService(h.db)
      const result = await svc.update(ADMIN, row.id, { title: 'Updated Title' })
      expect(h.getUpdatedRow()?.status).toBe('PUBLISHED')
      expect(result.title).toBeDefined()
    })
  })

  describe('remove', () => {
    it('rejects with 409 when the vacancy is not DRAFT', async () => {
      const row = makeRow({ status: 'PUBLISHED' })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db)
      await expect(svc.remove(ADMIN, row.id)).rejects.toThrow(ConflictException)
    })

    it('rejects with 409 when the DRAFT vacancy already has applications', async () => {
      const row = makeRow({ status: 'DRAFT' })
      const h = makeHarness({
        findFirstQueue: [row],
        applicationCounts: [{ vacancyId: row.id, count: 2 }],
      })
      const svc = new VacanciesService(h.db)
      await expect(svc.remove(ADMIN, row.id)).rejects.toThrow(ConflictException)
    })

    it('deletes a DRAFT vacancy with zero applications', async () => {
      const row = makeRow({ status: 'DRAFT' })
      const h = makeHarness({ findFirstQueue: [row], applicationCounts: [] })
      const svc = new VacanciesService(h.db)
      await svc.remove(ADMIN, row.id)
      expect(h.getDeletedId()).toBe('deleted')
    })
  })

  describe('public read paths', () => {
    it('getPublicBySlug throws 404 for a DRAFT vacancy', async () => {
      const row = makeRow({ status: 'DRAFT' })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db)
      await expect(svc.getPublicBySlug(row.slug)).rejects.toThrow(NotFoundException)
    })

    it('getPublicBySlug throws 404 for a missing slug', async () => {
      const h = makeHarness({ findFirstQueue: [undefined] })
      const svc = new VacanciesService(h.db)
      await expect(svc.getPublicBySlug('does-not-exist')).rejects.toThrow(NotFoundException)
    })

    it('getPublicBySlug returns the detail DTO for a PUBLISHED vacancy', async () => {
      const row = makeRow({ status: 'PUBLISHED', publishedAt: new Date('2026-07-01T00:00:00Z') })
      const h = makeHarness({ findFirstQueue: [row] })
      const svc = new VacanciesService(h.db)
      const result = await svc.getPublicBySlug(row.slug)
      expect(result.slug).toBe(row.slug)
      expect(result.descriptionMd).toBe(row.descriptionMd)
    })

    it('listAdmin merges applicationsCount per vacancy (0 when absent from the grouped counts)', async () => {
      const rowA = makeRow({ id: 'vac-a', slug: 'vac-a' })
      const rowB = makeRow({ id: 'vac-b', slug: 'vac-b' })
      const h = makeHarness({
        listRows: [rowA, rowB],
        applicationCounts: [{ vacancyId: 'vac-a', count: 3 }],
      })
      const svc = new VacanciesService(h.db)
      const result = await svc.listAdmin(ADMIN)
      const a = result.find((r) => r.id === 'vac-a')
      const b = result.find((r) => r.id === 'vac-b')
      expect(a?.applicationsCount).toBe(3)
      expect(b?.applicationsCount).toBe(0)
    })

    it('listAdmin rejects with 403 for a non ADMIN/HR actor', async () => {
      const h = makeHarness({ listRows: [] })
      const svc = new VacanciesService(h.db)
      await expect(svc.listAdmin(SENIOR)).rejects.toThrow(ForbiddenException)
    })
  })
})
