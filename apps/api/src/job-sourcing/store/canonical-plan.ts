import { type JobSourceType, jobSourceTypeSchema } from '@crm/shared'
import {
  type AttachResult,
  type Authority,
  type ClaimValue,
  type FieldClaim,
  type ResolverRecord,
  canAttach,
  chooseCanonical,
  normalizeCompanyName,
  normalizeTitle,
  trustedAtsKeys,
} from '../identity/resolver'
import {
  decodeSalaryClaim,
  encodeSalaryClaim,
  type SalaryObservation,
  salaryMonthlyTop,
} from '../normalize/salary'
import { sortedUniqueIds } from './lock-order'

/**
 * The pure half of the canonical repository (r5 Task 4.5): what a record's latest revision says
 * about identity, what AUTO resolution may do with it, and the canonical fields of a set of
 * members. The store reads the rows under lock and binds the results to SQL.
 */

/** The employer ATS adapters (`GREENHOUSE_ATS`, ...): every shared source type ending `_ATS`. */
export const ATS_SOURCE_TYPES: readonly JobSourceType[] = jobSourceTypeSchema.options.filter((t) =>
  t.endsWith('_ATS'),
)

/** An ATS adapter's record speaks for the employer; every other source is an aggregator. */
const authorityOf = (m: MemberSnapshot): Authority =>
  (ATS_SOURCE_TYPES as readonly string[]).includes(m.provider) ? 'EMPLOYER_ATS' : 'AGGREGATOR'

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
  /**
   * The source publishes no employer BY DESIGN, so the empty `companyName` above is declared, not a
   * defect (`../normalize/employer-disclosure.ts`). Absent on every other record.
   */
  employerWithheldAtSource?: true
  location: string | null
  sourceUrl: string | null
  applicationUrl: string | null
  descriptionSha256: string | null
  publishedAt: string | null
  tags: readonly string[]
  /** The revision's validated structured salary (`../normalize/salary.ts`); null = not stated. */
  salary: SalaryObservation | null
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
      // An Ashby key has no board (`atsJobKey`): its job id alone is checked, below.
      (k.provider === 'ashby' || boardOf(k.namespace) === boardOf(m.namespace.toLowerCase())) &&
      m.nativeId !== null &&
      k.jobId.toLowerCase() === m.nativeId.toLowerCase(),
  }))
}

/**
 * The board slug: the last `:`-segment (the key's namespace is lowercase already). The key's namespace (`us:acme`, `de:acme`)
 * and the adapter's (`greenhouse:acme`, `lever:global:acme`) carry different prefixes for one
 * board, and the slug is the part both state. shortcut: the region prefix is not compared, so a
 * board on two regional deployments of one vendor counts as one board; compare it once the two
 * namespace vocabularies are unified.
 */
const boardOf = (namespace: string) => namespace.slice(namespace.lastIndexOf(':') + 1)

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
  | {
      status: 'UNKNOWN'
      /** `WITHHELD_AT_SOURCE`: no source published one, and some source withholds it by design. */
      reason: 'NO_CLAIMS' | 'EQUAL_AUTHORITY_CONFLICT' | 'WITHHELD_AT_SOURCE'
      candidates: string[]
    }

/**
 * The revision as the UNKNOWN record it is, or `undefined` when a source actually named a value.
 * Its own function, not an inline `typeof`, so a test can reach the "a named value is not an
 * unknown" half directly: inline, a string's missing `.reason` hides it from every assertion.
 */
export function unknownFieldRevision(
  revision: FieldRevision | undefined,
): Exclude<FieldRevision, string> | undefined {
  return typeof revision === 'object' ? revision : undefined
}

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
  salary: SalaryObservation | null
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
  | 'salary'

const valueOf: Record<Field, (m: MemberSnapshot) => ClaimValue | null> = {
  title: (m) => m.title,
  employerName: (m) => m.companyName,
  location: (m) => m.location,
  applicationUrl: (m) => m.applicationUrl,
  publishedAt: (m) => m.publishedAt,
  descriptionSha256: (m) => m.descriptionSha256,
  stackKeywords: (m) => (m.tags.length === 0 ? null : m.tags),
  // ONE atomic claim, never per bound: no min can come from one member and a currency from another.
  salary: (m) => (m.salary === null ? null : encodeSalaryClaim(m.salary)),
}

const usable = (v: ClaimValue | null): v is ClaimValue => v !== null && v !== ''

/** The member with this record id; the id always comes from `members` itself. */
const memberOf = (members: readonly MemberSnapshot[], recordId: string) =>
  members.find((m) => m.recordId === recordId) as MemberSnapshot

/**
 * Per field, `chooseCanonical` over the members' latest revisions. An ATS adapter's record is an
 * EMPLOYER_ATS claim and outranks the rest, which are AGGREGATOR claims (sources-18): the ATS copy
 * of a job wins every field it states. Two differing claims of one authority are UNKNOWN.
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
        authority: authorityOf(m),
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
  // No source named an employer AND some member's source publishes none by design: say which it is.
  // A DISAGREEMENT is left alone — a conflict is not a withholding, and a disclosed winner above
  // never reaches here, so a disclosed employer still wins over a withheld one.
  const employerRevision = unknownFieldRevision(fieldRevisions['employerName'])
  if (
    employerRevision?.reason === 'NO_CLAIMS' &&
    members.some((m) => m.employerWithheldAtSource === true)
  ) {
    fieldRevisions['employerName'] = { ...employerRevision, reason: 'WITHHELD_AT_SOURCE' }
  }
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
    salary: chosen.salary === null ? null : decodeSalaryClaim(chosen.salary as string),
    fieldRevisions,
  }
}

/** The five `job_opportunities` salary columns of a canonical salary; all null without one. */
export interface SalaryColumns {
  min: number | null
  max: number | null
  currency: string | null
  period: SalaryObservation['period'] | null
  monthlyTop: number | null
}

export function salaryColumns(s: SalaryObservation | null): SalaryColumns {
  if (s === null) return { min: null, max: null, currency: null, period: null, monthlyTop: null }
  return {
    min: s.min,
    max: s.max,
    currency: s.currency,
    period: s.period,
    monthlyTop: salaryMonthlyTop(s),
  }
}
