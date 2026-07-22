/**
 * VacanciesService — task-vacancies-api.
 *
 * Public hiring channel for new SENIORs — completely separate from the
 * interviews Kanban. This service owns:
 *   - public read paths (landing): list PUBLISHED, get one by slug
 *   - admin CRUD (ADMIN | HR): list all, create, update (incl. status
 *     transitions), delete
 *
 * RBAC: the controller gates with `@UseGuards(RolesGuard)` + `@Roles(...)`,
 * but every admin method here ALSO asserts the role explicitly (defense-in-
 * depth — the guarantee must survive even if the controller decorator is
 * ever dropped; see the #157/#158 lesson referenced across the codebase).
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { desc, eq, sql } from 'drizzle-orm'
import type {
  CreateVacancy,
  PublicVacancy,
  PublicVacancyDetail,
  SessionUser,
  UpdateVacancy,
  Vacancy,
  VacancyStatus,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { vacancies, vacancyApplications } from '../database/schema'

type VacancyRow = typeof vacancies.$inferSelect

/**
 * Status transition table (task §4). Any transition not listed here is
 * rejected with 409 — including no-op "transitions" to the same status
 * (callers that don't want to change status simply omit `status` from the
 * update payload).
 */
const VALID_TRANSITIONS: Record<VacancyStatus, VacancyStatus[]> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: ['PUBLISHED'],
}

@Injectable()
export class VacanciesService {
  constructor(private readonly db: DatabaseService) {}

  // ---------------------------------------------------------------------------
  // Public (landing) — no auth
  // ---------------------------------------------------------------------------

  /** Only PUBLISHED vacancies, most recently published first. */
  async listPublic(): Promise<PublicVacancy[]> {
    const rows = await this.db.db
      .select()
      .from(vacancies)
      .where(eq(vacancies.status, 'PUBLISHED'))
      .orderBy(desc(vacancies.publishedAt))
    return rows.map((r) => this.mapPublic(r))
  }

  /**
   * 404 for DRAFT / CLOSED / non-existent — the public endpoint must not
   * reveal whether a slug ever existed once it's no longer publicly visible.
   */
  async getPublicBySlug(slug: string): Promise<PublicVacancyDetail> {
    const row = await this.getPublishedRowBySlug(slug)
    return this.mapPublicDetail(row)
  }

  /** Shared with ApplicationsService.apply() — same 404 semantics as above. */
  async getPublishedRowBySlug(slug: string): Promise<VacancyRow> {
    const row = await this.db.db.query.vacancies.findFirst({ where: eq(vacancies.slug, slug) })
    if (!row || row.status !== 'PUBLISHED') {
      throw new NotFoundException('Вакансия не найдена')
    }
    return row
  }

  // ---------------------------------------------------------------------------
  // Admin (ADMIN | HR)
  // ---------------------------------------------------------------------------

  async listAdmin(actor: SessionUser): Promise<Vacancy[]> {
    this.assertAdminOrHr(actor)
    const rows = await this.db.db.select().from(vacancies).orderBy(desc(vacancies.createdAt))
    const counts = await this.applicationCounts()
    return rows.map((r) => this.mapVacancy(r, counts.get(r.id) ?? 0))
  }

  async create(actor: SessionUser, dto: CreateVacancy): Promise<Vacancy> {
    this.assertAdminOrHr(actor)
    await this.assertSlugFree(dto.slug)

    const [row] = await this.db.db
      .insert(vacancies)
      .values({
        slug: dto.slug,
        title: dto.title,
        descriptionMd: dto.descriptionMd,
        domain: dto.domain,
        seniority: dto.seniority,
        employmentType: dto.employmentType,
        location: dto.location,
        createdBy: actor.id,
      })
      .returning()

    if (!row) throw new Error('Failed to insert vacancy')
    return this.mapVacancy(row, 0)
  }

  async update(actor: SessionUser, id: string, dto: UpdateVacancy): Promise<Vacancy> {
    this.assertAdminOrHr(actor)
    const row = await this.getRowOrThrow(id)

    if (dto.slug !== undefined && dto.slug !== row.slug) {
      await this.assertSlugFree(dto.slug)
    }

    const updates: Partial<typeof vacancies.$inferInsert> = { updatedAt: new Date() }
    if (dto.title !== undefined) updates.title = dto.title
    if (dto.slug !== undefined) updates.slug = dto.slug
    if (dto.descriptionMd !== undefined) updates.descriptionMd = dto.descriptionMd
    if (dto.domain !== undefined) updates.domain = dto.domain
    if (dto.seniority !== undefined) updates.seniority = dto.seniority
    if (dto.employmentType !== undefined) updates.employmentType = dto.employmentType
    if (dto.location !== undefined) updates.location = dto.location

    if (dto.status !== undefined && dto.status !== row.status) {
      const allowed = VALID_TRANSITIONS[row.status] ?? []
      if (!allowed.includes(dto.status)) {
        throw new ConflictException(
          `Недопустимый переход статуса вакансии: ${row.status} → ${dto.status}`,
        )
      }
      updates.status = dto.status
      if (dto.status === 'PUBLISHED') {
        // DRAFT → PUBLISHED sets publishedAt. CLOSED → PUBLISHED (re-open)
        // leaves the original publishedAt untouched — only closedAt resets.
        if (row.status === 'DRAFT') updates.publishedAt = new Date()
        updates.closedAt = null
      } else if (dto.status === 'CLOSED') {
        updates.closedAt = new Date()
      }
    }

    const [updated] = await this.db.db
      .update(vacancies)
      .set(updates)
      .where(eq(vacancies.id, id))
      .returning()
    if (!updated) throw new Error('Failed to update vacancy')

    const count = await this.countApplicationsFor(id)
    return this.mapVacancy(updated, count)
  }

  /** 409 if not DRAFT, or if it already has applications. */
  async remove(actor: SessionUser, id: string): Promise<void> {
    this.assertAdminOrHr(actor)
    const row = await this.getRowOrThrow(id)

    if (row.status !== 'DRAFT') {
      throw new ConflictException('Удалить можно только вакансию в статусе DRAFT')
    }
    const count = await this.countApplicationsFor(id)
    if (count > 0) {
      throw new ConflictException('Нельзя удалить вакансию с откликами')
    }
    await this.db.db.delete(vacancies).where(eq(vacancies.id, id))
  }

  /** Shared with ApplicationsService admin endpoints (applications list/update/delete/resume-url). */
  async getRowOrThrow(id: string): Promise<VacancyRow> {
    const row = await this.db.db.query.vacancies.findFirst({ where: eq(vacancies.id, id) })
    if (!row) throw new NotFoundException('Вакансия не найдена')
    return row
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private assertAdminOrHr(actor: SessionUser): void {
    if (actor.role !== 'ADMIN' && actor.role !== 'HR') {
      throw new ForbiddenException('Доступно только ADMIN и HR')
    }
  }

  private async assertSlugFree(slug: string): Promise<void> {
    const existing = await this.db.db.query.vacancies.findFirst({
      where: eq(vacancies.slug, slug),
    })
    if (existing) throw new ConflictException(`Вакансия со slug "${slug}" уже существует`)
  }

  private async countApplicationsFor(vacancyId: string): Promise<number> {
    const rows = await this.db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(vacancyApplications)
      .where(eq(vacancyApplications.vacancyId, vacancyId))
    return rows[0]?.count ?? 0
  }

  private async applicationCounts(): Promise<Map<string, number>> {
    const rows = await this.db.db
      .select({
        vacancyId: vacancyApplications.vacancyId,
        count: sql<number>`count(*)::int`,
      })
      .from(vacancyApplications)
      .groupBy(vacancyApplications.vacancyId)
    return new Map(rows.map((r) => [r.vacancyId, r.count]))
  }

  private mapPublic(row: VacancyRow): PublicVacancy {
    return {
      slug: row.slug,
      title: row.title,
      domain: row.domain,
      seniority: row.seniority,
      employmentType: row.employmentType,
      location: row.location,
      // Only ever called for PUBLISHED rows — publishedAt is guaranteed set.
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    }
  }

  private mapPublicDetail(row: VacancyRow): PublicVacancyDetail {
    return {
      ...this.mapPublic(row),
      descriptionMd: row.descriptionMd,
    }
  }

  private mapVacancy(row: VacancyRow, applicationsCount: number): Vacancy {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      domain: row.domain,
      seniority: row.seniority,
      employmentType: row.employmentType,
      location: row.location,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      descriptionMd: row.descriptionMd,
      status: row.status,
      closedAt: row.closedAt?.toISOString() ?? null,
      applicationsCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }
}
