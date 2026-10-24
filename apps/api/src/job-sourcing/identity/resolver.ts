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
  | 'ATS_JOB_KEY_UNCORROBORATED'
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

/**
 * Lowercase, punctuation to spaces, whitespace collapsed. The symbol-bearing technology names are
 * spelled out first so "C++", "C#", "F#" and ".NET" stay distinct from "C" and "NET".
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\bc\+\+/g, 'cplusplus')
    .replace(/\bc#/g, 'csharp')
    .replace(/\bf#/g, 'fsharp')
    .replace(/(^|[^\p{L}\p{N}])\.net\b/gu, '$1dotnet')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const squash = (s: string) => s.replace(/ /g, '')

/** Longest company/title/location/department compared. Longer = unknown, never truncated. */
export const MAX_FIELD_CHARS = 256

/** Strong ATS keys of one record plus evidence about why some were discarded. */
function strongKeys(r: ResolverRecord): { keys: AtsJobKey[]; evidence: string[] } {
  const posting = atsJobKey(r.postingUrl)
  const apply = atsJobKey(r.applicationUrl)
  const evidence: string[] = []
  // Only a key issued by the ATS vendor's own host is identity. A `gh_jid` on an employer page is
  // a parameter anyone can append, on a posting URL or a verified apply URL alike.
  const postingStrong = posting?.scope === 'ATS_HOSTED' ? posting : null
  const applyStrong = r.applicationUrlVerified && apply?.scope === 'ATS_HOSTED' ? apply : null
  if (apply !== null && !r.applicationUrlVerified) evidence.push(`APPLY_URL_UNVERIFIED:${r.id}`)
  if (postingStrong !== null && applyStrong !== null && postingStrong.key !== applyStrong.key) {
    // The record names two different ATS jobs: trust neither URL.
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
const compatible = (a: string | null, b: string | null) => {
  const na = a === null ? '' : normalizeTitle(a)
  const nb = b === null ? '' : normalizeTitle(b)
  return na === '' || nb === '' || na === nb
}

/** A field over the cap is unknown (never truncated: two long strings sharing a prefix must not meet). */
function bounded(
  value: string | null,
  field: string,
  id: string,
  evidence: string[],
): string | null {
  if (value === null || value.length <= MAX_FIELD_CHARS) return value
  evidence.push(`FIELD_TOO_LONG:${id}:${field}`)
  return null
}

export function assess(a: ResolverRecord, b: ResolverRecord): Assessment {
  // `a` and `b` are interchangeable in everything below, which the symmetry test pins.
  if (
    a.nativeId !== null &&
    a.nativeId !== '' &&
    a.nativeId === b.nativeId &&
    a.provider === b.provider &&
    a.namespace === b.namespace
  ) {
    return base('ASSOCIATE', 'NATIVE_ID', [`NATIVE:${a.provider}:${a.namespace}:${a.nativeId}`])
  }

  const ka = strongKeys(a)
  const kb = strongKeys(b)
  const evidence = [...ka.evidence, ...kb.evidence]
  const shared = ka.keys.find((k) => kb.keys.some((o) => o.key === k.key))

  const companyA = normalizeCompanyName(bounded(a.company, 'company', a.id, evidence))
  const companyB = normalizeCompanyName(bounded(b.company, 'company', b.id, evidence))
  const titleA = squash(normalizeTitle(bounded(a.title, 'title', a.id, evidence) ?? ''))
  const titleB = squash(normalizeTitle(bounded(b.title, 'title', b.id, evidence) ?? ''))
  const locationA = bounded(a.location, 'location', a.id, evidence)
  const locationB = bounded(b.location, 'location', b.id, evidence)
  const departmentA = bounded(a.department, 'department', a.id, evidence)
  const departmentB = bounded(b.department, 'department', b.id, evidence)
  evidence.sort()

  const companyEqual = companyA !== null && companyA === companyB
  const companyMismatch = companyA !== null && companyB !== null && companyA !== companyB
  const titleEqual = titleA !== '' && titleA === titleB
  const titleMismatch = titleA !== '' && titleB !== '' && titleA !== titleB

  if (shared !== undefined) {
    const found = [...evidence, `ATS_KEY:${shared.key}`]
    if (companyMismatch) found.push('COMPANY_MISMATCH')
    if (titleMismatch) found.push('TITLE_MISMATCH')
    if (companyMismatch || titleMismatch)
      return base('CANDIDATE', 'ATS_JOB_KEY_CONTRADICTED', found)
    // An unknown side is not an agreement: a blank company and title would otherwise match ANY
    // record onto someone else's ATS key (SR-H-1). At least one field must positively agree.
    if (!companyEqual && !titleEqual) {
      return base('CANDIDATE', 'ATS_JOB_KEY_UNCORROBORATED', [...found, 'NO_POSITIVE_MATCH'])
    }
    return base('ASSOCIATE', 'ATS_JOB_KEY', found)
  }

  const distinctIds = ka.keys.length > 0 && kb.keys.length > 0
  if (
    companyEqual &&
    titleEqual &&
    compatible(locationA, locationB) &&
    compatible(departmentA, departmentB)
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

/** Pairwise assessment is quadratic; a call over more records than this is refused, not truncated. */
export const MAX_CLUSTER_RECORDS = 500

export type ClusterResult =
  | { ok: true; clusters: Cluster[] }
  | { ok: false; reason: 'TOO_MANY_RECORDS' | 'DUPLICATE_RECORD_IDS'; detail: string[] }

/**
 * Deterministic greedy clustering, independent of input order (records are processed by id).
 * Re-running with `revokedPairs` is the split-recovery path: payloads and history are untouched,
 * only the grouping changes, and no record is ever dropped.
 *
 * Association is not transitive, so the result can depend on the ids (never on the input order):
 * if A~H and A~B but H and B are not associated, whichever of H/B sorts first claims A and the
 * other stays alone. That is the precision-first bound: no cluster ever holds a pair the rules do
 * not associate, at the price of some missed recall.
 *
 * Refusals are typed, never silent: more than MAX_CLUSTER_RECORDS records, or two records with the
 * same id (detail lists the offending ids, sorted).
 */
export function clusterRecords(
  records: readonly ResolverRecord[],
  options: ResolveOptions = {},
): ClusterResult {
  if (records.length > MAX_CLUSTER_RECORDS) {
    return { ok: false, reason: 'TOO_MANY_RECORDS', detail: [String(records.length)] }
  }
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const r of records) (seen.has(r.id) ? duplicated : seen).add(r.id)
  if (duplicated.size > 0) {
    return { ok: false, reason: 'DUPLICATE_RECORD_IDS', detail: [...duplicated].sort() }
  }
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
  return {
    ok: true,
    clusters: groups.map((g) => ({
      memberIds: g.members.map((m) => m.id),
      associations: g.associations,
    })),
  }
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

/** Array claims are sets: the same members in another order are the same value. */
const valueKey = (v: ClaimValue) => JSON.stringify(typeof v === 'object' ? [...v].sort() : v)

export function chooseCanonical(claims: readonly FieldClaim[]): CanonicalChoice {
  const policyVersion = canonicalAuthorityPolicyVersion
  if (claims.length === 0)
    return { status: 'UNKNOWN', reason: 'NO_CLAIMS', candidates: [], policyVersion }

  // Only an EXPLICIT restriction dominates: an inferred one is a guess and does not. A neutral
  // (no-stance) claim carries no information, so it neither blocks nor weakens a restriction.
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
