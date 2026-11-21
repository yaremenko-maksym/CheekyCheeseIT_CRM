import { type SQL, sql } from 'drizzle-orm'
import {
  ATS_COPY_WINDOW_MS,
  type AttachResult,
  type Association,
  atsCopyAttach,
  normalizeCompanyName,
  normalizeTitle,
} from '../identity/resolver'
import type { SqlExecutor } from '../scheduling/host-state'
import { type MemberSnapshot, toResolverRecord, trustedTokens } from './canonical-plan'

/**
 * The reads of the ATS_COPY rule (sources-18): which opportunities an unmatched record may join
 * as the same job seen through an aggregator and through the employer's ATS, and whether its own
 * board runs that title more than once. The decision is `atsCopyAttach` (`../identity/resolver.ts`);
 * these are the link facts it cannot see.
 */

/** More candidates than this is ambiguous by itself: none is read, none joined. */
export const ATS_COPY_MAX_CANDIDATES = 20
/** Same-title siblings read before confirming in JS; one confirmed is enough to refuse. */
const SIBLING_READ_MAX = 50

const windowInterval = sql`${`${ATS_COPY_WINDOW_MS} milliseconds`}::interval`

/**
 * A link an ADMIN ended: a split, or a relink that moved the record to another opportunity
 * (`canonical.store.ts`). Either is a human saying "these are not one job".
 */
const adminUnlink = (alias: SQL) =>
  sql`(${alias}.unlink_reason LIKE 'ADMIN_SPLIT:%' OR ${alias}.unlink_reason LIKE 'ADMIN_RELINK:%')`

/**
 * Opportunities with the record's company and title keys (the stored keys' own derivation, on
 * `idx_job_opportunities_candidate_key`) that AUTO alone built: no manual team, at least one active
 * link, every active link AUTO, and no ADMIN split or relink-away on the opportunity, on a member
 * or on the record. An ADMIN decision is never re-merged. `only` restricts the read to ids (the
 * re-check under lock, or the one token owner). Returns at most ATS_COPY_MAX_CANDIDATES + 1 ids,
 * ascending.
 */
export async function copyCandidates(
  tx: SqlExecutor,
  snap: MemberSnapshot,
  only?: readonly string[],
): Promise<string[]> {
  const statement = copyCandidatesSql(snap, only)
  if (statement === null) return []
  const { rows } = await tx.execute(statement)
  return rows.map((r) => String(r['id']))
}

/** The statement `copyCandidates` runs, or null when the record names no company or title. */
export function copyCandidatesSql(snap: MemberSnapshot, only?: readonly string[]): SQL | null {
  const employerKey = normalizeCompanyName(snap.companyName)
  const titleKey = normalizeTitle(snap.title)
  if (employerKey === null || titleKey === '' || only?.length === 0) return null
  const restrict =
    only === undefined
      ? sql.empty()
      : sql`AND o.id IN (${sql.join(
          only.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
  return sql`SELECT o.id FROM job_opportunities o
     WHERE o.employer_key = ${employerKey} AND o.title_key = ${titleKey}
       AND o.manual_team_id IS NULL ${restrict}
       AND EXISTS (SELECT 1 FROM job_opportunity_sources s
                    WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s
                        WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL AND s.decision <> 'AUTO')
       AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s
                        WHERE s.opportunity_id = o.id AND ${adminUnlink(sql`s`)})
       AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s
                         JOIN job_opportunity_sources u ON u.source_record_id = s.source_record_id
                        WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL
                          AND ${adminUnlink(sql`u`)})
       AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources u
                        WHERE u.source_record_id = ${snap.recordId}::uuid
                          AND ${adminUnlink(sql`u`)})
     ORDER BY o.id
     LIMIT ${ATS_COPY_MAX_CANDIDATES + 1}`
}

/**
 * A key COARSER than `normalizeTitle` / `normalizeCompanyName`, so the SQL prefilter is a superset
 * of the JS confirmation: NFKC, lowercase, every non-alphanumeric dropped, and the spelled-out
 * technology names `normalizeTitle` produces folded back to the letter they came from
 * ("C++" and "cplusplus" both give "c"). Coarser only widens the read; JS decides.
 */
export const squashKeySql = (value: SQL) =>
  sql`regexp_replace(regexp_replace(regexp_replace(lower(normalize(${value}, NFKC)),
        '[^[:alnum:]]+', '', 'g'), '([cf])(plusplus|sharp)', '\\1', 'g'), 'dotnet', 'net', 'g')`

/**
 * The OTHER records of the record's own board (`source_type`, `namespace`) with its title and
 * company, observed within ATS_COPY_WINDOW_MS of it: a board running one title more than once is
 * several jobs, and an aggregator copy cannot say which. SQL prefilters on `squashKeySql` (a
 * superset), JS confirms with `normalizeTitle` and `normalizeCompanyName`. The company matters on
 * an aggregator board (one namespace, many employers). A read that reaches SIBLING_READ_MAX + 1
 * rows may hide a sibling, so it counts as one: refused, never guessed.
 */
export async function atsSiblings(tx: SqlExecutor, snap: MemberSnapshot): Promise<number> {
  const first = snap.firstSeenAt
  const last = snap.lastObservedAt
  if (first === undefined || last === undefined) return 0
  const { rows } = await tx.execute(
    sql`SELECT v.normalized->>'title' AS title, v.normalized->>'companyName' AS company
          FROM job_source_records r JOIN job_source_record_revisions v ON v.id = r.latest_revision_id
         WHERE r.source_type = ${snap.provider} AND r.namespace = ${snap.namespace}
           AND r.id <> ${snap.recordId}::uuid
           AND ${squashKeySql(sql`coalesce(v.normalized->>'title', '')`)} = ${squashKeySql(sql`${snap.title}::text`)}
           AND ${squashKeySql(sql`coalesce(v.normalized->>'companyName', '')`)} = ${squashKeySql(sql`${snap.companyName}::text`)}
           AND r.last_observed_at >= ${first.toISOString()}::timestamptz - ${windowInterval}
           AND r.first_seen_at <= ${last.toISOString()}::timestamptz + ${windowInterval}
         LIMIT ${SIBLING_READ_MAX + 1}`,
  )
  if (rows.length > SIBLING_READ_MAX) return rows.length
  const title = normalizeTitle(snap.title)
  const company = normalizeCompanyName(snap.companyName)
  return rows.filter(
    (r) =>
      typeof r['title'] === 'string' &&
      normalizeTitle(r['title']) === title &&
      normalizeCompanyName(r['company'] as string | null) === company,
  ).length
}

/** What the ATS_COPY rule decides for a record no stored token placed. */
export type CopyDecision =
  | { kind: 'ATTACH'; opportunityId: string; associations: Association[] }
  | { kind: 'NEW'; reason: 'NO_TRUSTED_MATCH' | 'ATS_COPY_AMBIGUOUS' | 'ATS_COPY_SIBLING' }

/**
 * The one opportunity every member of which accepts the record: exactly one passing joins, more
 * than one is ambiguous, none leaves the record as unmatched as before.
 */
export function pickCopyTarget(
  results: readonly { opportunityId: string; result: AttachResult }[],
): CopyDecision {
  const passing = results.flatMap(({ opportunityId, result }) =>
    result.attach ? [{ opportunityId, associations: result.associations }] : [],
  )
  if (passing.length > 1) return { kind: 'NEW', reason: 'ATS_COPY_AMBIGUOUS' }
  const [one] = passing
  return one === undefined
    ? { kind: 'NEW', reason: 'NO_TRUSTED_MATCH' }
    : { kind: 'ATTACH', opportunityId: one.opportunityId, associations: one.associations }
}

/** The two reads `atsCopyMatch` needs from the resolve transaction it runs in. */
export interface CopyMatchPort {
  /** Locks opportunities taken out of order (the bounded-retry case of `withLockRetry`). */
  lockLate(ids: readonly string[]): Promise<void>
  members(opportunityId: string): Promise<MemberSnapshot[]>
}

/**
 * sources-18, for a record `decideAuto` left as NEW: find candidates (`only`: just the token owner,
 * for NOT_ASSOCIATED), lock them, re-read them under the lock (a link may have changed in between),
 * refuse an ATS-backed record whose own board runs the title more than once, and ask
 * `atsCopyAttach` of each. The sibling read is skipped when every candidate already holds a member
 * with the record's own ATS key: the copies there were joined to that job, there is nothing to pick.
 */
export async function atsCopyMatch(
  tx: SqlExecutor,
  snap: MemberSnapshot,
  port: CopyMatchPort,
  only?: readonly string[],
): Promise<CopyDecision> {
  const found = await copyCandidates(tx, snap, only)
  if (found.length === 0) return { kind: 'NEW', reason: 'NO_TRUSTED_MATCH' }
  if (found.length > ATS_COPY_MAX_CANDIDATES) return { kind: 'NEW', reason: 'ATS_COPY_AMBIGUOUS' }
  await port.lockLate(found)
  const clusters: { opportunityId: string; members: MemberSnapshot[] }[] = []
  for (const opportunityId of await copyCandidates(tx, snap, found))
    clusters.push({ opportunityId, members: await port.members(opportunityId) })
  const own = new Set(trustedTokens(snap).map((t) => t.key))
  const holdsOwnKey = (ms: readonly MemberSnapshot[]) =>
    ms.some((m) => trustedTokens(m).some((t) => own.has(t.key)))
  if (
    own.size > 0 &&
    !clusters.every((c) => holdsOwnKey(c.members)) &&
    (await atsSiblings(tx, snap)) > 0
  )
    return { kind: 'NEW', reason: 'ATS_COPY_SIBLING' }
  return pickCopyTarget(
    clusters.map(({ opportunityId, members }) => ({
      opportunityId,
      result: atsCopyAttach(members.map(toResolverRecord), toResolverRecord(snap)),
    })),
  )
}
