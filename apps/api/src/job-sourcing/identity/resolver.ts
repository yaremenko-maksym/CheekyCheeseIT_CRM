import { atsJobKey, type AtsJobKey } from './ats-job-key'

/**
 * Pure association rules between source records of one job opportunity (Task 4.3). No DB, no
 * network, no clock. Merge precision comes before recall (MP-12): the default is DISTINCT, a shared
 * company/title is only ever a CANDIDATE, and a record joins a cluster only when it is associated
 * with EVERY member.
 */

/** Bump when any rule changes: associations carry it as their revision. */
export const IDENTITY_RULES_VERSION = 'identity-rules-v1'

export interface ResolverRecord {
  id: string
  provider: string
  namespace: string
  nativeId: string | null
  company: string | null
  title: string
  location: string | null
  department: string | null
  postingUrl: string | null
  applicationUrl: string | null
  /** The adapter verified the application URL as job-specific employer/ATS (not tracking/homepage). */
  applicationUrlVerified: boolean
}

export type Decision = 'ASSOCIATE' | 'CANDIDATE' | 'DISTINCT'
export type AssessRule =
  | 'NATIVE_ID'
  | 'ATS_JOB_KEY'
  | 'ATS_JOB_KEY_CONTRADICTED'
  | 'COMPANY_TITLE'
  | 'NO_SHARED_IDENTITY'
  | 'REVOKED'

export interface Assessment {
  decision: Decision
  rule: AssessRule
  evidence: string[]
  revision: string
}

/**
 * Lowercase, punctuation to spaces, whitespace collapsed. Legal-form suffixes are deliberately
 * KEPT: "Acme" and "Acme Inc" / "Acme Staffing" are different employers until proven otherwise.
 */
export function normalizeCompanyName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null
  const n = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return n.length > 0 ? n : null
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const squash = (s: string) => s.replace(/ /g, '')

/** Strong ATS keys of one record plus evidence about why some were discarded. */
function strongKeys(r: ResolverRecord): { keys: AtsJobKey[]; evidence: string[] } {
  const posting = atsJobKey(r.postingUrl)
  const apply = atsJobKey(r.applicationUrl)
  const evidence: string[] = []
  const postingStrong = posting?.scope === 'ATS_HOSTED' ? posting : null
  const applyStrong = r.applicationUrlVerified ? apply : null
  if (apply !== null && !r.applicationUrlVerified) evidence.push(`APPLY_URL_UNVERIFIED:${r.id}`)
  if (postingStrong !== null && applyStrong !== null && postingStrong.key !== applyStrong.key) {
    // The record contradicts itself: trust neither URL.
    return { keys: [], evidence: [`APPLY_URL_CONFLICT:${r.id}`] }
  }
  return { keys: [postingStrong, applyStrong].filter((k): k is AtsJobKey => k !== null), evidence }
}

const base = (decision: Decision, rule: AssessRule, evidence: string[]): Assessment => ({
  decision,
  rule,
  evidence,
  revision: IDENTITY_RULES_VERSION,
})

/** Unknown on either side is compatible; two known values must be equal. */
const compatible = (a: string | null, b: string | null, norm: (s: string) => string) =>
  a === null || b === null || norm(a) === '' || norm(b) === '' || norm(a) === norm(b)

export function assess(x: ResolverRecord, y: ResolverRecord): Assessment {
  // Every field below is symmetric in (a, b) by construction, which the symmetry test pins.
  const [a, b] = [x, y]

  if (
    a.nativeId !== null &&
    a.nativeId === b.nativeId &&
    a.provider === b.provider &&
    a.namespace === b.namespace
  ) {
    return base('ASSOCIATE', 'NATIVE_ID', [`NATIVE:${a.provider}:${a.namespace}:${a.nativeId}`])
  }

  const ka = strongKeys(a)
  const kb = strongKeys(b)
  const evidence = [...ka.evidence, ...kb.evidence].sort()
  const shared = ka.keys.find((k) => kb.keys.some((o) => o.key === k.key))

  const companyA = normalizeCompanyName(a.company)
  const companyB = normalizeCompanyName(b.company)
  const companyMismatch = companyA !== null && companyB !== null && companyA !== companyB
  const titleA = squash(normalizeTitle(a.title))
  const titleB = squash(normalizeTitle(b.title))
  const titleMismatch = titleA !== '' && titleB !== '' && titleA !== titleB

  if (shared !== undefined) {
    const found = [...evidence, `ATS_KEY:${shared.key}`]
    if (companyMismatch) found.push('COMPANY_MISMATCH')
    if (titleMismatch) found.push('TITLE_MISMATCH')
    return companyMismatch || titleMismatch
      ? base('CANDIDATE', 'ATS_JOB_KEY_CONTRADICTED', found)
      : base('ASSOCIATE', 'ATS_JOB_KEY', found)
  }

  const distinctIds = ka.keys.length > 0 && kb.keys.length > 0
  if (
    companyA !== null &&
    companyA === companyB &&
    titleA !== '' &&
    titleA === titleB &&
    compatible(a.location, b.location, normalizeTitle) &&
    compatible(a.department, b.department, normalizeTitle)
  ) {
    return base(
      'CANDIDATE',
      'COMPANY_TITLE',
      distinctIds ? [...evidence, 'DISTINCT_ATS_IDS'] : evidence,
    )
  }
  return base('DISTINCT', 'NO_SHARED_IDENTITY', evidence)
}

export interface Association {
  aId: string
  bId: string
  rule: AssessRule
  evidence: string[]
  /** The rules version that produced it (reversible: a correction records a new one). */
  revision: string
  actor: 'RULES'
}

export type AttachResult =
  | { attach: true; associations: Association[] }
  | {
      attach: false
      reason: 'NOT_ASSOCIATED_WITH_ALL' | 'EMPTY_CLUSTER' | 'ALREADY_MEMBER'
      blockedBy: string[]
    }

export interface ResolveOptions {
  /** Pairs an ADMIN split; never re-associated whatever the rules say. */
  revokedPairs?: readonly (readonly [string, string])[]
}

/** Default string sort is by UTF-16 code unit: one fixed order, no comparator to get wrong. */
const sortedPair = (p: string, q: string) => [p, q].sort() as [string, string]
const pairKey = (p: string, q: string) => sortedPair(p, q).join('\u0000')

// Stryker disable next-line EqualityOperator: ids are unique, so the equal case never reaches here
const byId = (p: { id: string }, q: { id: string }) => (p.id < q.id ? -1 : 1)

export const revocationSet = (pairs: ResolveOptions['revokedPairs']): Set<string> =>
  new Set((pairs ?? []).map(([p, q]) => pairKey(p, q)))

/** `assess`, except that a pair an ADMIN split is DISTINCT whatever the rules say. */
export function assessWithRevocations(
  a: ResolverRecord,
  b: ResolverRecord,
  revoked: Set<string>,
): Assessment {
  return revoked.has(pairKey(a.id, b.id))
    ? base('DISTINCT', 'REVOKED', [`REVOKED:${sortedPair(a.id, b.id).join(',')}`])
    : assess(a, b)
}

function attach(
  cluster: readonly ResolverRecord[],
  c: ResolverRecord,
  revoked: Set<string>,
): AttachResult {
  if (cluster.length === 0) return { attach: false, reason: 'EMPTY_CLUSTER', blockedBy: [] }
  if (cluster.some((m) => m.id === c.id))
    return { attach: false, reason: 'ALREADY_MEMBER', blockedBy: [c.id] }
  const associations: Association[] = []
  const blockedBy: string[] = []
  for (const m of [...cluster].sort(byId)) {
    const r = assessWithRevocations(m, c, revoked)
    if (r.decision !== 'ASSOCIATE') {
      blockedBy.push(m.id)
      continue
    }
    const [aId, bId] = sortedPair(m.id, c.id)
    associations.push({
      aId,
      bId,
      rule: r.rule,
      evidence: r.evidence,
      revision: r.revision,
      actor: 'RULES',
    })
  }
  return blockedBy.length > 0
    ? { attach: false, reason: 'NOT_ASSOCIATED_WITH_ALL', blockedBy }
    : { attach: true, associations }
}

/** Every-member check: a record joins only when associated with ALL current members. */
export function canAttach(
  cluster: readonly ResolverRecord[],
  candidate: ResolverRecord,
): AttachResult {
  return attach(cluster, candidate, new Set())
}

export interface Cluster {
  /** Sorted record ids; the first is the cluster's stable name. */
  memberIds: string[]
  /** One association per member pair (a clique, by the every-member check). */
  associations: Association[]
}

/**
 * Deterministic greedy clustering, independent of input order (records are processed by id).
 * Re-running with `revokedPairs` is the split-recovery path: payloads and history are untouched,
 * only the grouping changes, and no record is ever dropped.
 */
export function clusterRecords(
  records: readonly ResolverRecord[],
  options: ResolveOptions = {},
): Cluster[] {
  const revoked = revocationSet(options.revokedPairs)
  const ordered = [...records].sort(byId)
  const groups: { members: ResolverRecord[]; associations: Association[] }[] = []
  for (const rec of ordered) {
    let placed = false
    for (const g of groups) {
      const r = attach(g.members, rec, revoked)
      if (r.attach) {
        g.members.push(rec)
        g.associations.push(...r.associations)
        placed = true
        break
      }
    }
    if (!placed) groups.push({ members: [rec], associations: [] })
  }
  return groups.map((g) => ({
    memberIds: g.members.map((m) => m.id),
    associations: g.associations,
  }))
}

// ---------------------------------------------------------------------------------------------
// Canonical field choice
// ---------------------------------------------------------------------------------------------

/** Frozen before activation; bump on any change to the ranking below. */
export const canonicalAuthorityPolicyVersion = 'authority-v1'

export type Authority = 'EMPLOYER_ATS' | 'PUBLISHER_STRUCTURED' | 'AGGREGATOR' | 'INFERENCE'
const AUTHORITY_RANK: Record<Authority, number> = {
  EMPLOYER_ATS: 4,
  PUBLISHER_STRUCTURED: 3,
  AGGREGATOR: 2,
  INFERENCE: 1,
}

export type ClaimValue = string | number | boolean | readonly string[]

export interface FieldClaim {
  sourceRecordId: string
  authority: Authority
  value: ClaimValue
  /** RESTRICTIVE claims ("EU only") dominate PERMISSIVE ones; omitted = neutral. */
  stance?: 'RESTRICTIVE' | 'PERMISSIVE'
  observedAt: Date
  revision: number
}

export type CanonicalChoice =
  | {
      status: 'CHOSEN'
      value: ClaimValue
      authority: Authority
      winnerId: string
      rule: 'AUTHORITY' | 'RESTRICTION'
      policyVersion: string
    }
  | {
      status: 'UNKNOWN'
      reason: 'NO_CLAIMS' | 'EQUAL_AUTHORITY_CONFLICT'
      candidates: string[]
      policyVersion: string
    }

const valueKey = (v: ClaimValue) => JSON.stringify(v)

export function chooseCanonical(claims: readonly FieldClaim[]): CanonicalChoice {
  const policyVersion = canonicalAuthorityPolicyVersion
  if (claims.length === 0)
    return { status: 'UNKNOWN', reason: 'NO_CLAIMS', candidates: [], policyVersion }

  // Only an EXPLICIT restriction dominates: an inferred one is a guess and does not.
  const restrictive = claims.filter(
    (c) => c.stance === 'RESTRICTIVE' && c.authority !== 'INFERENCE',
  )
  const rule = restrictive.length > 0 ? 'RESTRICTION' : 'AUTHORITY'
  const pool = restrictive.length > 0 ? restrictive : claims

  const top = Math.max(...pool.map((c) => AUTHORITY_RANK[c.authority]))
  const tier = pool.filter((c) => AUTHORITY_RANK[c.authority] === top)
  if (new Set(tier.map((c) => valueKey(c.value))).size > 1) {
    return {
      status: 'UNKNOWN',
      reason: 'EQUAL_AUTHORITY_CONFLICT',
      candidates: tier.map((c) => c.sourceRecordId).sort(),
      policyVersion,
    }
  }
  // `tier` is non-empty: `claims` is, and `top` is the maximum of a non-empty pool.
  const winner = [...tier].sort(
    (p, q) =>
      q.observedAt.getTime() - p.observedAt.getTime() ||
      q.revision - p.revision ||
      (p.sourceRecordId < q.sourceRecordId ? -1 : p.sourceRecordId > q.sourceRecordId ? 1 : 0),
  )[0] as FieldClaim
  return {
    status: 'CHOSEN',
    value: winner.value,
    authority: winner.authority,
    winnerId: winner.sourceRecordId,
    rule,
    policyVersion,
  }
}
