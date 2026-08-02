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
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import type {
  CreateVacancy,
  PublicVacancy,
  PublicVacancyDetail,
  SessionUser,
  UpdateVacancy,
  Vacancy,
  VacancyLocale,
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

  /** Only PUBLISHED vacancies, most recently published first. `locale` defaults to `en` (site default, plan §1). */
  async listPublic(locale: VacancyLocale = 'en'): Promise<PublicVacancy[]> {
    const rows = await this.db.db
      .select()
      .from(vacancies)
      .where(eq(vacancies.status, 'PUBLISHED'))
      .orderBy(desc(vacancies.publishedAt))
    return rows.map((r) => this.mapPublic(r, locale))
  }

  /**
   * 404 for DRAFT / non-existent (never reveal whether a slug ever existed
   * once it's no longer publicly visible) — 410 Gone for CLOSED (task
   * C5/task-careers-seo-v2 §3: a formerly-live posting is genuinely GONE,
   * a stronger de-index signal to Google than a plain 404, and distinct from
   * "never existed"). `locale` defaults to `en`.
   */
  async getPublicBySlug(slug: string, locale: VacancyLocale = 'en'): Promise<PublicVacancyDetail> {
    const row = await this.getPublishedRowBySlug(slug)
    const related = await this.findRelated(row)
    return this.mapPublicDetail(row, related, locale)
  }

  /**
   * Shared with ApplicationsService.apply() — same 404 (DRAFT/missing) / 410
   * (CLOSED) semantics as `getPublicBySlug` above; applying to a closed
   * posting is exactly as "gone" as viewing its detail page.
   */
  async getPublishedRowBySlug(slug: string): Promise<VacancyRow> {
    const row = await this.db.db.query.vacancies.findFirst({ where: eq(vacancies.slug, slug) })
    if (!row) throw new NotFoundException('Вакансия не найдена')
    if (row.status === 'CLOSED') {
      throw new HttpException('Вакансия закрыта', HttpStatus.GONE)
    }
    if (row.status !== 'PUBLISHED') {
      throw new NotFoundException('Вакансия не найдена')
    }
    return row
  }

  /**
   * Up to 3 other PUBLISHED vacancies in the same domain, most recently
   * published first (task C8 — "Похожие вакансии" internal-linking block).
   */
  private async findRelated(row: VacancyRow): Promise<VacancyRow[]> {
    return this.db.db.query.vacancies.findMany({
      where: and(
        eq(vacancies.status, 'PUBLISHED'),
        eq(vacancies.domain, row.domain),
        ne(vacancies.id, row.id),
      ),
      orderBy: desc(vacancies.publishedAt),
      limit: 3,
    })
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
    // Defense-in-depth (AC1) — createVacancySchema already requires these 4
    // fields at the type/parse level; re-asserted here in case a caller ever
    // constructs a `CreateVacancy` without going through `.parse()`.
    this.assertSalaryFilled(dto)

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
        translations: dto.translations ?? null,
        skills: dto.skills ?? null,
        experienceMonths: dto.experienceMonths ?? null,
        qualifications: dto.qualifications ?? null,
        responsibilities: dto.responsibilities ?? null,
        jobBenefits: dto.jobBenefits ?? null,
        workHours: dto.workHours ?? null,
        // numeric() columns round-trip as strings — same String() convention
        // as users.monthlySalary (UsersService.createUser).
        salaryMin: String(dto.salaryMin),
        salaryMax: String(dto.salaryMax),
        salaryCurrency: dto.salaryCurrency,
        salaryPeriod: dto.salaryPeriod,
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
    if (dto.translations !== undefined) updates.translations = dto.translations
    if (dto.skills !== undefined) updates.skills = dto.skills
    if (dto.experienceMonths !== undefined) updates.experienceMonths = dto.experienceMonths
    if (dto.qualifications !== undefined) updates.qualifications = dto.qualifications
    if (dto.responsibilities !== undefined) updates.responsibilities = dto.responsibilities
    if (dto.jobBenefits !== undefined) updates.jobBenefits = dto.jobBenefits
    if (dto.workHours !== undefined) updates.workHours = dto.workHours
    // numeric() columns round-trip as strings (same convention as create()).
    if (dto.salaryMin !== undefined) updates.salaryMin = String(dto.salaryMin)
    if (dto.salaryMax !== undefined) updates.salaryMax = String(dto.salaryMax)
    if (dto.salaryCurrency !== undefined) updates.salaryCurrency = dto.salaryCurrency
    if (dto.salaryPeriod !== undefined) updates.salaryPeriod = dto.salaryPeriod

    if (dto.status !== undefined && dto.status !== row.status) {
      const allowed = VALID_TRANSITIONS[row.status] ?? []
      if (!allowed.includes(dto.status)) {
        throw new ConflictException(
          `Недопустимый переход статуса вакансии: ${row.status} → ${dto.status}`,
        )
      }
      if (dto.status === 'PUBLISHED') {
        // AC2 — a vacancy cannot be (re)published without a filled salary
        // range. `dto` overrides `row` when the SAME request also sets the
        // fields (e.g. filling salary + publishing in one PATCH) — this is
        // the only place `updateVacancySchema`'s optional salary fields are
        // enforced (the schema itself stays a no-op-when-omitted PATCH, see
        // packages/shared vacancies.ts doc). Existing PUBLISHED rows (3 on
        // prod, AC3) are UNAFFECTED — this only fires on a STATUS TRANSITION,
        // never on an unrelated PATCH to an already-PUBLISHED vacancy.
        this.assertSalaryFilled({
          salaryMin: dto.salaryMin !== undefined ? dto.salaryMin : row.salaryMin,
          salaryMax: dto.salaryMax !== undefined ? dto.salaryMax : row.salaryMax,
          salaryCurrency:
            dto.salaryCurrency !== undefined ? dto.salaryCurrency : row.salaryCurrency,
          salaryPeriod: dto.salaryPeriod !== undefined ? dto.salaryPeriod : row.salaryPeriod,
        })
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
   * task-vacancy-salary-range (AC1/AC2) — the mandatory-salary-range gate.
   * Called from `create()` (defense-in-depth over the Zod schema) and from
   * `update()` ONLY when a PATCH transitions status to PUBLISHED (the
   * effective, post-update value — see that call site's comment). Presence-
   * only (not min<=max ordering — see `createVacancySalaryFieldsSchema`'s doc
   * in packages/shared for why that ordering check lives in the CRM form
   * instead of a schema-level `.refine()`).
   */
  private assertSalaryFilled(fields: {
    salaryMin: number | string | null | undefined
    salaryMax: number | string | null | undefined
    salaryCurrency: string | null | undefined
    salaryPeriod: string | null | undefined
  }): void {
    if (
      fields.salaryMin == null ||
      fields.salaryMax == null ||
      fields.salaryCurrency == null ||
      fields.salaryPeriod == null
    ) {
      throw new BadRequestException('Укажите вилку зарплаты: минимум, максимум, валюту и период')
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

  /**
   * Resolves `title`/`descriptionMd` for a requested locale (task
   * C1/C2 — plan §3 contract). `en` is always the row's own columns — never
   * stored in `translations` (data-driven over
   * `VACANCY_TRANSLATION_LOCALES`, so `locale` narrows to a valid
   * `row.translations` key once `en` is ruled out). Missing translation ->
   * original copy + `isFallback: true`.
   */
  private resolveLocalized(
    row: VacancyRow,
    locale: VacancyLocale,
  ): { title: string; descriptionMd: string; isFallback: boolean } {
    if (locale === 'en') {
      return { title: row.title, descriptionMd: row.descriptionMd, isFallback: false }
    }
    const translation = row.translations?.[locale]
    if (!translation) {
      return { title: row.title, descriptionMd: row.descriptionMd, isFallback: true }
    }
    return { title: translation.title, descriptionMd: translation.description, isFallback: false }
  }

  private mapPublic(row: VacancyRow, locale: VacancyLocale): PublicVacancy {
    const localized = this.resolveLocalized(row, locale)
    return {
      slug: row.slug,
      title: localized.title,
      domain: row.domain,
      seniority: row.seniority,
      employmentType: row.employmentType,
      location: row.location,
      // Only ever called for PUBLISHED rows — publishedAt is guaranteed set.
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
      isFallback: localized.isFallback,
      // task-vacancy-salary-range — `null` for the 3 vacancies already
      // PUBLISHED on prod before this change (AC3), until the owner fills
      // them in through the CRM.
      salaryMin: row.salaryMin,
      salaryMax: row.salaryMax,
      salaryCurrency: row.salaryCurrency,
      salaryPeriod: row.salaryPeriod,
    }
  }

  private mapPublicDetail(
    row: VacancyRow,
    related: VacancyRow[],
    locale: VacancyLocale,
  ): PublicVacancyDetail {
    const localized = this.resolveLocalized(row, locale)
    return {
      ...this.mapPublic(row, locale),
      descriptionMd: localized.descriptionMd,
      skills: row.skills ?? null,
      experienceMonths: row.experienceMonths ?? null,
      qualifications: row.qualifications ?? null,
      responsibilities: row.responsibilities ?? null,
      jobBenefits: row.jobBenefits ?? null,
      workHours: row.workHours ?? null,
      relatedVacancies: related.map((r) => this.mapPublic(r, locale)),
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
      translations: row.translations ?? null,
      skills: row.skills ?? null,
      experienceMonths: row.experienceMonths ?? null,
      qualifications: row.qualifications ?? null,
      responsibilities: row.responsibilities ?? null,
      jobBenefits: row.jobBenefits ?? null,
      workHours: row.workHours ?? null,
      salaryMin: row.salaryMin,
      salaryMax: row.salaryMax,
      salaryCurrency: row.salaryCurrency,
      salaryPeriod: row.salaryPeriod,
    }
  }
}
