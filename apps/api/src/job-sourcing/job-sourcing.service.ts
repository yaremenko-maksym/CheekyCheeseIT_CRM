import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm'
import type {
  CreateJobExclusionDto,
  JobCollectionFailureDto,
  JobCollectionResultDto,
  JobCollectionRunDto,
  JobExclusionDto,
  JobSourceDto,
  JobSourceTriggerMode,
  JobSourceType,
  JobSuggestionDto,
  JobSuggestionListDto,
  SessionUser,
  UpdateJobSuggestionStatusDto,
} from '@crm/shared'
import {
  budgetState,
  canonicalStackKeywords,
  normalizeCompanyName,
  resolveBudget,
  spendBudget,
  stackMatchScore,
  type SourceBudgetState,
} from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { DEFAULT_JOB_MATCH_THRESHOLD, type Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import {
  type JobPosting,
  type JobSource,
  jobExclusionFilters,
  jobPostings,
  jobSources,
  jobSuggestions,
  projects,
  seniorResumes,
  teamMembers,
  users,
} from '../database/schema'
import { DouRssProvider } from './dou.provider'
import { deriveProjectExclusions, findMatchingExclusion } from './filtering'
import { JobSourceBudgetExhaustedError } from './source-budget.error'
import { toSafeFailureMessage } from './safe-failure-message'
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

/**
 * Bound on `chargeBudget`'s re-read-and-retry loop (backlog #53).
 *
 * Two attempts cover the realistic case this fix targets: one caller wins the
 * first compare-and-set, a second loses it only because the row it read is
 * now stale, re-reads, and wins the second. A third+ attempt only matters
 * under genuine heavy contention (several processes charging the SAME source
 * in the SAME instant), which this codebase does not have today — the cron
 * runs `collectAll` sequentially and the manual trigger is one ADMIN clicking
 * a button. The bound exists so contention that outlives it still refuses
 * loudly rather than retrying forever.
 */
const CHARGE_BUDGET_MAX_ATTEMPTS = 3

/**
 * How many of the freshest suggestions are RANKED on one request.
 *
 * Security review MED-3. Scoring reads the whole description, and the queue is
 * unbounded: the feed adds ~25 postings a day and retention keeps them 90 days,
 * so a senior who never triages accumulates a couple of thousand NEW rows.
 *
 * MEASURED end to end against a real Postgres, 2250 NEW suggestions × 20 KB of
 * description, median of five runs on the same data and the same machine —
 * before and after are the SAME code path with only this window changed:
 *
 *     ranking every visible row (the previous behaviour)   3217 ms
 *     ranking the freshest 200 (this window)                306 ms
 *
 * Three seconds is not a slow endpoint — it is the single-threaded event loop
 * blocked for three seconds, i.e. the whole API unavailable to every other
 * request, because one senior opened a modal.
 *
 * The window bounds the WORK, not the queue: `total` stays exact (it is computed
 * from a cheap projection that never touches `description_md`), the page cap
 * already limited what is displayed, and the senior works down the queue as
 * before. The trade-off is honest and bounded: a vacancy older than the freshest
 * 200 visible ones is not ranked on this request, so a superb match from two
 * months ago waits its turn instead of jumping the queue.
 *
 * The exact fix — canonical match tokens computed ONCE at ingest and stored on
 * the posting — is the right long-term answer and is noted in the PR as
 * follow-up; it needs a column, a backfill and prod DDL, which is more than this
 * change should carry.
 */
export const SUGGESTION_RANKING_WINDOW = 200

type SuggestionRow = {
  id: string
  seniorId: string
  status: 'NEW' | 'APPLIED' | 'REJECTED'
  statusChangedAt: Date | null
  createdAt: Date
  statusChangedByName: string | null
  posting: JobPosting
}

/**
 * What `collectSource` needs from a source row: identity, provider config and
 * the budget columns. Structural rather than `JobSource` itself so a test can
 * hand in a literal without inventing timestamps it does not care about.
 */
export type BudgetedSource = Pick<JobSource, 'id' | 'type'> & {
  config: unknown
  budgetLimit?: number | null
  budgetWindow?: 'DAY' | 'MONTH' | null
  budgetUsed?: number | null
  budgetWindowStartedAt?: Date | null
}

/**
 * Whether a source configured as `mode` may be collected by `trigger`.
 *
 * Exported and pure so the rule is testable on its own: it is the whole of §5,
 * and a mistake here is either a wasted paid quota (scheduled collection of a
 * manual-only source) or a source that never runs at all.
 */
export function sourceAcceptsTrigger(
  mode: JobSourceTriggerMode,
  trigger: JobSourceTriggerMode,
): boolean {
  if (mode === 'BOTH') return true
  return mode === trigger
}

@Injectable()
export class JobSourcingService {
  private readonly logger = new Logger(JobSourcingService.name)
  private readonly providers: Map<JobSourceType, JobSourceProvider>

  constructor(
    private readonly db: DatabaseService,
    private readonly hrAccess: HrAccessService,
    dou: DouRssProvider,
    @Optional() private readonly config?: ConfigService<Env, true>,
  ) {
    // Provider registry — slice 2 adds its source here and nothing else in this
    // service changes.
    this.providers = new Map<JobSourceType, JobSourceProvider>([[dou.type, dou]])
  }

  /**
   * The collapse threshold (task-vacancy-matching AC4) — a SETTING, read
   * through ConfigService, never a constant in this file.
   *
   * `@Optional()` on the injection is for the unit/integration specs that build
   * this service by hand; the fallback is the SAME constant the env schema
   * defaults to, so "no ConfigService" and "no env var" cannot mean two
   * different thresholds. The env value itself is already range-validated at
   * boot (0..1, blank → default), so nothing unvalidated reaches here.
   */
  private matchThreshold(): number {
    return this.config?.get('JOB_MATCH_THRESHOLD', { infer: true }) ?? DEFAULT_JOB_MATCH_THRESHOLD
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
      // Code review round 3: this used to read "seniorId обязателен", which is
      // an API-shape complaint aimed at a developer. The people who actually
      // hit it are an ADMIN or HR whose board has no senior selected yet.
      throw new BadRequestException(
        'Выберите синьора, для которого подбираются вакансии — на канбане пока не выбран ни один',
      )
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

  /**
   * Source configuration and spending — ADMIN only.
   *
   * Security review MED-1: `listSources`/`collectAll` used to be guarded ONLY by
   * the controller's `@Roles('ADMIN')` decorator, unlike every other route here,
   * which re-checks in the service body. That is the exact shape the #157/#158
   * lesson is about — the decorator is one edit away from being dropped, and
   * these two endpoints expose which sources exist plus a button that SPENDS a
   * paid quota. Now the guarantee survives losing the decorator, and a test
   * pins both halves.
   */
  private assertCanManageSources(user: SessionUser): void {
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Источники подбора вакансий настраивает ADMIN')
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

    if (row.seniorId === null) {
      this.assertCanManageGlobal(user)
    } else {
      // IDOR guard — security-review round 2, HIGH-2.
      //
      // `assertCanAccessSenior` RESOLVES the effective senior; for a SENIOR it
      // unconditionally returns `user.id` without looking at the argument at
      // all. Calling it and DISCARDING the result therefore checked nothing for
      // that role: any senior could delete any other senior's exclusion by id,
      // silently re-opening a company their colleague had deliberately shut
      // out. The returned value MUST be compared with the row's owner — the
      // same shape `updateStatus` already uses below.
      const effectiveSeniorId = await this.assertCanAccessSenior(user, row.seniorId)
      if (effectiveSeniorId !== row.seniorId) {
        throw new ForbiddenException('Нет доступа к этому исключению')
      }
    }

    await this.db.db.delete(jobExclusionFilters).where(eq(jobExclusionFilters.id, id))
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  /**
   * The senior's stack — task-vacancy-matching §1.
   *
   * SOURCE: the skills already stored on their resume (`senior_resumes.content`,
   * task-resume-base). Chosen over a second, dedicated "matching keywords" field
   * for the reason `deriveProjectExclusions` gives one level up: a stored COPY
   * of something the CRM already knows drifts, and it drifts SILENTLY — HR
   * updates the resume, matching keeps ranking on last quarter's stack, and
   * nothing anywhere says so. One list, one place to edit it, no sync.
   *
   * NOT EVERY SENIOR HAS ONE. Measured before choosing, not assumed: at the time
   * of writing 0 of 4 active seniors had a resume row at all. So an empty stack
   * is a FIRST-CLASS case, not an edge case — see `listSuggestions`, where it
   * disables ranking rather than scoring every vacancy zero and hiding the lot.
   */
  async getSeniorStack(seniorId: string): Promise<string[]> {
    const row = await this.db.db
      .select({ content: seniorResumes.content })
      .from(seniorResumes)
      .where(eq(seniorResumes.userId, seniorId))
      .limit(1)
      .then((r) => r[0])

    // `content` is jsonb — typed as the resume shape by Drizzle, but the ROW is
    // whatever is in the database, so the skills array is treated as unknown
    // until proven otherwise rather than trusted into the matcher.
    const skills: unknown = (row?.content as { skills?: unknown } | undefined)?.skills
    if (!Array.isArray(skills)) return []
    return canonicalStackKeywords(skills.filter((s): s is string => typeof s === 'string'))
  }

  private mapSuggestion(
    row: SuggestionRow,
    match: { score: number | null; matched: string[] } = { score: null, matched: [] },
  ): JobSuggestionDto {
    return {
      id: row.id,
      seniorId: row.seniorId,
      status: row.status,
      statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
      statusChangedByName: row.statusChangedByName,
      createdAt: row.createdAt.toISOString(),
      matchScore: match.score,
      matchedKeywords: match.matched,
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
   * The senior's queue: NEW suggestions, RANKED BY STACK MATCH, with the CURRENT
   * exclusion set applied on read.
   *
   * Filtering happens at collection time too, but re-applying it here is what
   * makes a filter added AFTER collection take effect immediately — otherwise a
   * senior who just excluded their employer would keep being shown that
   * employer until the next cron run. The same argument applies to the ranking:
   * it is computed on READ, so editing the resume re-ranks the queue at once
   * instead of at the next collection.
   *
   * TWO LISTS, NEVER A SILENT DROP (task-vacancy-matching §3)
   * --------------------------------------------------------
   * The owner asked for less noise, which is right — but "hidden" and "deleted"
   * must not become the same thing: a suggestion nobody can see is a suggestion
   * nobody reviewed. So everything below the threshold goes to `lowMatch` with
   * an honest `lowMatchCount`, the UI collapses it behind one counter, and one
   * click brings it back. Nothing is discarded, and HR can always audit what the
   * ranking decided to demote.
   *
   * NO STACK → NO RANKING
   * ---------------------
   * A senior with no resume skills gets `matchScore: null` on every row and the
   * original freshness order, NOT a queue of zeroes — scoring everything 0 and
   * then collapsing below the threshold would empty the feature's own screen for
   * exactly the people it has not been configured for yet.
   */
  async listSuggestions(
    requestedSeniorId: string | undefined,
    user: SessionUser,
  ): Promise<JobSuggestionListDto> {
    const seniorId = await this.assertCanAccessSenior(user, requestedSeniorId)
    const [exclusions, stackKeywords] = await Promise.all([
      this.buildExclusionSet(seniorId),
      this.getSeniorStack(seniorId),
    ])

    // PASS 1 — the cheap projection (MED-3).
    //
    // Everything the EXCLUSION rules and the honest `total` need, and nothing
    // else. `description_md` is deliberately absent: it is the big column (up to
    // ~20 KB a row) and pulling it for a couple of thousand rows to then discard
    // all but twenty is both the transfer cost and the scoring cost this pass
    // exists to avoid.
    const candidates = await this.db.db
      .select({
        id: jobSuggestions.id,
        companyName: jobPostings.companyName,
        title: jobPostings.title,
        url: jobPostings.url,
        sourceType: jobPostings.sourceType,
      })
      .from(jobSuggestions)
      .innerJoin(jobPostings, eq(jobSuggestions.postingId, jobPostings.id))
      .where(and(eq(jobSuggestions.seniorId, seniorId), eq(jobSuggestions.status, 'NEW')))
      // Freshness order is still the base ordering — it decides ties within the
      // same score, and it is the WHOLE ordering when there is no stack.
      .orderBy(desc(jobPostings.publishedAt), desc(jobPostings.collectedAt))

    const visible = candidates.filter((row) => findMatchingExclusion(row, exclusions) === null)
    const threshold = this.matchThreshold()
    // Exact, because pass 1 saw every row.
    const total = visible.length

    if (visible.length === 0) {
      return { items: [], lowMatch: [], lowMatchCount: 0, total, threshold, stackKeywords }
    }

    // PASS 2 — full rows, for the bounded set we might actually show.
    // Unranked queues need only one page; ranked queues need the window.
    const wanted = stackKeywords.length === 0 ? SUGGESTIONS_PAGE_SIZE : SUGGESTION_RANKING_WINDOW
    const rows = await this.loadSuggestionRows(visible.slice(0, wanted).map((r) => r.id))

    if (stackKeywords.length === 0) {
      return {
        items: rows.slice(0, SUGGESTIONS_PAGE_SIZE).map((row) => this.mapSuggestion(row)),
        lowMatch: [],
        lowMatchCount: 0,
        total,
        threshold,
        stackKeywords: [],
      }
    }

    const scored = rows.map((row) => {
      const match = stackMatchScore(
        { title: row.posting.title, body: row.posting.descriptionMd },
        stackKeywords,
      )
      return { row, score: match.score, matched: match.matched }
    })

    // Sort by score, keeping the freshness order inside a score band. `sort` is
    // stable in every engine we run on (ES2019+), so the ORDER BY above survives
    // as the tiebreak instead of being re-derived here.
    const ranked = [...scored].sort((a, b) => b.score - a.score)

    const above = ranked.filter((entry) => entry.score >= threshold)
    const below = ranked.filter((entry) => entry.score < threshold)

    const toDto = (entry: (typeof ranked)[number]) =>
      this.mapSuggestion(entry.row, { score: entry.score, matched: entry.matched })

    return {
      items: above.slice(0, SUGGESTIONS_PAGE_SIZE).map(toDto),
      lowMatch: below.slice(0, SUGGESTIONS_PAGE_SIZE).map(toDto),
      // The COUNT is the full number of DEMOTED suggestions, not the page — the
      // counter must not under-report what the threshold collapsed just because
      // the array is capped. Suggestions beyond the ranking window are not
      // counted here because they were not judged at all; they remain in `total`,
      // which the dialog shows as «Осталось: N», so nothing disappears silently.
      lowMatchCount: below.length,
      total,
      threshold,
      stackKeywords,
    }
  }

  /** Full suggestion rows (description included) for an explicit id list. */
  private async loadSuggestionRows(ids: string[]): Promise<SuggestionRow[]> {
    if (ids.length === 0) return []
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
      .where(inArray(jobSuggestions.id, ids))
      .orderBy(desc(jobPostings.publishedAt), desc(jobPostings.collectedAt))
    return rows
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
  ): Promise<{ created: JobPosting[]; duplicates: number; invalid: number }> {
    const created: JobPosting[] = []
    let duplicates = 0
    let invalid = 0

    for (const posting of postings) {
      // Security-review round 2, MED-2: per-row isolation. A single row the
      // database refuses (a NUL byte that slipped past normalization, an
      // over-long value, anything we did not anticipate in a THIRD PARTY's
      // payload) used to abort the whole run and silently lose every posting
      // after it. Now it costs exactly that one row, loudly logged.
      try {
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
      } catch (err: unknown) {
        invalid += 1
        this.logger.warn(
          `Skipping unstorable posting ${posting.url}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    return { created, duplicates, invalid }
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

  /** Budget state of a source row, in the shape the shared arithmetic wants. */
  private budgetStateOf(source: BudgetedSource): SourceBudgetState {
    return {
      limit: source.budgetLimit ?? null,
      window: source.budgetWindow ?? null,
      used: source.budgetUsed ?? 0,
      windowStartedAt: source.budgetWindowStartedAt ?? null,
    }
  }

  /**
   * Charge one request to a source's budget, or refuse.
   *
   * Called BEFORE the provider is asked for anything — the point of a budget is
   * that an exhausted source costs ZERO requests, not one more. Because the
   * charge happens here, it applies identically to the cron and to an admin
   * pressing the button: twenty clicks in a row spend twenty units and then stop
   * (AC6), rather than twenty clicks burning a month of JSearch's allowance.
   *
   * The counter is written with a CONDITIONAL update guarded by the FULL state
   * it was read at (both the count AND the window it belongs to — see the
   * window-pinning note below), so two runs racing each other cannot both
   * spend the same last unit: the loser's WHERE matches nothing and it is
   * refused.
   *
   * WINDOW-RESET BOUNDARY (backlog #53) — why this retries instead of refusing
   * on the first lost compare-and-set
   * -----------------------------------------------------------------------
   * `resolveBudget` above already accounts for a window rollover correctly
   * (it derives the window from `now`, not from the stale row), so two
   * callers who both read the row a moment before its window reset BOTH
   * correctly conclude "not exhausted". But a CAS keyed on `budgetUsed` alone
   * still compares against the SAME stale, pre-rollover value — only the
   * first write can match it. The second is not actually out of budget; it
   * lost a compare against a number that was about to be discarded anyway.
   * Refusing it there is a FALSE negative, and this repo's rule for a limiter
   * fed input it cannot fully trust (backlog #48) is "become stricter, never
   * looser" — a false refusal is not the stricter reading, it is simply the
   * wrong one for a caller who genuinely has quota.
   *
   * The fix: on a lost CAS, RE-READ the row and retry against its actual
   * current state, bounded by `CHARGE_BUDGET_MAX_ATTEMPTS`. Two outcomes:
   *   - the row had already rolled over and someone else's write landed first
   *     (the boundary case above) — the retry sees the fresh counter and, if
   *     there is remaining room, writes its own increment on top of it;
   *   - the row is genuinely at its limit — the retry sees `exhausted: true`
   *     and throws exactly as before. The conservative direction is
   *     unchanged; only the false trigger is removed.
   * Attempts exhausted under real contention still refuse — a gate that keeps
   * retrying forever under load is its own failure mode.
   *
   * WHY THE CAS ALSO PINS `budgetWindowStartedAt`, NOT JUST `budgetUsed`
   * -----------------------------------------------------------------------
   * `budgetLimit` does not change across a rollover, so "the OLD window was
   * fully spent" and "the NEW window is ALSO fully spent" are, numerically,
   * the exact same `budgetUsed` value (both equal `budgetLimit`). A CAS keyed
   * on the count alone can therefore be fooled: a caller holding a snapshot
   * from BEFORE the rollover could, by this coincidence, match a row that has
   * since been rolled over AND fully re-spent — and overwrite it, which is a
   * real overspend, not a false refusal. Pinning `budgetWindowStartedAt` in
   * the SAME predicate closes that: a stale caller's remembered window start
   * can only equal the row's CURRENT one when nobody has rolled it over yet,
   * which is exactly the case where reusing the stale count is still correct.
   */
  private async chargeBudget(source: BudgetedSource, now: Date = new Date()): Promise<void> {
    let current: BudgetedSource = source

    for (let attempt = 1; attempt <= CHARGE_BUDGET_MAX_ATTEMPTS; attempt += 1) {
      const state = this.budgetStateOf(current)
      const budget = resolveBudget(state, now)
      if (!budget.limited) return

      if (budget.exhausted) {
        throw new JobSourceBudgetExhaustedError(current.type, budget.limit ?? 0, budget.resetsAt)
      }

      const next = spendBudget(state, now)
      if (!next) return

      const currentWindowStartedAt = current.budgetWindowStartedAt ?? null
      const updated = await this.db.db
        .update(jobSources)
        .set({
          budgetUsed: next.used,
          budgetWindowStartedAt: next.windowStartedAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(jobSources.id, current.id),
            // Compare-and-set on the FULL state we based the decision on —
            // both fields, see the doc block above for why the count alone
            // is not enough.
            eq(jobSources.budgetUsed, current.budgetUsed ?? 0),
            currentWindowStartedAt === null
              ? isNull(jobSources.budgetWindowStartedAt)
              : eq(jobSources.budgetWindowStartedAt, currentWindowStartedAt),
          ),
        )
        .returning({ id: jobSources.id })

      if (updated.length > 0) return

      // Lost the compare-and-set — re-read the row and let the next iteration
      // reason about its REAL current state (see the boundary note above).
      const fresh = await this.db.db
        .select()
        .from(jobSources)
        .where(eq(jobSources.id, current.id))
        .limit(1)
        .then((rows) => rows[0])
      if (!fresh) {
        // The source was deleted mid-run — nothing left to charge or refuse.
        return
      }
      current = fresh
    }

    // Contention outlived the retry budget. Refuse — the same conservative
    // outcome a single lost CAS used to mean before this fix.
    const state = this.budgetStateOf(current)
    const budget = resolveBudget(state, now)
    throw new JobSourceBudgetExhaustedError(current.type, budget.limit ?? 0, budget.resetsAt)
  }

  /** Run one configured source end to end. */
  async collectSource(source: BudgetedSource): Promise<JobCollectionResultDto> {
    const provider = this.providers.get(source.type)
    if (!provider) throw new BadRequestException(`Нет провайдера для источника ${source.type}`)

    // Budget FIRST — before the provider, before the network. A source that has
    // run out refuses to go and fetch data (§4), loudly, instead of quietly
    // returning nothing and looking like a quiet day.
    await this.chargeBudget(source)

    const config = (source.config ?? {}) as Record<string, unknown>
    const postings = await provider.collect(config)

    // Security/code review round 3: a source that changed its format (or
    // started serving an error page with a 200) yields ZERO postings while
    // every call still "succeeds". Marking that run as collected made a BROKEN
    // SOURCE indistinguishable from a quiet day — the senior just sees "no new
    // vacancies" forever and nobody is paged. An empty result is therefore an
    // ERROR, not a result: `lastCollectedAt` is left untouched (so the staleness
    // is visible in the data) and collectAll logs it as a failed source.
    if (postings.length === 0) {
      throw new Error(
        `Source ${source.type} returned 0 usable postings — feed format changed, ` +
          'source is down, or every entry was rejected. lastCollectedAt left unchanged.',
      )
    }

    const { created, duplicates, invalid } = await this.persistPostings(source.id, postings)
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
      invalid,
      suggestionsCreated,
    }
  }

  /**
   * Run every enabled source that the given trigger is allowed to run. One
   * failing source is logged and skipped — a third-party outage must not stop
   * the others (or, when called from the cron, kill the scheduler).
   *
   * `trigger` is what makes §5 real: the cron passes `SCHEDULED` and never
   * touches a manual-only source (JSearch's ~6 requests a day would be spent by
   * the scheduler on nobody's behalf), while the admin button passes `MANUAL`.
   * A source set to `BOTH` answers to either.
   */
  /**
   * The MANUAL path, as a human triggers it — ADMIN only (MED-1).
   *
   * A separate entry point rather than an optional `actor` argument on
   * `collectAll`: an optional caller identity is a check you can forget to pass,
   * and this is the path that spends money. The cron keeps calling `collectAll`
   * directly with no actor, which is honest — it IS the system, not a user.
   */
  async collectAllAsActor(actor: SessionUser): Promise<JobCollectionRunDto> {
    this.assertCanManageSources(actor)
    return this.collectAll('MANUAL')
  }

  async collectAll(trigger: JobSourceTriggerMode = 'SCHEDULED'): Promise<JobCollectionRunDto> {
    const all = await this.db.db.select().from(jobSources).where(eq(jobSources.enabled, true))
    const sources = all.filter((source) => sourceAcceptsTrigger(source.triggerMode, trigger))

    const results: JobCollectionResultDto[] = []
    const failures: JobCollectionFailureDto[] = []

    for (const source of sources) {
      try {
        results.push(await this.collectSource(source))
      } catch (err: unknown) {
        // Sanitized + capped BEFORE it can reach the response schema — a raw
        // library message is both too long for the wire contract (turning this
        // very report into a 400) and, for a database error, a dump of the
        // statement and its parameters. See safe-failure-message.ts.
        const message = toSafeFailureMessage(err)
        // RETURNED, not just logged (code review round 4). Swallowing the error
        // here is right for the cron — one dead third party must not stop the
        // others — but the caller still has to be able to SEE it. The manual
        // ADMIN trigger answered `200 []` for a broken source, i.e. exactly what
        // a quiet day looks like: the same "breakage disguised as silence"
        // defect that was fixed inside collectSource, surfacing one level up.
        //
        // A budget stop is flagged so the UI can tell the two apart: "we chose
        // to stop, it comes back on the 1st" is not an incident, and dressing it
        // up as one trains the operator to ignore real incidents.
        const budgetExhausted = err instanceof JobSourceBudgetExhaustedError
        failures.push({ sourceType: source.type, message, budgetExhausted })
        if (budgetExhausted) {
          this.logger.warn(`Job collection skipped for source ${source.type}: ${message}`)
          continue
        }
        this.logger.error(
          `Job collection failed for source ${source.type} (${source.id})`,
          err instanceof Error ? err.stack : String(err),
        )
      }
    }
    return { results, failures }
  }

  /**
   * Drop postings older than `POSTING_RETENTION_DAYS` that no senior has
   * ANSWERED. Without this the table only ever grows: the feed adds ~25 rows a
   * day forever, and a stale ad is worse than no ad.
   *
   * A posting is kept when any senior applied to it (their application history)
   * OR rejected it (deleting that row would let the vacancy be re-collected and
   * re-offered — see the AC4 note on the query below). Only postings nobody
   * ever decided on are dropped.
   */
  async purgeStalePostings(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - POSTING_RETENTION_DAYS * 24 * 60 * 60 * 1000)

    // Code review round 3 — AC4 hole. This used to keep only APPLIED postings.
    // A REJECTED suggestion cascades away with its posting (`ON DELETE
    // CASCADE`), so after 90 days the vacancy could be collected again, find no
    // suggestion row, and be offered to the same senior a second time — the
    // exact "уже отклонённое не показывать повторно" promise, broken by the
    // retention job rather than by the filter. Anything the senior has ANSWERED
    // (applied or rejected) is a decision we must not forget.
    const decidedPostingIds = await this.db.db
      .selectDistinct({ postingId: jobSuggestions.postingId })
      .from(jobSuggestions)
      .where(inArray(jobSuggestions.status, ['APPLIED', 'REJECTED']))

    const keep = decidedPostingIds.map((r) => r.postingId)
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

  /**
   * Configured sources with their CURRENT budget position — task-vacancy-matching
   * AC7 ("остаток виден в интерфейсе").
   *
   * The remainder is computed here rather than read raw off the row, so a window
   * that has rolled over reports a full allowance immediately instead of showing
   * last month's spend until the next collection happens to reset it.
   */
  async listSources(actor: SessionUser, now: Date = new Date()): Promise<JobSourceDto[]> {
    this.assertCanManageSources(actor)
    const rows = await this.db.db.select().from(jobSources)
    return rows.map((row) => {
      const budget = resolveBudget(this.budgetStateOf(row), now)
      return {
        id: row.id,
        type: row.type,
        enabled: row.enabled,
        triggerMode: row.triggerMode,
        lastCollectedAt: row.lastCollectedAt?.toISOString() ?? null,
        budget: {
          // Stated, not inferred by the client (MED-4).
          state: budgetState(budget),
          limit: budget.limited ? (budget.limit ?? null) : null,
          window: budget.window,
          used: budget.used,
          remaining: budget.remaining,
          resetsAt: budget.resetsAt?.toISOString() ?? null,
        },
      }
    })
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
