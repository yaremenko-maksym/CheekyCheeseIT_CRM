import {
  type AttachResult,
  type ClaimValue,
  type FieldClaim,
  type ResolverRecord,
  canAttach,
  chooseCanonical,
  normalizeCompanyName,
  normalizeTitle,
  trustedAtsKeys,
} from '../identity/resolver'
import { sortedUniqueIds } from './lock-order'

/**
 * The pure half of the canonical repository (r5 Task 4.5): what a record's latest revision says
 * about identity, what AUTO resolution may do with it, and the canonical fields of a set of
 * members. The store reads the rows under lock and binds the results to SQL.
 */

/** One active member of an opportunity: a record and its latest revision. */
export interface MemberSnapshot {
  recordId: string
  revisionId: string
  receivedSeq: number
  receivedAt: Date
  provider: string
  namespace: string
  nativeId: string | null
  title: string
  companyName: string
  location: string | null
  sourceUrl: string | null
  applicationUrl: string | null
  descriptionSha256: string | null
  publishedAt: string | null
  tags: readonly string[]
}

export function toResolverRecord(m: MemberSnapshot): ResolverRecord {
  return {
    id: m.recordId,
    provider: m.provider,
    namespace: m.namespace,
    nativeId: m.nativeId,
    company: m.companyName === '' ? null : m.companyName,
    title: m.title,
    location: m.location,
    department: null,
    postingUrl: m.sourceUrl,
    applicationUrl: m.applicationUrl,
    // No adapter reports a verified job-specific apply URL yet, so none is trusted (A-4).
    applicationUrlVerified: false,
  }
}

export interface IdentityToken {
  kind: 'ATS_JOB_KEY'
  key: string
  /**
   * The record may CLAIM the token, not only match on it (SR-M-2): only a record from that ATS's
   * own adapter (`GREENHOUSE_ATS` for a greenhouse key, ...) AND only for the record's own job
   * (PRE-M-1): the key's board is the record's verified board and the key's job id is the record's
   * native id — the key is the adapter's trusted (namespace, native id), not the URL in the payload.
   * An aggregator, or another board of the same ATS, that reports a vendor job URL is a first-comer
   * anyone could be: it may attach to the owner but never become it.
   */
  claimable: boolean
}

/** The resolver's trusted ATS keys of a record, each marked claimable or not. */
export function trustedTokens(m: MemberSnapshot): IdentityToken[] {
  return trustedAtsKeys(toResolverRecord(m)).map((k) => ({
    kind: 'ATS_JOB_KEY',
    key: k.key,
    claimable:
      m.provider === `${k.provider.toUpperCase()}_ATS` &&
      boardOf(k.namespace) === boardOf(m.namespace) &&
      k.jobId.toLowerCase() === (m.nativeId ?? '').toLowerCase(),
  }))
}

/**
 * The board slug: the last `:`-segment, lowercased. The key's namespace (`us:acme`, `de:acme`)
 * and the adapter's (`greenhouse:acme`, `lever:global:acme`) carry different prefixes for one
 * board, and the slug is the part both state. shortcut: the region prefix is not compared, so a
 * board on two regional deployments of one vendor counts as one board; compare it once the two
 * namespace vocabularies are unified.
 */
const boardOf = (namespace: string) => namespace.slice(namespace.lastIndexOf(':') + 1).toLowerCase()

/**
 * The order records are DECIDED in (the locks are already taken, by id): records that can claim a
 * token first, so a batch holding a job's own ATS record and a copy of it creates the owner before
 * the copy looks for one. Otherwise ascending id, as given.
 */
export function decisionOrder(
  ids: readonly string[],
  snaps: ReadonlyMap<string, MemberSnapshot>,
): string[] {
  const claims = (id: string) => {
    const snap = snaps.get(id)
    return snap !== undefined && trustedTokens(snap).some((t) => t.claimable)
  }
  return [...ids.filter(claims), ...ids.filter((id) => !claims(id))]
}

/**
 * KEEP may claim a linked record's new tokens only when the record still associates with every
 * OTHER member (SR-M-2), the same every-member check ATTACH passes; alone, nothing contradicts it.
 */
export function keepMayClaim(others: readonly MemberSnapshot[], self: MemberSnapshot): boolean {
  return (
    others.length === 0 || canAttach(others.map(toResolverRecord), toResolverRecord(self)).attach
  )
}

/** A database instant as a Date, milliseconds kept (CR-M-5): pg hands timestamptz back as Date. */
export function toInstant(value: unknown): Date {
  const at = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(at.getTime())) throw new RangeError('toInstant: not an instant')
  return at
}

export interface ActiveLink {
  opportunityId: string
  decision: 'AUTO' | 'CONFIRMED'
}

export type AutoDecision =
  | { kind: 'KEEP'; opportunityId: string }
  | { kind: 'CONFLICT'; opportunityId: string; owners: readonly string[] }
  | { kind: 'ATTACH'; opportunityId: string; associations: unknown[] }
  | { kind: 'NEW'; reason: 'NO_TRUSTED_MATCH' | 'NOT_ASSOCIATED' | 'TOKEN_CONFLICT' }

/**
 * AUTO resolution of one record. `owners` are the distinct opportunities owning the record's
 * tokens; `attach` is the every-member check against the single owner, read under its lock.
 * AUTO never moves a linked record and never merges two opportunities: both need an ADMIN.
 */
export function decideAuto(input: {
  link: ActiveLink | null
  owners: readonly string[]
  attach: AttachResult | null
}): AutoDecision {
  const { link, owners, attach } = input
  if (link !== null) {
    return owners.some((o) => o !== link.opportunityId)
      ? { kind: 'CONFLICT', opportunityId: link.opportunityId, owners }
      : { kind: 'KEEP', opportunityId: link.opportunityId }
  }
  if (owners.length === 0) return { kind: 'NEW', reason: 'NO_TRUSTED_MATCH' }
  if (owners.length > 1) return { kind: 'NEW', reason: 'TOKEN_CONFLICT' }
  return attach?.attach === true
    ? { kind: 'ATTACH', opportunityId: owners[0] as string, associations: attach.associations }
    : { kind: 'NEW', reason: 'NOT_ASSOCIATED' }
}

export type FieldRevision =
  | string
  | { status: 'UNKNOWN'; reason: 'NO_CLAIMS' | 'EQUAL_AUTHORITY_CONFLICT'; candidates: string[] }

export interface CanonicalFields {
  title: string
  titleKey: string
  employerName: string | null
  employerKey: string | null
  location: string | null
  applicationUrl: string | null
  publishedAt: string | null
  descriptionSha256: string | null
  stackKeywords: string[]
  fieldRevisions: Record<string, FieldRevision>
}

type Field =
  | 'title'
  | 'employerName'
  | 'location'
  | 'applicationUrl'
  | 'publishedAt'
  | 'descriptionSha256'
  | 'stackKeywords'

const valueOf: Record<Field, (m: MemberSnapshot) => ClaimValue | null> = {
  title: (m) => m.title,
  employerName: (m) => m.companyName,
  location: (m) => m.location,
  applicationUrl: (m) => m.applicationUrl,
  publishedAt: (m) => m.publishedAt,
  descriptionSha256: (m) => m.descriptionSha256,
  stackKeywords: (m) => (m.tags.length === 0 ? null : m.tags),
}

const usable = (v: ClaimValue | null): v is ClaimValue => v !== null && v !== ''

/** The member with this record id; the id always comes from `members` itself. */
const memberOf = (members: readonly MemberSnapshot[], recordId: string) =>
  members.find((m) => m.recordId === recordId) as MemberSnapshot

/**
 * Per field, `chooseCanonical` over the members' latest revisions. Every source record is an
 * AGGREGATOR claim. shortcut: one authority for all sources, so differing values are UNKNOWN;
 * upgrade when an adapter can certify employer/ATS authority (canonical authority policy).
 * An UNKNOWN title keeps `previousTitle` (the column is NOT NULL), else the lowest record id's.
 */
export function canonicalFields(
  members: readonly MemberSnapshot[],
  previousTitle: string | null,
): CanonicalFields {
  if (members.length === 0) throw new RangeError('canonicalFields: an opportunity needs a member')
  const fieldRevisions: Record<string, FieldRevision> = {}
  const chosen = {} as Record<Field, ClaimValue | null>
  for (const field of Object.keys(valueOf) as Field[]) {
    const claims: FieldClaim[] = []
    for (const m of members) {
      const value = valueOf[field](m)
      if (!usable(value)) continue
      claims.push({
        sourceRecordId: m.recordId,
        authority: 'AGGREGATOR',
        value,
        observedAt: m.receivedAt,
        revision: m.receivedSeq,
      })
    }
    const choice = chooseCanonical(claims)
    if (choice.status === 'CHOSEN') {
      chosen[field] = choice.value
      fieldRevisions[field] = memberOf(members, choice.winnerId).revisionId
    } else {
      chosen[field] = null
      fieldRevisions[field] = {
        status: 'UNKNOWN',
        reason: choice.reason,
        candidates: choice.candidates,
      }
    }
  }
  const lowestId = sortedUniqueIds(members.map((m) => m.recordId))[0] as string
  const title =
    (chosen.title as string | null) ?? previousTitle ?? memberOf(members, lowestId).title
  const employerName = chosen.employerName as string | null
  return {
    title,
    titleKey: normalizeTitle(title),
    employerName,
    employerKey: normalizeCompanyName(employerName),
    location: chosen.location as string | null,
    applicationUrl: chosen.applicationUrl as string | null,
    publishedAt: chosen.publishedAt as string | null,
    descriptionSha256: chosen.descriptionSha256 as string | null,
    stackKeywords: [...((chosen.stackKeywords as readonly string[] | null) ?? [])].sort(),
    fieldRevisions,
  }
}
