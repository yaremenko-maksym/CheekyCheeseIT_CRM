import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm'
import type {
  CreateJobExclusionDto,
  JobCollectionResultDto,
  JobExclusionDto,
  JobSourceType,
  JobSuggestionDto,
  JobSuggestionListDto,
  SessionUser,
  UpdateJobSuggestionStatusDto,
} from '@crm/shared'
import { normalizeCompanyName } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import {
  type JobPosting,
  jobExclusionFilters,
  jobPostings,
  jobSources,
  jobSuggestions,
  projects,
  teamMembers,
  users,
} from '../database/schema'
import { DouRssProvider } from './dou.provider'
import { deriveProjectExclusions, findMatchingExclusion } from './filtering'
import type { JobSourceProvider, NormalizedPosting } from './job-source.provider'

/**
 * Job sourcing — task-job-sourcing-slice1.
 *
 * Collect external vacancies → offer each senior the ones that pass their
 * filters → record what they did with it.
 *
 * RBAC mirrors the interviews board (docs/business/modules/interviews.md), which
 * is the surface this feature hangs off:
 *   ADMIN  — any senior's queue
 *   HR     — seniors in their own active teams (via the shared HrAccessService)
 *   SENIOR — their own queue only
 *   everyone else — 403.
 * The role SET is gated by `@Roles` on the controller; the per-senior SCOPE is
 * decided here, in one place (`assertCanAccessSenior`).
 */

/** How long a posting nobody applied to is kept. */
export const POSTING_RETENTION_DAYS = 90
/** Page size for a senior's queue — the modal shows one at a time. */
export const SUGGESTIONS_PAGE_SIZE = 20

type SuggestionRow = {
  id: string
  seniorId: string
  status: 'NEW' | 'APPLIED' | 'REJECTED'
  statusChangedAt: Date | null
  createdAt: Date
  statusChangedByName: string | null
  posting: JobPosting
}

@Injectable()
export class JobSourcingService {
  private readonly logger = new Logger(JobSourcingService.name)
  private readonly providers: Map<JobSourceType, JobSourceProvider>

  constructor(
    private readonly db: DatabaseService,
    private readonly hrAccess: HrAccessService,
    dou: DouRssProvider,
  ) {
    // Provider registry — slice 2 adds its source here and nothing else in this
    // service changes.
    this.providers = new Map<JobSourceType, JobSourceProvider>([[dou.type, dou]])
  }

  // -------------------------------------------------------------------------
  // RBAC
  // -------------------------------------------------------------------------

  /**
   * Resolve + authorize the senior whose queue is being touched. Returns the
   * effective senior id (a SENIOR always gets their own, whatever they asked
   * for — the same "ignore the parameter" shape InterviewsService uses).
   */
  private async assertCanAccessSenior(
    user: SessionUser,
    requestedSeniorId: string | undefined,
  ): Promise<string> {
    if (user.role === 'SENIOR') return user.id

    if (!requestedSeniorId) {
      throw new BadRequestException('seniorId обязателен')
    }

    if (user.role === 'ADMIN') return requestedSeniorId

    if (user.role === 'HR') {
      const shares = await this.hrAccess.hrSharesActiveTeamWith(user.id, requestedSeniorId)
      if (!shares) throw new ForbiddenException('Этот синьор не в ваших командах')
      return requestedSeniorId
    }

    throw new ForbiddenException('Нет доступа к подбору вакансий')
  }

  /** GLOBAL exclusions are a studio-wide policy — ADMIN/HR only. */
  private assertCanManageGlobal(user: SessionUser): void {
    if (user.role !== 'ADMIN' && user.role !== 'HR') {
      throw new ForbiddenException('Общий список исключений редактируют ADMIN и HR')
    }
  }

  // -------------------------------------------------------------------------
  // Exclusions
  // -------------------------------------------------------------------------

  /**
   * Full exclusion set applied to one senior: studio-wide rows + that senior's
   * own rows + the entries DERIVED from their projects (never stored, so they
   * cannot go stale — see filtering.ts).
   */
  async buildExclusionSet(seniorId: string): Promise<JobExclusionDto[]> {
    const rows = await this.db.db
      .select()
      .from(jobExclusionFilters)
      .where(
        sql`${jobExclusionFilters.seniorId} IS NULL OR ${jobExclusionFilters.seniorId} = ${seniorId}`,
      )

    const manual: JobExclusionDto[] = rows.map((row) => ({
      id: row.id,
      scope: row.seniorId === null ? 'GLOBAL' : 'SENIOR',
      seniorId: row.seniorId,
      kind: row.kind,
      value: row.value,
      normalizedValue: row.normalizedValue,
      origin: 'MANUAL',
      sourceLabel: null,
      createdAt: row.createdAt.toISOString(),
    }))

    const projectRows = await this.db.db
      .select({
        name: projects.name,
        companyName: projects.companyName,
        archivedAt: projects.archivedAt,
      })
      .from(projects)
      .where(eq(projects.seniorId, seniorId))

    return [...manual, ...deriveProjectExclusions(seniorId, projectRows)]
  }

  async listExclusions(
    requestedSeniorId: string | undefined,
    user: SessionUser,
  ): Promise<{ items: JobExclusionDto[] }> {
    const seniorId = await this.assertCanAccessSenior(user, requestedSeniorId)
    return { items: await this.buildExclusionSet(seniorId) }
  }

  async createExclusion(dto: CreateJobExclusionDto, user: SessionUser): Promise<JobExclusionDto> {
    const normalizedValue = normalizeCompanyName(dto.value)
    if (normalizedValue.length === 0) {
      throw new BadRequestException('Значение исключения не содержит букв или цифр')
    }

    let seniorId: string | null = null
    if (dto.scope === 'GLOBAL') {
      this.assertCanManageGlobal(user)
    } else {
      seniorId = await this.assertCanAccessSenior(user, dto.seniorId ?? undefined)
    }

    const [row] = await this.db.db
      .insert(jobExclusionFilters)
      .values({
        seniorId,
        kind: dto.kind,
        value: dto.value.trim(),
        normalizedValue,
        createdBy: user.id,
      })
      .onConflictDoNothing()
      .returning()

    if (row) {
      return {
        id: row.id,
        scope: row.seniorId === null ? 'GLOBAL' : 'SENIOR',
        seniorId: row.seniorId,
        kind: row.kind,
        value: row.value,
        normalizedValue: row.normalizedValue,
        origin: 'MANUAL',
        sourceLabel: null,
        createdAt: row.createdAt.toISOString(),
      }
    }

    // ON CONFLICT: the identical exclusion already exists. Return it instead of
    // erroring — adding the same company twice is a no-op, not a failure.
    const existing = await this.db.db
      .select()
      .from(jobExclusionFilters)
      .where(
        and(
          seniorId === null
            ? isNull(jobExclusionFilters.seniorId)
            : eq(jobExclusionFilters.seniorId, seniorId),
          eq(jobExclusionFilters.kind, dto.kind),
          eq(jobExclusionFilters.normalizedValue, normalizedValue),
        ),
      )
      .limit(1)
      .then((r) => r[0])

    if (!existing) throw new NotFoundException('Исключение не найдено')
    return {
      id: existing.id,
      scope: existing.seniorId === null ? 'GLOBAL' : 'SENIOR',
      seniorId: existing.seniorId,
      kind: existing.kind,
      value: existing.value,
      normalizedValue: existing.normalizedValue,
      origin: 'MANUAL',
      sourceLabel: null,
      createdAt: existing.createdAt.toISOString(),
    }
  }

  async deleteExclusion(id: string, user: SessionUser): Promise<void> {
    const row = await this.db.db
      .select()
      .from(jobExclusionFilters)
      .where(eq(jobExclusionFilters.id, id))
      .limit(1)
      .then((r) => r[0])
    if (!row) throw new NotFoundException('Исключение не найдено')

    if (row.seniorId === null) this.assertCanManageGlobal(user)
    else await this.assertCanAccessSenior(user, row.seniorId)

    await this.db.db.delete(jobExclusionFilters).where(eq(jobExclusionFilters.id, id))
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  private mapSuggestion(row: SuggestionRow): JobSuggestionDto {
    return {
      id: row.id,
      seniorId: row.seniorId,
      status: row.status,
      statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
      statusChangedByName: row.statusChangedByName,
      createdAt: row.createdAt.toISOString(),
      posting: {
        id: row.posting.id,
        sourceType: row.posting.sourceType,
        externalId: row.posting.externalId,
        url: row.posting.url,
        title: row.posting.title,
        companyName: row.posting.companyName,
        location: row.posting.location,
        descriptionMd: row.posting.descriptionMd,
        publishedAt: row.posting.publishedAt?.toISOString() ?? null,
        collectedAt: row.posting.collectedAt.toISOString(),
      },
    }
  }

  /**
   * The senior's queue: NEW suggestions, newest posting first, with the CURRENT
   * exclusion set applied on read.
   *
   * Filtering happens at collection time too, but re-applying it here is what
   * makes a filter added AFTER collection take effect immediately — otherwise a
   * senior who just excluded their employer would keep being shown that
   * employer until the next cron run.
   */
  async listSuggestions(
    requestedSeniorId: string | undefined,
    user: SessionUser,
  ): Promise<JobSuggestionListDto> {
    const seniorId = await this.assertCanAccessSenior(user, requestedSeniorId)
    const exclusions = await this.buildExclusionSet(seniorId)

    const rows = await this.db.db
      .select({
        id: jobSuggestions.id,
        seniorId: jobSuggestions.seniorId,
        status: jobSuggestions.status,
        statusChangedAt: jobSuggestions.statusChangedAt,
        createdAt: jobSuggestions.createdAt,
        statusChangedByName: users.displayName,
        posting: jobPostings,
      })
      .from(jobSuggestions)
      .innerJoin(jobPostings, eq(jobSuggestions.postingId, jobPostings.id))
      .leftJoin(users, eq(jobSuggestions.statusChangedBy, users.id))
      .where(and(eq(jobSuggestions.seniorId, seniorId), eq(jobSuggestions.status, 'NEW')))
      .orderBy(desc(jobPostings.publishedAt), desc(jobPostings.collectedAt))

    const visible = rows.filter((row) => findMatchingExclusion(row.posting, exclusions) === null)

    return {
      items: visible.slice(0, SUGGESTIONS_PAGE_SIZE).map((row) => this.mapSuggestion(row)),
      total: visible.length,
    }
  }

  async updateStatus(
    id: string,
    dto: UpdateJobSuggestionStatusDto,
    user: SessionUser,
  ): Promise<JobSuggestionDto> {
    const existing = await this.db.db
      .select({ id: jobSuggestions.id, seniorId: jobSuggestions.seniorId })
      .from(jobSuggestions)
      .where(eq(jobSuggestions.id, id))
      .limit(1)
      .then((r) => r[0])
    if (!existing) throw new NotFoundException('Предложение не найдено')

    // IDOR guard: a SENIOR may only touch rows on their OWN queue, an HR only
    // rows of seniors in their teams.
    const seniorId = await this.assertCanAccessSenior(user, existing.seniorId)
    if (seniorId !== existing.seniorId) {
      throw new ForbiddenException('Нет доступа к этому предложению')
    }

    await this.db.db
      .update(jobSuggestions)
      .set({ status: dto.status, statusChangedAt: new Date(), statusChangedBy: user.id })
      .where(eq(jobSuggestions.id, id))

    const row = await this.db.db
      .select({
        id: jobSuggestions.id,
        seniorId: jobSuggestions.seniorId,
        status: jobSuggestions.status,
        statusChangedAt: jobSuggestions.statusChangedAt,
        createdAt: jobSuggestions.createdAt,
        statusChangedByName: users.displayName,
        posting: jobPostings,
      })
      .from(jobSuggestions)
      .innerJoin(jobPostings, eq(jobSuggestions.postingId, jobPostings.id))
      .leftJoin(users, eq(jobSuggestions.statusChangedBy, users.id))
      .where(eq(jobSuggestions.id, id))
      .limit(1)
      .then((r) => r[0])

    if (!row) throw new NotFoundException('Предложение не найдено')
    return this.mapSuggestion(row)
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  /** Seniors who can be offered anything: active, non-archived, in a team. */
  private async findEligibleSeniorIds(): Promise<string[]> {
    const rows = await this.db.db
      .selectDistinct({ id: users.id })
      .from(users)
      .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
      .where(and(eq(users.role, 'SENIOR'), isNull(users.archivedAt), isNull(teamMembers.leftAt)))
    return rows.map((r) => r.id)
  }

  /**
   * Persist a batch of normalized postings, skipping ones already known.
   * Dedupe is the DB's job: a unique index on `fingerprint` + ON CONFLICT DO
   * NOTHING, so two collection runs racing each other cannot double-insert
   * either (AC1).
   */
  private async persistPostings(
    sourceId: string,
    postings: NormalizedPosting[],
  ): Promise<{ created: JobPosting[]; duplicates: number }> {
    const created: JobPosting[] = []
    let duplicates = 0

    for (const posting of postings) {
      const [row] = await this.db.db
        .insert(jobPostings)
        .values({
          sourceType: posting.sourceType,
          sourceId,
          externalId: posting.externalId,
          url: posting.url,
          title: posting.title,
          companyName: posting.companyName,
          companyNameNormalized: posting.companyNameNormalized,
          location: posting.location,
          descriptionMd: posting.descriptionMd,
          publishedAt: posting.publishedAt,
          fingerprint: posting.fingerprint,
        })
        .onConflictDoNothing({ target: jobPostings.fingerprint })
        .returning()

      if (row) created.push(row)
      else duplicates += 1
    }

    return { created, duplicates }
  }

  /**
   * Offer freshly collected postings to every eligible senior, skipping the ones
   * their filters exclude. The unique (posting_id, senior_id) index means a
   * posting a senior already REJECTED can never come back as NEW (AC4).
   */
  private async createSuggestions(postings: JobPosting[]): Promise<number> {
    if (postings.length === 0) return 0
    const seniorIds = await this.findEligibleSeniorIds()
    if (seniorIds.length === 0) return 0

    let inserted = 0
    for (const seniorId of seniorIds) {
      const exclusions = await this.buildExclusionSet(seniorId)
      const allowed = postings.filter((p) => findMatchingExclusion(p, exclusions) === null)
      if (allowed.length === 0) continue

      const rows = await this.db.db
        .insert(jobSuggestions)
        .values(allowed.map((posting) => ({ postingId: posting.id, seniorId })))
        .onConflictDoNothing()
        .returning({ id: jobSuggestions.id })
      inserted += rows.length
    }
    return inserted
  }

  /** Run one configured source end to end. */
  async collectSource(source: {
    id: string
    type: JobSourceType
    config: unknown
  }): Promise<JobCollectionResultDto> {
    const provider = this.providers.get(source.type)
    if (!provider) throw new BadRequestException(`Нет провайдера для источника ${source.type}`)

    const config = (source.config ?? {}) as Record<string, unknown>
    const postings = await provider.collect(config)
    const { created, duplicates } = await this.persistPostings(source.id, postings)
    const suggestionsCreated = await this.createSuggestions(created)

    await this.db.db
      .update(jobSources)
      .set({ lastCollectedAt: new Date(), updatedAt: new Date() })
      .where(eq(jobSources.id, source.id))

    return {
      sourceType: source.type,
      fetched: postings.length,
      created: created.length,
      duplicates,
      invalid: 0,
      suggestionsCreated,
    }
  }

  /**
   * Run every enabled source. One failing source is logged and skipped — a
   * third-party outage must not stop the others (or, when called from the cron,
   * kill the scheduler).
   */
  async collectAll(): Promise<JobCollectionResultDto[]> {
    const sources = await this.db.db.select().from(jobSources).where(eq(jobSources.enabled, true))

    const results: JobCollectionResultDto[] = []
    for (const source of sources) {
      try {
        results.push(await this.collectSource(source))
      } catch (err: unknown) {
        this.logger.error(
          `Job collection failed for source ${source.type} (${source.id})`,
          err instanceof Error ? err.stack : String(err),
        )
      }
    }
    return results
  }

  /**
   * Drop postings older than `POSTING_RETENTION_DAYS` that nobody APPLIED to.
   * Without this the table only ever grows: the feed adds ~25 rows a day
   * forever, and a stale ad is worse than no ad. Postings behind an APPLIED
   * suggestion are kept — that is the senior's own application history.
   */
  async purgeStalePostings(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - POSTING_RETENTION_DAYS * 24 * 60 * 60 * 1000)

    const appliedPostingIds = await this.db.db
      .selectDistinct({ postingId: jobSuggestions.postingId })
      .from(jobSuggestions)
      .where(eq(jobSuggestions.status, 'APPLIED'))

    const keep = appliedPostingIds.map((r) => r.postingId)
    const deleted = await this.db.db
      .delete(jobPostings)
      .where(
        keep.length > 0
          ? and(lt(jobPostings.collectedAt, cutoff), notInArray(jobPostings.id, keep))
          : lt(jobPostings.collectedAt, cutoff),
      )
      .returning({ id: jobPostings.id })

    return deleted.length
  }

  /** Used by the controller's ADMIN-only manual trigger. */
  async listSources(): Promise<{ id: string; type: JobSourceType; enabled: boolean }[]> {
    const rows = await this.db.db.select().from(jobSources)
    return rows.map((r) => ({ id: r.id, type: r.type, enabled: r.enabled }))
  }

  /** Exposed for the integration test's setup path. */
  async findSeniorsForTesting(): Promise<string[]> {
    return this.findEligibleSeniorIds()
  }

  /** Suggestions of one senior regardless of status — used by tests + audits. */
  async countSuggestionsByStatus(seniorId: string): Promise<Record<string, number>> {
    const rows = await this.db.db
      .select({ status: jobSuggestions.status, count: sql<number>`count(*)::int` })
      .from(jobSuggestions)
      .where(eq(jobSuggestions.seniorId, seniorId))
      .groupBy(jobSuggestions.status)
    return Object.fromEntries(rows.map((r) => [r.status, r.count]))
  }

  /** Narrow helper kept for symmetry with `inArray` usage above. */
  protected async postingsByIds(ids: string[]): Promise<JobPosting[]> {
    if (ids.length === 0) return []
    return await this.db.db.select().from(jobPostings).where(inArray(jobPostings.id, ids))
  }
}
