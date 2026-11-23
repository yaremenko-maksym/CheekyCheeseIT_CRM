import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common'
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
  type JobQueueSalary,
  type JobQueueScopeQuery,
  JOB_QUEUE_SENIOR_OPTIONS_MAX,
  type JobQueueSeniorOptionsResponseDto,
  jobQueueSeniorsContinuationSchema,
  type JobQueueSkillOverlap,
  jobQueueSkillOverlapSchema,
  jobQueueSourcesContinuationSchema,
  type JobSourceType,
  MAX_STACK_KEYWORD_CHARS,
  MAX_STACK_KEYWORDS,
  type SessionUser,
  type SourcingNotice,
} from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { apiError } from '../../common/api-error'
import type { Env } from '../../config/env'
import { DatabaseService } from '../../database/database.service'
import { engagementFormOf } from '../funnel/layer1'
import { readSourcingNotice } from '../sourcing-notice'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  assertCursorCurrent,
  parseCursor,
  refreshRequired,
  requestSignature,
  signCursor,
} from './queue-cursor'
import {
  currentGeneration,
  GENERATION_POLICY,
  type GenerationRow,
  generationById,
  publishedGeneration,
} from './queue-generation'
import {
  cardRow,
  duplicateRows,
  filterIdentity,
  listFilters,
  policySignature,
  queueRowColumns,
  queueRowJoins,
  scopeTeamIds,
  seniorOptionRows,
  seniorRows,
  seniorTotal,
  sourceRows,
  sourceTotal,
  triageGrantableRow,
} from './queue-read-sql'
import {
  canonicalUuid,
  isGenerationServable,
  type JobQueueScope,
  type JobQueueViewScope,
  listableOpportunityPredicate,
  type LiveSeniorVersion,
  STUDIO_SCOPE,
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
const emptyList = (sourcingNotice: SourcingNotice): JobQueueListResponseDto => ({
  items: [],
  nextCursor: null,
  counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
  generation: null,
  sourcingNotice,
})

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString()
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v))
const clipped = (v: unknown, max: number): string | null =>
  v == null ? null : String(v).slice(0, max)

/** `numeric(12,2)` arrives as text from the driver. */
const amountOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

/** `count(*)` arrives as text from the driver. */
const count = (v: unknown): number => Number(v)

export function toListItem(r: Row): JobQueueListItemDto {
  return {
    opportunityId: String(r['id']),
    revision: Number(r['revision']),
    title: String(r['title']).slice(0, 500),
    companyName: clipped(r['employer_name'], 255),
    // Only this one reason is exposed: every other `field_revisions` reason is an internal
    // resolution detail, and the HR UI must not read "the sources disagreed" as "undisclosed".
    ...(r['employer_disclosure_reason'] === 'WITHHELD_AT_SOURCE'
      ? { employerDisclosure: 'WITHHELD_AT_SOURCE' as const }
      : {}),
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
    // A salary without its currency is no salary (the CHECKs keep the four columns together).
    ...(r['salary_currency'] == null
      ? {}
      : {
          salary: {
            min: amountOrNull(r['salary_min']),
            max: amountOrNull(r['salary_max']),
            currency: String(r['salary_currency']),
            period: r['salary_period'] as JobQueueSalary['period'],
          },
        }),
  }
}

/** Malformed stored evidence is a writer/schema disagreement, not a request error: a log, not a 500. */
const evidenceLogger = new Logger('JobQueueEvidence')

/**
 * The keywords of a senior's own `TECH_MATCH` reason (`keyword:STRENGTH`). A match is approximate
 * unless it holds a CORE keyword: a TRIAGE row has none, an OPTIONAL-only one is a weak signal.
 */
export function matchFacts(evidence: unknown): { keywords: string[]; approximate: boolean } {
  // Senior roles PR 4: a role match is exact, and its keywords are the senior's overlapping SKILLS
  // only — `[]` with no resume, a malformed overlap or no overlapping skill (plan 4.5 / 5.4).
  // A matched role is NOT a keyword: `rowKeywords` feeds this into the list row's and the card's
  // `matchedKeywords`, where a role id would render as the vacancy's stack (CR-M-1 / SPEC-M-2).
  // The roles stay in `matchEvidence`, which is the senior evidence block CR-L-1 asked for.
  if (hasReason(evidence, 'ROLE_MATCH')) {
    const overlap = skillOverlapOf(evidence)
    // No cap of its own: `skillOverlapOf` parses, and `jobQueueSkillOverlapSchema` bounds `matched`
    // at 200 already, so an over-long overlap is malformed (`[]`) rather than quietly truncated.
    const matched = overlap?.kind === 'OVERLAP' ? overlap.matched : []
    return { keywords: [...matched], approximate: false }
  }
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

function hasReason(evidence: unknown, code: string): boolean {
  const reasons = (evidence as { reasons?: unknown } | null)?.reasons
  return Array.isArray(reasons) && reasons.some((r: { code?: unknown }) => r?.code === code)
}

/**
 * The senior's own overlap from a LEAD row's evidence; anything malformed is `null`.
 * With `opportunityId` a value that is PRESENT but does not parse is reported once (CR-L-2):
 * nothing else would notice a writer and this schema disagreeing. Only the event, the opportunity
 * and the failing paths are logged — never the stored evidence. A read that does not name the
 * opportunity stays quiet, so one malformed row is one line, not one per reader of it.
 */
export function skillOverlapOf(
  evidence: unknown,
  opportunityId?: string,
): JobQueueSkillOverlap | null {
  const raw = (evidence as { skillOverlap?: unknown } | null)?.skillOverlap
  if (raw === undefined || raw === null) return null
  const parsed = jobQueueSkillOverlapSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  if (opportunityId !== undefined)
    evidenceLogger.warn(
      `job-queue.skill-overlap-malformed opportunityId=${opportunityId} issues=${parsed.error.issues
        .map((i) => (i.path.length === 0 ? '(root)' : i.path.join('.')))
        .join(',')}`,
    )
  return null
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

const ROLE_ITEM = /^ROLE:(.+?)(:WIDENED)?$/

/**
 * The matched roles of a senior's own `ROLE_MATCH` reason (`ROLE:<ROLE>`, `ROLE:<ROLE>:WIDENED` —
 * `evaluate.ts` `projectScope`). An item in any other shape names no role, so it is left out.
 */
function roleItems(evidence: unknown): Array<{ role: string; widened: boolean }> {
  const reasons = (evidence as { reasons?: unknown } | null)?.reasons
  if (!Array.isArray(reasons)) return []
  return reasons
    .filter((r: { code?: unknown }) => r?.code === 'ROLE_MATCH')
    .flatMap((r: { evidence?: unknown }) => (Array.isArray(r.evidence) ? r.evidence : []))
    .map(String)
    .flatMap((item) => {
      const m = ROLE_ITEM.exec(item)
      return m === null
        ? []
        : [
            {
              role: (m[1] as string).slice(0, MAX_STACK_KEYWORD_CHARS),
              widened: m[2] !== undefined,
            },
          ]
    })
}

const EVIDENCE_ITEM = /^(.+):(CORE|OPTIONAL)$/

/**
 * «Чому збіг» (Task 7.3b, design §5.2): each matched keyword with its weight in the vacancy stack.
 * An item without a known strength says nothing about why it matched, so it is left out.
 */
export function matchEvidence(
  evidence: unknown,
): Array<{ keyword: string; strength: 'CORE' | 'OPTIONAL'; kind?: 'ROLE' }> {
  // Senior roles PR 4: a matched role is the reason the senior is here at all, so it comes first.
  // A widened match covers the vacancy's role through its family only — a weaker signal, OPTIONAL.
  // `kind: 'ROLE'` marks `keyword` as a `TechnicalRole` id, so the web renders it through the
  // `technical-role.*` catalog instead of verbatim (CR-M-1 / SPEC-M-2); a skill item omits it.
  const roles = roleItems(evidence).map((r) => ({
    keyword: r.role,
    strength: r.widened ? ('OPTIONAL' as const) : ('CORE' as const),
    kind: 'ROLE' as const,
  }))
  return [
    ...roles,
    ...techMatchItems(evidence).flatMap((item) => {
      const m = EVIDENCE_ITEM.exec(item)
      return m === null
        ? []
        : [
            {
              keyword: (m[1] as string).slice(0, MAX_STACK_KEYWORD_CHARS),
              strength: m[2] as 'CORE' | 'OPTIONAL',
            },
          ]
    }),
  ].slice(0, 200)
}

/**
 * Why a card has no matched senior (Task 7.3b, design §5.4–5.5, SPEC-H-1, CR2-M-1), first that
 * holds: a stop-list; the funnel excluded the vacancy at its current revision (EXCLUDED); an own
 * senior's live TRIAGE row (the stack could not be judged); a manual card (never evaluated, a
 * person placed it: nobody matching is a zero match); an unverified employer or no evaluation at
 * the current revision (TRIAGE); else an OPEN verdict with no own senior's LEAD, TRIAGE or
 * stop-list row (the own seniors' other EXCLUDED rows do exist): NO_MATCH.
 */
export function noMatchReason(r: Row): JobQueueNoMatchReason | null {
  if (count(r['matched']) > 0) return null
  if (count(r['stop_listed']) > 0) return 'STOP_LISTED'
  const current = r['evaluated_current'] === true
  if (current && r['evaluation_verdict'] === 'EXCLUDED') return 'EXCLUDED'
  if (count(r['triaged']) > 0) return 'TRIAGE'
  if (r['manual_team_id'] != null) return 'NO_MATCH'
  const open = current && r['evaluation_verdict'] === 'OPEN'
  return r['employer_verified'] === true && open ? 'NO_MATCH' : 'TRIAGE'
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

/** «Вільно з {d}» / «Зайнято» (§5.2); no row is `null`. The CHECK pairs FREE with its day. */
export function toAvailability(r: Row): SeniorsPage['items'][number]['availability'] {
  if (r['availability_status'] === 'BUSY') return { status: 'BUSY' }
  if (r['availability_status'] === 'FREE' && typeof r['available_from'] === 'string')
    return { status: 'FREE', availableFrom: r['available_from'] }
  return null
}

/** The ADMIN team heading is read for the STUDIO scope only; a TEAM scope never carries the key. */
const toSenior =
  (scope: JobQueueViewScope, opportunityId: string) =>
  (r: Row): SeniorsPage['items'][number] => {
    const facts = matchFacts(r['evidence'])
    return {
      seniorId: String(r['senior_id']),
      displayName: String(r['display_name']).slice(0, 255),
      availability: toAvailability(r),
      // a match row's evidence is NOT NULL: NULL is a manual card's TAKEN-only senior, no match at all
      matchApproximate: r['evidence'] !== null && facts.approximate,
      matchedKeywords: facts.keywords,
      matchEvidence: matchEvidence(r['evidence']),
      skillOverlap: skillOverlapOf(r['evidence'], opportunityId),
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
    const scope = await this.scopes.resolveView(user, query.teamId, this.database.db)
    // Checked before any data SQL, and answered the same for a NONE scope.
    const cursor = query.cursor === undefined ? null : parseCursor(query.cursor, 'L', this.secret)
    // The notice is global state with no team data in it (H.8), so a NONE scope carries it too.
    if (scope.kind === 'NONE') return emptyList(await readSourcingNotice(this.database.db))
    const versions = await this.scopes.liveVersions(scope, this.database.db)
    const policy = policySignature(scope, versions)
    const now = new Date()
    // A union pages its member teams' own generations: their ids are part of the signature, so a
    // cursor dies with any one of them (a member republished, expired or purged).
    const unionGenerations =
      scope.kind === 'TEAMS' ? await this.memberGenerations(scope.teams, cursor === null, now) : []
    const signature = requestSignature([
      user.id,
      policy,
      ...unionGenerations,
      ...filterIdentity(query),
    ])
    if (cursor !== null) assertCursorCurrent(cursor, signature, now)

    // Publishing writes, so it stays outside the read snapshot below.
    const generationIds =
      scope.kind === 'TEAMS'
        ? unionGenerations
        : [
            cursor?.g ??
              (
                await this.scopes.policy(() =>
                  currentGeneration(this.database, scope, versions, policy, now),
                )
              ).id,
          ]
    const members = scope.kind === 'TEAMS' ? scope.teams : [scope]
    // One snapshot: a publish that commits between these statements purges the generation for the
    // next request, never halfway through this one (a 200 with an empty page and zero counts).
    const read = await this.scopes.policy(() =>
      this.database.db.transaction(
        (tx) => readPage(tx, scope, versions, members, generationIds, query, cursor?.k ?? -1, now),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    )
    // A generation superseded, expired or purged since it was chosen, or never this scope's.
    if (read === null) throw refreshRequired()

    const { generation, tally, rows } = read
    const page = rows.slice(0, query.limit)
    const sourcingNotice = await readSourcingNotice(this.database.db)
    return jobQueueListResponseSchema.parse({
      sourcingNotice,
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

  /**
   * A union's member generations, one per team in its order: published on the spot for a first
   * page; for a cursor page only looked up, never published — a member without its servable
   * generation is refresh-required, as a single team's cursor is.
   */
  private async memberGenerations(
    teams: readonly JobQueueScope[],
    publish: boolean,
    now: Date,
  ): Promise<string[]> {
    const ids: string[] = []
    for (const team of teams) {
      const versions = await this.scopes.liveVersions(team, this.database.db)
      const policy = policySignature(team, versions)
      const generation = await this.scopes.policy(() =>
        publish
          ? currentGeneration(this.database, team, versions, policy, now)
          : publishedGeneration(this.database.db, team, policy, now),
      )
      if (generation === null) throw refreshRequired()
      ids.push(generation.id)
    }
    return ids
  }

  /**
   * ADMIN only, in any view scope (SPEC-H-1): what the «Призначити команді…» grant needs. The grant
   * always runs under STUDIO, so both are read for the STUDIO roster even when the ADMIN views one
   * team: the studio-wide policy version it must send back (backlog 425), and whether the grant
   * would accept the item, by the grant's own eligibility fragment (CR-M-1).
   */
  private async triageGrant(
    scope: JobQueueViewScope,
    versions: readonly LiveSeniorVersion[],
    id: string,
    manual: boolean,
  ): Promise<{ triagePolicyVersion: number; triageGrantable: boolean }> {
    const db = this.database.db
    const studio =
      scope.kind === 'STUDIO' ? versions : await this.scopes.liveVersions(STUDIO_SCOPE, db)
    // a manual card is never grantable (the grant's first refusal): its eligibility is not read
    const grantable =
      !manual &&
      (await this.scopes.policy(() => db.execute(triageGrantableRow(studio, id)))).rows[0]?.[
        'grantable'
      ] === true
    return {
      triagePolicyVersion: await this.scopes.triagePolicyVersion(studio, db),
      triageGrantable: grantable,
    }
  }

  /** The latest canonical facts of one visible opportunity. A miss of any kind is the same 404. */
  async card(
    user: SessionUser,
    opportunityId: string,
    query: Pick<JobQueueScopeQuery, 'teamId'> = {},
  ): Promise<JobQueueCardResponseDto> {
    const scope = await this.scopes.resolveView(user, query.teamId, this.database.db)
    await this.scopes.assertVisible(scope, opportunityId, this.database.db)
    const id = canonicalUuid(opportunityId) as string
    const versions = await this.scopes.liveVersions(scope, this.database.db)
    const signature = continuationSignature(user, scope, versions, id)
    // A union carries the dismissal of the one team `dismiss` / `undo` would name.
    const owner =
      scope.kind === 'TEAMS'
        ? await this.scopes.dismissalOwner(scope.teams, id, this.database.db)
        : scope
    const facts = await this.scopes.policy(async () => {
      const { rows } = await this.database.db.execute(cardRow(scope, versions, id, owner))
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
    const triage =
      user.role === 'ADMIN'
        ? await this.triageGrant(scope, versions, id, row['manual_team_id'] != null)
        : {}
    return jobQueueCardResponseSchema.parse({
      ...triage,
      ...toListItem(row),
      descriptionMd: String(row['description'] ?? '').slice(0, DESCRIPTION_MD_MAX),
      newerThanList: row['newer_than_list'] === true,
      ...parts,
      lastSeenAt: iso(row['last_observed_at']),
      // each token once: the card keys its chips by the keyword
      stackKeywords: [
        ...new Set(
          (Array.isArray(row['stack_keywords']) ? row['stack_keywords'] : []).map((k) =>
            String(k).slice(0, MAX_STACK_KEYWORD_CHARS),
          ),
        ),
      ].slice(0, MAX_STACK_KEYWORDS),
      noMatchReason: noMatchReason(row),
      // `->>` yields text or NULL; the function owns the null case
      engagementForm: engagementFormOf(row['employment_type'] as string | null),
      dismissal:
        // A NONE scope never gets this far: `resolve` / `assertVisible` refuse it first.
        row['dismissal_version'] == null || owner.kind === 'NONE'
          ? null
          : { scope: owner.kind, version: Number(row['dismissal_version']) },
    })
  }

  /** GET `/job-queue/seniors`: the list filter's picker, only the seniors of the viewer's own scope. */
  async seniorOptions(
    user: SessionUser,
    query: Pick<JobQueueScopeQuery, 'teamId'>,
  ): Promise<JobQueueSeniorOptionsResponseDto> {
    const scope = await this.scopes.resolveView(user, query.teamId, this.database.db)
    const versions = await this.scopes.liveVersions(scope, this.database.db)
    if (versions.length === 0) return { items: [] }
    const { rows } = await this.scopes.policy(() =>
      this.database.db.execute(
        seniorOptionRows(
          versions.map((v) => v.seniorId),
          scope.kind === 'TEAM' ? [scope.teamId] : scopeTeamIds(scope),
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
    const scope = await this.scopes.resolveView(user, query.teamId, this.database.db)
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
    scope: JobQueueViewScope,
    versions: readonly LiveSeniorVersion[],
    id: string,
    signature: string,
    after: string | undefined,
  ): Promise<SeniorsPage> {
    const { rows } = await this.database.db.execute(
      seniorRows(scope, versions, id, after, SENIOR_PREVIEW_MAX + 1),
    )
    const total = await this.database.db.execute(seniorTotal(scope, versions, id))
    const page = rows.slice(0, SENIOR_PREVIEW_MAX)
    return {
      items: page.map(toSenior(scope, id)),
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
  private async duplicates(scope: JobQueueViewScope, id: string) {
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

/**
 * Lookup, counts and page of one list request: run in ONE snapshot. Null: a generation is not
 * servable to its scope. `members[i]` owns `generationIds[i]`: the scope itself, or each team of a
 * union. A union's order is `row_number()` over the RAW entries of its member generations (best
 * member rank, then first seen, then id), computed before any predicate, tab or filter, so it is
 * as immutable as the entries are and a dismissal between pages moves no key.
 */
async function readPage(
  tx: SqlExecutor,
  scope: JobQueueViewScope,
  versions: readonly LiveSeniorVersion[],
  members: readonly JobQueueScope[],
  generationIds: readonly string[],
  query: JobQueueListQuery,
  after: number,
  now: Date,
) {
  const generations: GenerationRow[] = []
  for (const [i, generationId] of generationIds.entries()) {
    const generation = await generationById(tx, generationId)
    if (generation === null || !isGenerationServable(members[i] as JobQueueScope, generation, now))
      return null
    generations.push(generation)
  }
  const ids = generations.map((g) => g.id)
  const single = ids.length === 1
  const entries = single
    ? sql`job_queue_generation_entries e`
    : sql`(SELECT ue.opportunity_id,
                  (row_number() OVER (ORDER BY max(ue.rank_score) DESC, max(ue.first_seen_at) DESC,
                                               ue.opportunity_id DESC) - 1)::int AS order_key
             FROM job_queue_generation_entries ue
            WHERE ${generationIn(sql`ue.generation_id`, ids)}
            GROUP BY ue.opportunity_id) e`
  const frame = sql`FROM ${entries}
                    JOIN job_opportunities o ON o.id = e.opportunity_id
                    ${queueRowJoins(scope, versions)}
                   WHERE ${single ? generationIn(sql`e.generation_id`, ids) : sql`TRUE`}
                     AND ${listableOpportunityPredicate(scope, sql`o.id`)}`
  const counts = await tx.execute(
    sql`SELECT count(*) FILTER (WHERE d.tab = 'NEW') AS new,
               count(*) FILTER (WHERE d.tab = 'SUBMITTED') AS submitted,
               count(*) FILTER (WHERE d.tab = 'HIDDEN') AS hidden,
               EXISTS (SELECT 1 FROM job_queue_generation_entries top
                        WHERE ${generationIn(sql`top.generation_id`, ids)}
                          AND top.order_key = ${GENERATION_POLICY.maxEntries - 1}) AS capped
        ${frame}`,
  )
  const tally = counts.rows[0] as Row
  // The union answers as its earliest member: the oldest evaluation, the first expiry.
  const generation = generations.reduce((a, b) => ({
    ...a,
    evaluatedAt: new Date(Math.min(a.evaluatedAt.getTime(), b.evaluatedAt.getTime())),
    expiresAt: new Date(Math.min(a.expiresAt.getTime(), b.expiresAt.getTime())),
  }))
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

/** `column` is one of the generations: `=` for one (the single-scope SQL), `IN` for a union. */
const generationIn = (column: SQL, ids: readonly string[]): SQL =>
  ids.length === 1
    ? sql`${column} = ${ids[0]}::uuid`
    : sql`${column} IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`

const continuationSignature = (
  user: SessionUser,
  scope: JobQueueViewScope,
  versions: readonly LiveSeniorVersion[],
  opportunityId: string,
): string => requestSignature([user.id, policySignature(scope, versions), opportunityId])

const notFound = () => apiError('JOB_OPPORTUNITY_NOT_FOUND', HttpStatus.NOT_FOUND)
