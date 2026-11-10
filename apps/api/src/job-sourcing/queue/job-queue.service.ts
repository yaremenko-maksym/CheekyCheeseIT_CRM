import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  DESCRIPTION_MD_MAX,
  JOB_QUEUE_ROW_KEYWORDS_MAX,
  type JobQueueCardResponseDto,
  jobQueueCardResponseSchema,
  type JobQueueListItemDto,
  type JobQueueListQuery,
  type JobQueueListResponseDto,
  jobQueueListResponseSchema,
  type JobQueueNoMatchReason,
  type JobQueueScopeQuery,
  JOB_QUEUE_SENIOR_OPTIONS_MAX,
  type JobQueueSeniorOptionsResponseDto,
  jobQueueSeniorsContinuationSchema,
  jobQueueSourcesContinuationSchema,
  type JobSourceType,
  MAX_STACK_KEYWORD_CHARS,
  MAX_STACK_KEYWORDS,
  type SessionUser,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import { apiError } from '../../common/api-error'
import type { Env } from '../../config/env'
import { DatabaseService } from '../../database/database.service'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  assertCursorCurrent,
  parseCursor,
  refreshRequired,
  requestSignature,
  signCursor,
} from './queue-cursor'
import { currentGeneration, GENERATION_POLICY, generationById } from './queue-generation'
import {
  cardRow,
  duplicateRows,
  filterIdentity,
  listFilters,
  policySignature,
  queueRowColumns,
  queueRowJoins,
  seniorOptionRows,
  seniorRows,
  seniorTotal,
  sourceRows,
  sourceTotal,
} from './queue-read-sql'
import {
  canonicalUuid,
  isGenerationServable,
  type JobQueueScope,
  listableOpportunityPredicate,
  type LiveSeniorVersion,
} from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/** Wire bounds (`jobQueueCardResponseSchema`): the previews are this long, then continue. */
export const SENIOR_PREVIEW_MAX = 200
export const SOURCE_PREVIEW_MAX = 20
const DUPLICATE_PREVIEW_MAX = 5

type Row = Record<string, unknown>
type SeniorsPage = z.infer<typeof jobQueueSeniorsContinuationSchema>
type SourcesPage = z.infer<typeof jobQueueSourcesContinuationSchema>

/** A fresh object per call: a shared one could be mutated by one caller and leak to the next. */
const emptyList = (): JobQueueListResponseDto => ({
  items: [],
  nextCursor: null,
  counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
  generation: null,
})

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString()
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v))
const clipped = (v: unknown, max: number): string | null =>
  v == null ? null : String(v).slice(0, max)

/** `count(*)` arrives as text from the driver. */
const count = (v: unknown): number => Number(v)

export function toListItem(r: Row): JobQueueListItemDto {
  return {
    opportunityId: String(r['id']),
    revision: Number(r['revision']),
    title: String(r['title']).slice(0, 500),
    companyName: clipped(r['employer_name'], 255),
    location: clipped(r['location'], 500),
    // A manual card (r5 Phase 6) is the only row without a source record.
    primarySource:
      r['source_record_id'] == null
        ? null
        : {
            sourceRecordId: String(r['source_record_id']),
            sourceType: r['source_type'] as JobSourceType,
            url: String(r['source_url']),
          },
    applicationUrl: r['application_url'] == null ? null : String(r['application_url']),
    alsoSeenOnCount: Math.max(count(r['source_total']) - 1, 0),
    availability: r['availability'] as JobQueueListItemDto['availability'],
    eligibility: r['eligibility'] as JobQueueListItemDto['eligibility'],
    seniority: r['seniority'] as JobQueueListItemDto['seniority'],
    matchedKeywords: rowKeywords(r['matched_evidence']),
    matchedSeniorCount: count(r['matched']),
    submittedSeniorCount: count(r['submitted']),
    stopListedSeniorCount: count(r['stop_listed']),
    openedByTeam: r['opened'] === true,
    hidden: r['hidden'] === true,
    publishedAt: isoOrNull(r['published_at']),
    firstSeenAt: iso(r['first_seen_at']),
  }
}

/**
 * The keywords of a senior's own `TECH_MATCH` reason (`keyword:STRENGTH`). A match is approximate
 * unless it holds a CORE keyword: a TRIAGE row has none, an OPTIONAL-only one is a weak signal.
 */
export function matchFacts(evidence: unknown): { keywords: string[]; approximate: boolean } {
  const items = techMatchItems(evidence)
  return {
    // No `:STRENGTH` suffix: the whole string is the keyword.
    keywords: items
      .map((k) => (k.includes(':') ? k.slice(0, k.lastIndexOf(':')) : k))
      // `":CORE"` names no keyword: it would render as an empty chip.
      .filter((k) => k !== '')
      .slice(0, 200),
    approximate: !items.some((k) => k.endsWith(':CORE')),
  }
}

/** The raw `keyword:STRENGTH` items of a senior's own `TECH_MATCH` reasons. */
function techMatchItems(evidence: unknown): string[] {
  const reasons = (evidence as { reasons?: unknown } | null)?.reasons
  return Array.isArray(reasons)
    ? reasons
        .filter((r: { code?: unknown }) => r?.code === 'TECH_MATCH')
        .flatMap((r: { evidence?: unknown }) => (Array.isArray(r.evidence) ? r.evidence : []))
        .map(String)
    : []
}

const EVIDENCE_ITEM = /^(.+):(CORE|OPTIONAL)$/

/**
 * «Чому збіг» (Task 7.3b, design §5.2): each matched keyword with its weight in the vacancy stack.
 * An item without a known strength says nothing about why it matched, so it is left out.
 */
export function matchEvidence(
  evidence: unknown,
): Array<{ keyword: string; strength: 'CORE' | 'OPTIONAL' }> {
  return techMatchItems(evidence)
    .flatMap((item) => {
      const m = EVIDENCE_ITEM.exec(item)
      return m === null
        ? []
        : [
            {
              keyword: (m[1] as string).slice(0, MAX_STACK_KEYWORD_CHARS),
              strength: m[2] as 'CORE' | 'OPTIONAL',
            },
          ]
    })
    .slice(0, 200)
}

/**
 * Why a card has no matched senior (Task 7.3b, design §5.4–5.5). A stop-list wins; a manual card
 * was placed by a person, so nobody matching is a zero match; anything else unmatched reached the
 * viewer through triage (grant, subscription or studio triage). Unknown-stack versus known-but-
 * unmatched is not persisted for a team or studio view, so those stay TRIAGE.
 */
export function noMatchReason(r: Row): JobQueueNoMatchReason | null {
  if (count(r['matched']) > 0) return null
  if (count(r['stop_listed']) > 0) return 'STOP_LISTED'
  return r['manual_team_id'] == null ? 'TRIAGE' : 'NO_MATCH'
}

/** The union over the scope's LEAD seniors, never attributed. Sorted: the cap keeps a stable set. */
function rowKeywords(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return []
  const keywords = evidence.flatMap((e) =>
    matchFacts(e).keywords.map((k) => k.slice(0, MAX_STACK_KEYWORD_CHARS)),
  )
  // Case-insensitive, so `aws` is not dropped after every capitalised keyword at the cap (UX-LOW-1);
  // the code-unit sort first makes ties (`React`/`react`) come out in one order: the second sort is stable.
  return [...new Set(keywords)]
    .sort()
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .slice(0, JOB_QUEUE_ROW_KEYWORDS_MAX)
}

/**
 * The card's `submission`, from the SQL that never selects a foreign row's columns (`seniorRows`):
 * own row in full; another team's LIVE submission of this shared senior is the bare marker (owner A3
 * option (a)); a cancelled foreign one is indistinguishable from none.
 */
export function toSubmission(r: Row): SeniorsPage['items'][number]['submission'] {
  if (r['submission_id'] != null) {
    return {
      id: String(r['submission_id']),
      opportunityId: String(r['opportunity_id']),
      seniorId: String(r['senior_id']),
      state: r['submission_state'] as 'TAKEN' | 'RELEASED',
      submittedAt: iso(r['taken_at']),
      cancelledAt: isoOrNull(r['released_at']),
      version: Number(r['submission_version']),
      submittedByName: clipped(r['submitted_by_name'], 255),
    }
  }
  return r['submitted_elsewhere'] === true ? { submittedElsewhere: true } : null
}

/** The ADMIN team heading is read for the STUDIO scope only; a TEAM scope never carries the key. */
const toSenior =
  (scope: JobQueueScope) =>
  (r: Row): SeniorsPage['items'][number] => {
    const facts = matchFacts(r['evidence'])
    return {
      seniorId: String(r['senior_id']),
      displayName: String(r['display_name']).slice(0, 255),
      matchApproximate: facts.approximate,
      matchedKeywords: facts.keywords,
      matchEvidence: matchEvidence(r['evidence']),
      submission: toSubmission(r),
      ...(scope.kind === 'STUDIO'
        ? {
            team:
              r['team_id'] == null
                ? null
                : { teamId: String(r['team_id']), teamName: String(r['team_name']).slice(0, 255) },
          }
        : {}),
    }
  }

const toSource = (r: Row): SourcesPage['items'][number] => ({
  sourceRecordId: String(r['source_record_id']),
  sourceType: r['source_type'] as SourcesPage['items'][number]['sourceType'],
  url: String(r['source_url']),
  linkedAt: iso(r['linked_at']),
})

/**
 * r5 Task 6.2 — the queue's list and card. Every public method resolves the scope for THIS request
 * (never cached, SR-L-2), so RBAC holds here and not only on the Task 6.4 controller decorator.
 * Visibility comes only from `queue-scope.ts`; `queue-read-sql.ts` documents how each field is scoped.
 *
 * Counts deliberately differ from a full recount: they are the entries of the served generation that
 * are STILL authorized, in their CURRENT workflow state (so a submission or a revoked grant shows at
 * once), and an opportunity that first appeared after the generation counts only from the next one,
 * just as it pages only from then. They are not narrowed by filters.
 */
@Injectable()
export class JobQueueService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueueScopeService) private readonly scopes: JobQueueScopeService,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {}

  /** Optional only for the module-wiring specs, as in the crons: with no key, no cursor is issued or honoured. */
  private get secret(): string {
    const secret = this.config?.get('SESSION_SECRET', { infer: true })
    if (!secret) throw apiError('JOB_QUEUE_POLICY_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE)
    return secret
  }

  async list(user: SessionUser, query: JobQueueListQuery): Promise<JobQueueListResponseDto> {
    const scope = await this.scopes.resolve(user, query.teamId, this.database.db)
    // Checked before any data SQL, and answered the same for a NONE scope.
    const cursor = query.cursor === undefined ? null : parseCursor(query.cursor, 'L', this.secret)
    if (scope.kind === 'NONE') return emptyList()
    const versions = await this.scopes.liveVersions(scope, this.database.db)
    const policy = policySignature(scope, versions)
    const signature = requestSignature([user.id, policy, ...filterIdentity(query)])
    const now = new Date()
    if (cursor !== null) assertCursorCurrent(cursor, signature, now)

    // Publishing writes, so it stays outside the read snapshot below.
    const generationId =
      cursor?.g ??
      (
        await this.scopes.policy(() =>
          currentGeneration(this.database, scope, versions, policy, now),
        )
      ).id
    // One snapshot: a publish that commits between these statements purges the generation for the
    // next request, never halfway through this one (a 200 with an empty page and zero counts).
    const read = await this.scopes.policy(() =>
      this.database.db.transaction(
        (tx) => readPage(tx, scope, versions, generationId, query, cursor?.k ?? -1, now),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    )
    // A generation superseded, expired or purged since it was chosen, or never this scope's.
    if (read === null) throw refreshRequired()

    const { generation, tally, rows } = read
    const page = rows.slice(0, query.limit)
    return jobQueueListResponseSchema.parse({
      items: page.map(toListItem),
      counts: {
        NEW: count(tally['new']),
        SUBMITTED: count(tally['submitted']),
        HIDDEN: count(tally['hidden']),
      },
      generation: {
        ruleVersion: generation.ruleVersion,
        evaluatedAt: generation.evaluatedAt.toISOString(),
        capped: tally['capped'] === true,
      },
      nextCursor:
        rows.length > query.limit
          ? signCursor(
              {
                t: 'L',
                g: generation.id,
                k: Number((page[page.length - 1] as Row)['order_key']),
                s: signature,
                e: Math.floor(generation.expiresAt.getTime() / 1000),
              },
              this.secret,
            )
          : null,
    })
  }

  /** The latest canonical facts of one visible opportunity. A miss of any kind is the same 404. */
  async card(
    user: SessionUser,
    opportunityId: string,
    query: Pick<JobQueueScopeQuery, 'teamId'> = {},
  ): Promise<JobQueueCardResponseDto> {
    const scope = await this.scopes.resolve(user, query.teamId, this.database.db)
    await this.scopes.assertVisible(scope, opportunityId, this.database.db)
    const id = canonicalUuid(opportunityId) as string
    const versions = await this.scopes.liveVersions(scope, this.database.db)
    const signature = continuationSignature(user, scope, versions, id)
    const facts = await this.scopes.policy(async () => {
      const { rows } = await this.database.db.execute(cardRow(scope, versions, id))
      const row = rows[0]
      if (row === undefined) return null
      return {
        row,
        seniors: await this.seniorsPage(scope, versions, id, signature, undefined),
        sources: await this.sourcesPage(id, signature, undefined),
        possibleDuplicates: await this.duplicates(scope, id),
      }
    })
    // Visible a moment ago, or without any active source link: the same answer as a miss.
    if (facts === null) throw notFound()
    const { row, ...parts } = facts
    return jobQueueCardResponseSchema.parse({
      ...toListItem(row),
      descriptionMd: String(row['description'] ?? '').slice(0, DESCRIPTION_MD_MAX),
      newerThanList: row['newer_than_list'] === true,
      ...parts,
      lastSeenAt: iso(row['last_observed_at']),
      stackKeywords: (Array.isArray(row['stack_keywords']) ? row['stack_keywords'] : [])
        .slice(0, MAX_STACK_KEYWORDS)
        .map((k) => String(k).slice(0, MAX_STACK_KEYWORD_CHARS)),
      noMatchReason: noMatchReason(row),
      dismissal:
        // A NONE scope never gets this far: `resolve` / `assertVisible` refuse it first.
        row['dismissal_version'] == null || scope.kind === 'NONE'
          ? null
          : { scope: scope.kind, version: Number(row['dismissal_version']) },
    })
  }

  /** GET `/job-queue/seniors`: the list filter's picker, only the seniors of the viewer's own scope. */
  async seniorOptions(
    user: SessionUser,
    query: Pick<JobQueueScopeQuery, 'teamId'>,
  ): Promise<JobQueueSeniorOptionsResponseDto> {
    const scope = await this.scopes.resolve(user, query.teamId, this.database.db)
    const versions = await this.scopes.liveVersions(scope, this.database.db)
    if (versions.length === 0) return { items: [] }
    const { rows } = await this.scopes.policy(() =>
      this.database.db.execute(
        seniorOptionRows(
          versions.map((v) => v.seniorId),
          scope.kind === 'TEAM' ? scope.teamId : null,
          JOB_QUEUE_SENIOR_OPTIONS_MAX,
        ),
      ),
    )
    return {
      items: (rows as Row[]).map((row) => ({
        id: String(row['id']),
        name: String(row['display_name']).slice(0, 255),
        teamName: row['team_name'] === null ? null : String(row['team_name']).slice(0, 255),
      })),
    }
  }

  /** GET `/job-queue/:id/seniors`: the viewer's own matched seniors beyond the card's preview. */
  async seniors(
    user: SessionUser,
    opportunityId: string,
    query: JobQueueScopeQuery,
  ): Promise<SeniorsPage> {
    const c = await this.continuation(user, opportunityId, query, 'SEN')
    return jobQueueSeniorsContinuationSchema.parse(
      await this.scopes.policy(() =>
        this.seniorsPage(c.scope, c.versions, c.id, c.signature, c.after),
      ),
    )
  }

  /** GET `/job-queue/:id/sources`: the opportunity's active source links beyond the preview. */
  async sources(
    user: SessionUser,
    opportunityId: string,
    query: JobQueueScopeQuery,
  ): Promise<SourcesPage> {
    const c = await this.continuation(user, opportunityId, query, 'SRC')
    return jobQueueSourcesContinuationSchema.parse(
      await this.scopes.policy(() => this.sourcesPage(c.id, c.signature, c.after)),
    )
  }

  /** Role, then cursor integrity, then visibility, then the cursor's fit: refusals stay in that order. */
  private async continuation(
    user: SessionUser,
    opportunityId: string,
    query: JobQueueScopeQuery,
    kind: 'SRC' | 'SEN',
  ) {
    const scope = await this.scopes.resolve(user, query.teamId, this.database.db)
    const cursor = query.cursor === undefined ? null : parseCursor(query.cursor, kind, this.secret)
    await this.scopes.assertVisible(scope, opportunityId, this.database.db)
    const id = canonicalUuid(opportunityId) as string
    const versions = await this.scopes.liveVersions(scope, this.database.db)
    const signature = continuationSignature(user, scope, versions, id)
    if (cursor !== null) assertCursorCurrent(cursor, signature, new Date())
    return { scope, id, versions, signature, after: cursor?.k }
  }

  private continuationCursor(kind: 'SRC' | 'SEN', id: string, key: string, signature: string) {
    const e = Math.floor((Date.now() + GENERATION_POLICY.ttlMs) / 1000)
    return signCursor({ t: kind, g: id, k: key, s: signature, e }, this.secret)
  }

  private async seniorsPage(
    scope: JobQueueScope,
    versions: readonly LiveSeniorVersion[],
    id: string,
    signature: string,
    after: string | undefined,
  ): Promise<SeniorsPage> {
    const { rows } = await this.database.db.execute(
      seniorRows(scope, versions, id, after, SENIOR_PREVIEW_MAX + 1),
    )
    const total = await this.database.db.execute(seniorTotal(versions, id))
    const page = rows.slice(0, SENIOR_PREVIEW_MAX)
    return {
      items: page.map(toSenior(scope)),
      totalCount: count((total.rows[0] as Row)['total']),
      nextCursor:
        rows.length > SENIOR_PREVIEW_MAX
          ? this.continuationCursor(
              'SEN',
              id,
              String((page[page.length - 1] as Row)['senior_id']),
              signature,
            )
          : null,
    }
  }

  private async sourcesPage(
    id: string,
    signature: string,
    after: string | undefined,
  ): Promise<SourcesPage> {
    const { rows } = await this.database.db.execute(sourceRows(id, after, SOURCE_PREVIEW_MAX + 1))
    const total = await this.database.db.execute(sourceTotal(id))
    const page = rows.slice(0, SOURCE_PREVIEW_MAX)
    return {
      items: page.map(toSource),
      totalCount: count((total.rows[0] as Row)['total']),
      nextCursor:
        rows.length > SOURCE_PREVIEW_MAX
          ? this.continuationCursor(
              'SRC',
              id,
              String((page[page.length - 1] as Row)['source_record_id']),
              signature,
            )
          : null,
    }
  }

  /** Only duplicates THIS scope may see, in the total as well: a foreign copy is no copy. */
  private async duplicates(scope: JobQueueScope, id: string) {
    const { rows } = await this.database.db.execute(duplicateRows(scope, id, DUPLICATE_PREVIEW_MAX))
    const first = rows[0]
    if (first === undefined) return null
    return {
      items: rows.map((r) => ({
        opportunityId: String(r['id']),
        title: String(r['title']).slice(0, 500),
        companyName: clipped(r['employer_name'], 255),
        submittedSeniorNames: (Array.isArray(r['submitted_senior_names'])
          ? r['submitted_senior_names']
          : []
        )
          .slice(0, 200)
          .map((n) => String(n).slice(0, 255)),
      })),
      totalCount: count(first['total']),
    }
  }
}

/** Lookup, counts and page of one list request: run in ONE snapshot. Null: not servable to this scope. */
async function readPage(
  tx: SqlExecutor,
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
  generationId: string,
  query: JobQueueListQuery,
  after: number,
  now: Date,
) {
  const generation = await generationById(tx, generationId)
  if (generation === null || !isGenerationServable(scope, generation, now)) return null
  const frame = sql`FROM job_queue_generation_entries e
                    JOIN job_opportunities o ON o.id = e.opportunity_id
                    ${queueRowJoins(scope, versions)}
                   WHERE e.generation_id = ${generation.id}::uuid
                     AND ${listableOpportunityPredicate(scope, sql`o.id`)}`
  const counts = await tx.execute(
    sql`SELECT count(*) FILTER (WHERE d.tab = 'NEW') AS new,
               count(*) FILTER (WHERE d.tab = 'SUBMITTED') AS submitted,
               count(*) FILTER (WHERE d.tab = 'HIDDEN') AS hidden,
               EXISTS (SELECT 1 FROM job_queue_generation_entries top
                        WHERE top.generation_id = ${generation.id}::uuid
                          AND top.order_key = ${GENERATION_POLICY.maxEntries - 1}) AS capped
        ${frame}`,
  )
  const tally = counts.rows[0] as Row
  // No senior of the scope left in the filter: empty, not an error that would confirm who exists.
  const wanted = query.seniorIds
  if (wanted !== undefined && !versions.some((v) => wanted.includes(v.seniorId))) {
    return { generation, tally, rows: [] as Row[] }
  }
  const { rows } = await tx.execute(
    sql`SELECT ${queueRowColumns(versions)}, e.order_key
        ${frame}
           AND e.order_key > ${after}
           AND ${sql.join(listFilters(query, versions), sql` AND `)}
         ORDER BY e.order_key
         LIMIT ${query.limit + 1}`,
  )
  return { generation, tally, rows: rows as Row[] }
}

const continuationSignature = (
  user: SessionUser,
  scope: JobQueueScope,
  versions: readonly LiveSeniorVersion[],
  opportunityId: string,
): string => requestSignature([user.id, policySignature(scope, versions), opportunityId])

const notFound = () => apiError('JOB_OPPORTUNITY_NOT_FOUND', HttpStatus.NOT_FOUND)
