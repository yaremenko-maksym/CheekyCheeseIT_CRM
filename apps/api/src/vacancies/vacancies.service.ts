/**
 * VacanciesService — task-vacancies-api (+ task-google-indexing-api hooks).
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
 *
 * Google Indexing API hooks (task-google-indexing-api): `update()` notifies
 * `GoogleIndexingService` after a successful DB commit whenever a status
 * transition publishes/closes a vacancy, or its slug changes while
 * PUBLISHED. The call is AWAITED inline rather than detached fire-and-forget
 * — `GoogleIndexingService`'s public methods are a guaranteed-fail-soft
 * contract (never reject, 5s internal timeout — see that file's header), so
 * awaiting adds negligible latency in the common (no-op or fast) case and
 * keeps this method's control flow simple. On top of that contract, this
 * call site ALSO wraps it in try/catch (belt-and-suspenders, same pattern as
 * ApplicationsService.notifyAdminsAndHr around NotificationsService.create):
 * a Google-side failure can NEVER roll back or fail an already-committed
 * status transition, even in the hypothetical case where
 * GoogleIndexingService's no-throw guarantee were ever violated by a future
 * change to that file.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
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
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { vacancies, vacancyApplications } from '../database/schema'
import { careersUrl } from './careers-url'
import { GoogleIndexingService } from './google-indexing.service'

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
  private readonly logger = new Logger(VacanciesService.name)
  private readonly landingOrigin: string

  constructor(
    private readonly db: DatabaseService,
    private readonly googleIndexing: GoogleIndexingService,
    config: ConfigService<Env, true>,
  ) {
    this.landingOrigin = config.get('PUBLIC_LANDING_ORIGIN', { infer: true })
  }

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

    // Fired AFTER the DB commit above — see the file-header comment on the
    // await + try/catch rationale (AC4: a Google API error must never break
    // an already-committed status transition).
    try {
      await this.notifyGoogleIndexing(row, updated)
    } catch (err: unknown) {
      this.logger.warn(
        `Google Indexing notification failed for vacancy ${id} (transition already committed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    const count = await this.countApplicationsFor(id)
    return this.mapVacancy(updated, count)
  }

  /**
   * task-vacancy-delete-closed: 409 unless status is DRAFT or CLOSED AND it
   * has zero applications. PUBLISHED can never be deleted directly (close it
   * first — a live hiring post is not a throwaway draft); DRAFT/CLOSED with
   * applications keep the guard too (applications carry R2 resume files +
   * history, cleaned only by the retention cron, never by a manual delete).
   */
  async remove(actor: SessionUser, id: string): Promise<void> {
    this.assertAdminOrHr(actor)
    const row = await this.getRowOrThrow(id)

    if (row.status !== 'DRAFT' && row.status !== 'CLOSED') {
      throw new ConflictException('Опубликованную вакансию нужно сначала закрыть')
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

  /**
   * task-google-indexing-api §2. `before`/`after` are the pre- and
   * post-update rows — comparing them (rather than re-deriving intent from
   * `dto`) keeps this correct regardless of which fields the caller actually
   * sent, and covers the 3 required cases:
   *   - `* → PUBLISHED` (DRAFT→PUBLISHED first-publish, or CLOSED→PUBLISHED
   *     re-open) → notifyUpdated(new URL). A re-open never needs a matching
   *     notifyDeleted for the old slug: either the slug is unchanged, or (if
   *     it also changed in this same request) the vacancy was CLOSED and
   *     therefore already removed from the index by the earlier
   *     PUBLISHED→CLOSED transition — nothing stale is left to delete.
   *   - `PUBLISHED → CLOSED` → notifyDeleted(URL as it was published,
   *     i.e. `before.slug` — a slug change is not expected to accompany a
   *     close, but using `before` is correct even if one is sent).
   *   - slug changes while status STAYS PUBLISHED → notifyDeleted(old URL) +
   *     notifyUpdated(new URL) (the old URL is no longer the canonical page).
   */
  private async notifyGoogleIndexing(before: VacancyRow, after: VacancyRow): Promise<void> {
    const becamePublished = before.status !== 'PUBLISHED' && after.status === 'PUBLISHED'
    const becameClosed = before.status === 'PUBLISHED' && after.status === 'CLOSED'
    const slugChangedWhilePublished =
      before.status === 'PUBLISHED' && after.status === 'PUBLISHED' && before.slug !== after.slug

    if (becamePublished) {
      await this.googleIndexing.notifyUpdated(careersUrl(this.landingOrigin, after.slug))
      return
    }
    if (becameClosed) {
      await this.googleIndexing.notifyDeleted(careersUrl(this.landingOrigin, before.slug))
      return
    }
    if (slugChangedWhilePublished) {
      await this.googleIndexing.notifyDeleted(careersUrl(this.landingOrigin, before.slug))
      await this.googleIndexing.notifyUpdated(careersUrl(this.landingOrigin, after.slug))
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
