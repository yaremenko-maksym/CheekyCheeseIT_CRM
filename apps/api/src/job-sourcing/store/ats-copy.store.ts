import { type SQL, sql } from 'drizzle-orm'
import { ATS_COPY_WINDOW_MS, normalizeCompanyName, normalizeTitle } from '../identity/resolver'
import type { SqlExecutor } from '../scheduling/host-state'
import type { MemberSnapshot } from './canonical-plan'

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
 * Opportunities with the record's company and title keys (the stored keys' own derivation, on
 * `idx_job_opportunities_candidate_key`) that AUTO alone built: no manual team, at least one active
 * link, every active link AUTO, and no ADMIN split on the opportunity or on the record. An ADMIN
 * decision is never re-merged. `only` restricts the read to ids (the re-check under lock). Returns
 * at most ATS_COPY_MAX_CANDIDATES + 1 ids, ascending.
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
      ? sql``
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
                        WHERE s.opportunity_id = o.id AND s.unlink_reason LIKE 'ADMIN_SPLIT:%')
       AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s
                         JOIN job_opportunity_sources u ON u.source_record_id = s.source_record_id
                        WHERE s.opportunity_id = o.id AND s.unlinked_at IS NULL
                          AND u.unlink_reason LIKE 'ADMIN_SPLIT:%')
       AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources u
                        WHERE u.source_record_id = ${snap.recordId}::uuid
                          AND u.unlink_reason LIKE 'ADMIN_SPLIT:%')
     ORDER BY o.id
     LIMIT ${ATS_COPY_MAX_CANDIDATES + 1}`
}

/**
 * The OTHER records of the record's own board (`source_type`, `namespace`) whose latest title
 * equals its title, observed within ATS_COPY_WINDOW_MS of it: a board running one title more than
 * once is several jobs, and an aggregator copy cannot say which. SQL prefilters on the lowercased
 * title, JS confirms with `normalizeTitle`. shortcut: titles differing only in punctuation pass
 * the prefilter unseen; a missed sibling needs an ADMIN split, rare by construction.
 */
export async function atsSiblings(tx: SqlExecutor, snap: MemberSnapshot): Promise<number> {
  const first = snap.firstSeenAt
  const last = snap.lastObservedAt
  if (first === undefined || last === undefined) return 0
  const { rows } = await tx.execute(
    sql`SELECT v.normalized->>'title' AS title
          FROM job_source_records r JOIN job_source_record_revisions v ON v.id = r.latest_revision_id
         WHERE r.source_type = ${snap.provider} AND r.namespace = ${snap.namespace}
           AND r.id <> ${snap.recordId}::uuid
           AND lower(v.normalized->>'title') = lower(${snap.title})
           AND r.last_observed_at >= ${first.toISOString()}::timestamptz - ${windowInterval}
           AND r.first_seen_at <= ${last.toISOString()}::timestamptz + ${windowInterval}
         LIMIT ${SIBLING_READ_MAX}`,
  )
  const own = normalizeTitle(snap.title)
  return rows.filter((r) => normalizeTitle(String(r['title'] ?? '')) === own).length
}
