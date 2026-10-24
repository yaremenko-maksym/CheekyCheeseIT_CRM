import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  jobSourceTypeSchema,
  type JobMeterUnit,
  type JobMeterWindow,
  type JobSourceType,
} from '@crm/shared'
import { PERMISSIONS, provenanceSchema, type Provenance } from '../../test/fixture-provenance'
import type { ReportingJobSourceProvider } from './reporting-provider'

/**
 * The typed source manifest (r5 Task 3.7): ONE entry per seeded source/config, one explicit
 * disposition per `JobSourceType`, everything that can be read from the repository READ rather than
 * retyped.
 *
 * !! MERGING THIS MAKES NO SOURCE RUNNABLE. The service registry holds the legacy `JobSourceProvider`
 * contract, every phase-3 adapter implements `ReportingJobSourceProvider`, and nothing in production
 * builds a `CollectionContext` (plan Task 2.5, not built). The manifest is data and a drift test; it
 * is not a registry and must never be consulted by the pipeline as one. Task 2.5 is what ties each
 * entry here to a registered adapter.
 *
 * WHAT IS DERIVED, AND FROM WHAT (backlog 285: a hand-kept copy of a fact that exists elsewhere is a
 * future true-but-incomplete claim):
 *  - the permission of a source: its fixtures' `*.provenance.json` (`permission`);
 *  - whether it was ever captured: the sentinel markers of those same files (an epoch `fetchedAt` is
 *    "never", not a date);
 *  - who owns a board and how strongly that is evidenced: the `EVIDENCE:` token in the notes;
 *  - the readiness a provider's module states about itself (`*_SOURCE_STATUS`): imported, then
 *    RECONCILED with the provenance, never preferred over it;
 *  - the date a permission changes: the adapter's own exported constant (`RECRUITEE_TOKEN_DEADLINE`);
 *  - the config's validity: the adapter's own INSTANCE `parseConfig`;
 *  - every hash: recomputed from the committed bytes.
 *
 * READINESS IS A FUNCTION OF A CLOCK AS WELL AS OF PROVENANCE. `blockers` here are the clock-free
 * ones; `readinessAt(subject, now)` adds the ones that begin on a date. A committed snapshot of
 * readiness (the seed delta's `readiness` column) is therefore a statement about one instant, and
 * `SEED_CLOCK` in the generator names it.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ManifestErrorCode =
  | 'UNKNOWN_PROVIDER'
  | 'NO_ADAPTER'
  | 'MISSING_DISPOSITION'
  | 'DUPLICATE_DISPOSITION'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_CONFIG'
  | 'ID_FORMAT'
  | 'CONFIG_REJECTED'
  | 'CONFIG_SHAPE'
  | 'FIXTURE_DIR_MISSING'
  | 'FIXTURE_MISSING'
  | 'PROVENANCE_INVALID'
  | 'HASH_MISMATCH'
  | 'STATUS_CONSTANT_DISAGREES'
  | 'AUTH_DISAGREES'
  | 'ATTRIBUTION_UNSUPPORTED'
  | 'ATTRIBUTION_UNDECLARED'
  | 'EVIDENCE_TOKEN_MISSING'
  | 'OWNER_NOT_IN_EVIDENCE'
  | 'QUOTA_INCONSISTENT'
  | 'CADENCE_INVALID'
  | 'REASON_TOO_LONG'
  | 'DEADLINE_DISAGREES'

/** Every refusal the manifest makes carries a code a test can assert on, not a message to match. */
export class ManifestError extends Error {
  constructor(
    readonly code: ManifestErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ManifestError'
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type Permission = (typeof PERMISSIONS)[number]

/**
 * Weakest first. A source's permission is the WEAKEST of its fixtures': a single `UNCLEAR` capture
 * is the repository saying that the source is not cleared, however many documented ones sit beside
 * it.
 */
export const PERMISSION_STRENGTH: readonly Permission[] = [
  'PROHIBITED',
  'UNCLEAR',
  'KEY_REQUIRED',
  'PUBLIC_FEED',
  'PUBLIC_API_DOCUMENTED',
]

export const READY_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'PUBLIC_FEED',
  'PUBLIC_API_DOCUMENTED',
])

export type OwnershipEvidence = 'PAYLOAD_FIELD' | 'TEXT_FULL' | 'TEXT_PARTIAL'

/** Strongest first. Only the first two let a manifest call an employer verified. */
export const OWNERSHIP_STRENGTH: readonly OwnershipEvidence[] = [
  'PAYLOAD_FIELD',
  'TEXT_FULL',
  'TEXT_PARTIAL',
]

/** What a provider's module says about itself (`REMOTIVE_SOURCE_STATUS` and its siblings). */
export interface StatusConstant {
  readonly blocked: boolean
  readonly permission: Permission
  readonly reason: string
}

export type BlockerCode =
  | 'NO_ADAPTER'
  | 'PERMISSION_PROHIBITED'
  | 'PERMISSION_UNCLEAR'
  | 'KEY_REQUIRED'
  | 'NO_CAPTURE'
  | 'STATUS_CONSTANT_BLOCKED'
  | 'AUTH_DEADLINE_PASSED'
  | 'POLICY_EXPIRED'

export interface Blocker {
  readonly code: BlockerCode
  readonly detail: string
}

/** A date from which a permission changes. `at` is READ from the adapter's own constant. */
export interface PolicyDeadline {
  readonly kind: 'AUTH_REQUIRED_FROM' | 'POLICY_EXPIRES'
  readonly at: Date
  /** The exported symbol `at` was read from, so a reader can find the one place the date lives. */
  readonly symbol: string
}

export type AuthRequirement = 'NONE' | 'API_KEY' | 'EMPLOYER_TOKEN_FROM_DEADLINE'
export type Attribution = 'LINK_BACK_REQUIRED' | 'CREDIT_REQUIRED' | 'NONE_RECORDED'

/** How the source is walked. Actual COVERAGE is derived per run by the base, never declared here. */
export type ScopeKind =
  | 'BOARD'
  | 'LATEST_FEED'
  | 'FEED_WINDOW'
  | 'PAGED_FEED'
  | 'CATEGORY'
  | 'THREAD'
  | 'SEARCH'
  | 'BROWSE'

export interface QuotaDeclaration {
  /** Never a credential: the same alphabet as `job_account_meters.account_key`. */
  readonly account: string
  readonly unit: JobMeterUnit
  /** `null` window and limit together: the provider publishes none, and nobody has invented one. */
  readonly window: JobMeterWindow | null
  readonly limit: number | null
  readonly limitSource: string
}

export type DispositionDefinition =
  | { readonly kind: 'IMPLEMENTED'; readonly contract: 'REPORTING' }
  | { readonly kind: 'IMPLEMENTED'; readonly contract: 'LEGACY'; readonly note: string }
  | { readonly kind: 'BLOCKED'; readonly reason: string; readonly owner: string }

/** True for a type implemented on the reporting contract: the only kind that carries entries. */
export function isReporting(d: DispositionDefinition): boolean {
  return d.kind === 'IMPLEMENTED' && d.contract === 'REPORTING'
}

export interface BudgetDeclaration {
  readonly limit: number
  readonly window: 'DAY' | 'MONTH'
}

export interface EntryDefinition {
  /** The durable identity (`job_sources.manifest_id`). Stable across config revisions. */
  readonly id: string
  /** What `job_sources.config` stores: NO `configVersion` (its own column) and NO derived namespace. */
  readonly config: Readonly<Record<string, unknown>>
  readonly configVersion?: number
  /** True when the 2026-10-05 seed already holds this exact `(type, config)` row. */
  readonly legacySeed?: boolean
  readonly intervalHours: number
  readonly budget?: BudgetDeclaration
  /**
   * Ownership of an ATS board. `fixtures` are the file names under the type's fixture directory
   * (provenance names without `.provenance.json`'s stem rule applied) whose notes carry the
   * `EVIDENCE:` token. `name`/`domain` are the employer as the entry CLAIMS it; whether that claim
   * is verified is read from the evidence, not stated here.
   */
  readonly ownership?: {
    readonly fixtures: readonly string[]
    readonly name: string
    readonly domain: string | null
  }
}

export interface TypeDefinition {
  /** A `string` so that a name the schema does not know can reach the builder and be refused. */
  readonly type: string
  readonly provider: string
  readonly disposition: DispositionDefinition
  /** The directory under `__fixtures__` holding this type's captures. Absent: nothing was captured. */
  readonly fixtureDir?: string
  readonly status?: { readonly symbol: string; readonly value: StatusConstant }
  readonly deadlines?: readonly PolicyDeadline[]
  readonly auth: AuthRequirement
  readonly attribution: Attribution
  readonly endpointVariant: string
  readonly scopeKind: ScopeKind
  /** A floor the provider's own terms set on the interval between two collections, if any. */
  readonly minIntervalHoursFloor?: number
  readonly requestsPerRun?: number
  readonly quota?: QuotaDeclaration
  readonly entries: readonly EntryDefinition[]
}

// ---------------------------------------------------------------------------
// Provenance reading
// ---------------------------------------------------------------------------

/** sha256 of zero bytes: a provenance file that says no byte was received. Pinned against `createHash` in the spec. */
export const SHA256_OF_NOTHING = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const EPOCH = '1970-01-01T00:00:00.000Z'

export type EvidenceKind = 'CAPTURE' | 'SENTINEL'

/**
 * A provenance file can say "nothing was captured" (`__fixtures__/README.md`, "A unit example").
 * ANY of the markers makes it a sentinel, deliberately the OR and not the AND: an epoch with a real
 * looking status, or a real timestamp with the empty hash, is a file somebody half-edited, and a
 * half-edited file must not read as a capture. Flipping a sentinel therefore means flipping all of
 * them, which is also what a real capture replacing it looks like.
 */
export function evidenceKindOf(p: Provenance): EvidenceKind {
  const sentinel =
    p.fetchedAt === EPOCH ||
    p.termsCheckedAt === EPOCH ||
    p.httpStatus === 0 ||
    p.rawSha256 === SHA256_OF_NOTHING ||
    p.notes.startsWith('SENTINEL:') ||
    p.trimmedBy.startsWith('none: written by hand')
  return sentinel ? 'SENTINEL' : 'CAPTURE'
}

const OWNERSHIP_TOKEN = /EVIDENCE: (PAYLOAD_FIELD|TEXT_FULL|TEXT_PARTIAL)/

export function ownershipEvidenceOf(notes: string): OwnershipEvidence | null {
  return (OWNERSHIP_TOKEN.exec(notes)?.[1] as OwnershipEvidence | undefined) ?? null
}

export interface OwnershipCount {
  readonly matched: number
  readonly total: number
}

/**
 * The count a provenance file states for its ownership claim: "87 of the 90 postings", "34 of 34
 * jobs", "all 12 postings". `null` when the sentence is none of those: an unparsed count is
 * unknown, never zero. The adapter specs read this instead of keeping their own copy of the figure
 * (all three of Lever's had drifted once).
 */
export function ownershipCountOf(notes: string): OwnershipCount | null {
  const ownership = notes.slice(notes.indexOf('OWNERSHIP') === -1 ? 0 : notes.indexOf('OWNERSHIP'))
  const ofTotal = /(\d+) of (?:the )?(\d+) (?:postings|jobs)\b/.exec(ownership)
  if (ofTotal) return { matched: Number(ofTotal[1]), total: Number(ofTotal[2]) }
  const all = /\ball (\d+) (?:postings|jobs)\b/.exec(ownership)
  if (all) return { matched: Number(all[1]), total: Number(all[1]) }
  return null
}

export interface FixtureRecord {
  /** `<dir>/<file>`, relative to the fixture root. */
  readonly path: string
  readonly file: string
  readonly provenanceFile: string
  readonly fileSha256: string
  readonly provenanceSha256: string
  readonly permission: Permission
  readonly evidence: EvidenceKind
  readonly termsUrl: string
  /** `null` for a sentinel: the terms were never read. */
  readonly termsCheckedAt: string | null
  readonly httpStatus: number
  readonly notes: string
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const isProvenance = (f: string): boolean => f.endsWith('.provenance.json')
/** The provenance name strips the LAST extension only: `terms.html.txt` -> `terms.html`. */
const stemOf = (file: string): string => file.slice(0, file.lastIndexOf('.'))

function readFixtureDir(root: string, dir: string): FixtureRecord[] {
  const path = join(root, dir)
  if (!existsSync(path))
    throw new ManifestError('FIXTURE_DIR_MISSING', `${dir} is not under the fixture root`)
  const names = readdirSync(path)
  const records: FixtureRecord[] = []
  // Stryker disable next-line MethodExpression: `.sort()` makes the record order independent of the directory listing order; a filesystem that already lists sorted (macOS, most CI images) makes the mutant unobservable, and no test can choose the listing order of a real directory
  for (const file of names.filter((n) => !isProvenance(n)).sort()) {
    const provenanceFile = `${stemOf(file)}.provenance.json`
    if (!names.includes(provenanceFile)) {
      throw new ManifestError('FIXTURE_MISSING', `${dir}/${file} has no ${provenanceFile}`)
    }
    const provenanceBytes = readFileSync(join(path, provenanceFile))
    const parsed = provenanceSchema.safeParse(JSON.parse(provenanceBytes.toString('utf8')))
    if (!parsed.success) {
      throw new ManifestError(
        'PROVENANCE_INVALID',
        `${dir}/${provenanceFile}: ${parsed.error.message}`,
      )
    }
    const p = parsed.data
    const fileSha256 = sha256(readFileSync(join(path, file)))
    if (fileSha256 !== p.fileSha256) {
      throw new ManifestError(
        'HASH_MISMATCH',
        `${dir}/${file}: committed bytes hash to ${fileSha256}, provenance says ${p.fileSha256}`,
      )
    }
    const evidence = evidenceKindOf(p)
    records.push({
      path: `${dir}/${file}`,
      file,
      provenanceFile,
      fileSha256,
      provenanceSha256: sha256(provenanceBytes),
      permission: p.permission,
      evidence,
      termsUrl: p.termsUrl,
      // The epoch is "never", not a date: the terms were not read.
      termsCheckedAt: p.termsCheckedAt === EPOCH ? null : p.termsCheckedAt,
      httpStatus: p.httpStatus,
      notes: p.notes,
    })
  }
  for (const n of names.filter(isProvenance)) {
    if (!records.some((r) => r.provenanceFile === n)) {
      throw new ManifestError('FIXTURE_MISSING', `${dir}/${n} has no fixture beside it`)
    }
  }
  return records
}

// ---------------------------------------------------------------------------
// The built manifest
// ---------------------------------------------------------------------------

export type ReadinessStatus = 'CANDIDATE' | 'BLOCKED' | 'LEGACY'

export interface OwnershipRecord {
  readonly claimedName: string
  readonly claimedDomain: string | null
  /** The weakest `EVIDENCE:` token across the entry's fixtures. */
  readonly strength: OwnershipEvidence
  /** `PAYLOAD_FIELD` and `TEXT_FULL` only. A `TEXT_PARTIAL` claim is never recorded as verified. */
  readonly verified: boolean
  readonly count: OwnershipCount | null
  readonly fixtures: readonly string[]
}

export interface ManifestEntry {
  readonly id: string
  readonly type: JobSourceType
  /** What is stored in `job_sources.config`. */
  readonly config: Readonly<Record<string, unknown>>
  readonly configVersion: number
  readonly manifestVersion: number
  readonly policyVersion: number
  /** The adapter's own parse of `config` + `configVersion`: where `namespace` comes from. */
  readonly namespace: string
  readonly legacySeed: boolean
  readonly intervalHours: number
  readonly budget: BudgetDeclaration | null
  readonly ownership: OwnershipRecord | null
  /** The employer, only when its ownership is verified. `null` is not "unknown employer". */
  readonly verifiedEmployer: { readonly name: string; readonly domain: string | null } | null
  readonly blockers: readonly Blocker[]
  readonly deadlines: readonly PolicyDeadline[]
}

export interface ManifestType {
  readonly type: JobSourceType
  readonly provider: string
  readonly disposition: DispositionDefinition
  readonly fixtures: readonly FixtureRecord[]
  readonly permission: Permission | null
  readonly policyRefs: readonly {
    readonly termsUrl: string
    readonly termsCheckedAt: string | null
  }[]
  readonly auth: AuthRequirement
  readonly attribution: Attribution
  readonly endpointVariant: string
  readonly scopeKind: ScopeKind
  /** Requests one scheduled run may send: the multiplier the quota arithmetic needs. */
  readonly requestsPerRun: number
  readonly quota: QuotaDeclaration | null
  readonly status: { readonly symbol: string; readonly value: StatusConstant } | null
  readonly blockers: readonly Blocker[]
  readonly deadlines: readonly PolicyDeadline[]
  /** True when EVERY fixture is a real capture; a source with no fixture at all is not verified. */
  readonly payloadVerified: boolean
}

export interface Manifest {
  readonly types: readonly ManifestType[]
  readonly entries: readonly ManifestEntry[]
}

export interface BuildInput {
  readonly definitions: readonly TypeDefinition[]
  /** Validation only. This is NOT a registry and nothing in the pipeline may import it. */
  readonly adapters: ReadonlyMap<
    JobSourceType,
    Pick<ReportingJobSourceProvider, 'type' | 'parseConfig'>
  >
  readonly fixtureRoot: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/
const UNBROKEN_RUN = /[a-z0-9]{24}/
export const READINESS_REASON_MAX_CHARS = 500
const MONTH_HOURS = 30 * 24

/** Canonical JSON (keys sorted at every depth): two configs equal as jsonb are equal here. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const weakest = <T>(order: readonly T[], values: readonly T[]): T | undefined =>
  order.find((o) => values.includes(o))

function permissionBlockers(permissions: readonly Permission[]): Blocker[] {
  const out: Blocker[] = []
  if (permissions.includes('PROHIBITED')) {
    out.push({ code: 'PERMISSION_PROHIBITED', detail: 'a fixture records permission PROHIBITED' })
  }
  if (permissions.includes('UNCLEAR')) {
    out.push({ code: 'PERMISSION_UNCLEAR', detail: 'a fixture records permission UNCLEAR' })
  }
  if (permissions.includes('KEY_REQUIRED')) {
    out.push({ code: 'KEY_REQUIRED', detail: 'a fixture records permission KEY_REQUIRED' })
  }
  return out
}

function checkId(id: string): void {
  if (!ID_PATTERN.test(id) || UNBROKEN_RUN.test(id)) {
    throw new ManifestError(
      'ID_FORMAT',
      `${JSON.stringify(id)} must match ${ID_PATTERN} and contain no unbroken run of 24 lowercase alphanumerics`,
    )
  }
}

function reconcileStatus(def: TypeDefinition, permission: Permission | null): Blocker[] {
  if (def.status === undefined) return []
  const { symbol, value } = def.status
  if (permission === null) {
    throw new ManifestError(
      'STATUS_CONSTANT_DISAGREES',
      `${symbol} exists but ${def.type} has no fixture to reconcile it with`,
    )
  }
  // The permission FIELDS must agree: neither is allowed to win. The `blocked` flag may only
  // tighten (Arbeitnow is permitted and blocked at once), never loosen what the provenance says.
  if (value.permission !== permission) {
    throw new ManifestError(
      'STATUS_CONSTANT_DISAGREES',
      `${symbol}.permission is ${value.permission} but the provenance of ${def.type} says ${permission}`,
    )
  }
  if (!value.blocked && !READY_PERMISSIONS.has(permission)) {
    throw new ManifestError(
      'STATUS_CONSTANT_DISAGREES',
      `${symbol}.blocked is false but the provenance permission ${permission} is not a ready one`,
    )
  }
  return value.blocked ? [{ code: 'STATUS_CONSTANT_BLOCKED', detail: value.reason }] : []
}

function checkAuth(def: TypeDefinition, permissions: readonly Permission[]): void {
  const keyed = permissions.includes('KEY_REQUIRED')
  if (keyed !== (def.auth === 'API_KEY')) {
    throw new ManifestError(
      'AUTH_DISAGREES',
      `${def.type}: auth ${def.auth} against provenance permissions ${permissions.join(',') || 'none'}`,
    )
  }
  const deadlineAuth = def.deadlines?.some((d) => d.kind === 'AUTH_REQUIRED_FROM') === true
  if (deadlineAuth !== (def.auth === 'EMPLOYER_TOKEN_FROM_DEADLINE')) {
    throw new ManifestError(
      'DEADLINE_DISAGREES',
      `${def.type}: auth ${def.auth} does not match its AUTH_REQUIRED_FROM deadline`,
    )
  }
}

const ATTRIBUTION_NOTE = /link back|credit\/link|clearly credit/i

function checkAttribution(def: TypeDefinition, fixtures: readonly FixtureRecord[]): void {
  const stated = fixtures.some((f) => ATTRIBUTION_NOTE.test(f.notes))
  if (def.attribution !== 'NONE_RECORDED' && !stated) {
    throw new ManifestError(
      'ATTRIBUTION_UNSUPPORTED',
      `${def.type} declares ${def.attribution} and no provenance note records an obligation`,
    )
  }
  if (def.attribution === 'NONE_RECORDED' && stated) {
    throw new ManifestError(
      'ATTRIBUTION_UNDECLARED',
      `${def.type} declares no attribution and a provenance note records one`,
    )
  }
}

function checkQuota(types: readonly ManifestType[], entries: readonly ManifestEntry[]): void {
  const accounts = new Map<string, QuotaDeclaration>()
  for (const t of types) {
    if (t.quota === null) continue
    const q = t.quota
    if ((q.limit === null) !== (q.window === null)) {
      throw new ManifestError(
        'QUOTA_INCONSISTENT',
        `${q.account}: limit and window are both set or both null`,
      )
    }
    if (q.limit !== null && (!Number.isInteger(q.limit) || q.limit < 0)) {
      throw new ManifestError(
        'QUOTA_INCONSISTENT',
        `${q.account}: limit ${q.limit} is not a non-negative integer`,
      )
    }
    const prior = accounts.get(q.account)
    // One account is one counter in one unit: a RECORD source and a REQUEST source on the same
    // account would be two different quantities summed (or, worse, one hidden from the other).
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(q)) {
      throw new ManifestError(
        'QUOTA_INCONSISTENT',
        `${q.account} is declared twice with different terms`,
      )
    }
    accounts.set(q.account, q)
  }
  // An account SHARED by several types must be declared on every one of them, identically; the
  // loop above already refuses differing terms. Now the arithmetic: what the schedule asks of an
  // account in a month, against the figure the PROVIDER publishes (never a sum of seed rows).
  for (const [account, q] of accounts) {
    const owners = types.filter((t) => t.quota?.account === account)
    // A MONTH window has a limit: the check above refuses one without.
    if (q.window !== 'MONTH') continue
    const limit = q.limit!
    // The requests one run of each owning type sends; an entry of any other type is not this account's.
    const perRun = new Map(owners.map((o) => [o.type, o.requestsPerRun]))
    const perMonth = entries.reduce((sum, e) => {
      const n = perRun.get(e.type)
      return n === undefined ? sum : sum + Math.floor(MONTH_HOURS / e.intervalHours) * n
    }, 0)
    if (q.unit === 'REQUEST' && perMonth > limit) {
      throw new ManifestError(
        'QUOTA_INCONSISTENT',
        `${account}: the schedule needs ${perMonth} requests a month against a limit of ${limit}`,
      )
    }
  }
}

function checkCadence(def: TypeDefinition, e: EntryDefinition): void {
  if (!Number.isInteger(e.intervalHours) || e.intervalHours < 1) {
    throw new ManifestError(
      'CADENCE_INVALID',
      `${e.id}: intervalHours ${e.intervalHours} is not a positive integer`,
    )
  }
  const floor = def.minIntervalHoursFloor ?? 0
  if (e.intervalHours < floor) {
    throw new ManifestError(
      'CADENCE_INVALID',
      `${e.id}: ${e.intervalHours} h is under the ${floor} h the provider's terms allow`,
    )
  }
  if (e.budget !== undefined) {
    // The schedule has to fit the entry's OWN budget in the window the budget is counted over.
    const unit = e.budget.window === 'DAY' ? 'day' : 'month'
    const runs = Math.floor((e.budget.window === 'DAY' ? 24 : MONTH_HOURS) / e.intervalHours)
    if (runs > e.budget.limit) {
      throw new ManifestError(
        'CADENCE_INVALID',
        `${e.id}: ${runs} scheduled runs a ${unit} exceed its own budget of ${e.budget.limit}`,
      )
    }
  }
}

function ownershipOf(
  def: TypeDefinition,
  e: EntryDefinition,
  fixtures: readonly FixtureRecord[],
): OwnershipRecord | null {
  if (e.ownership === undefined) return null
  const named = e.ownership.fixtures.map((name) => {
    const f = fixtures.find((x) => x.file === name)
    if (f === undefined)
      throw new ManifestError(
        'FIXTURE_MISSING',
        `${e.id}: ownership fixture ${name} is not under ${def.fixtureDir}`,
      )
    return f
  })
  const tokens = named.map((f) => {
    const token = ownershipEvidenceOf(f.notes)
    if (token === null)
      throw new ManifestError('EVIDENCE_TOKEN_MISSING', `${f.path} carries no EVIDENCE: token`)
    return token
  })
  const strength = [...OWNERSHIP_STRENGTH].reverse().find((s) => tokens.includes(s))!
  const claimedLower = e.ownership.name.toLowerCase()
  if (!named.some((f) => f.notes.toLowerCase().includes(claimedLower))) {
    throw new ManifestError(
      'OWNER_NOT_IN_EVIDENCE',
      `${e.id}: "${e.ownership.name}" appears in none of its fixtures' notes`,
    )
  }
  if (e.ownership.domain !== null && !named.some((f) => f.notes.includes(e.ownership!.domain!))) {
    throw new ManifestError(
      'OWNER_NOT_IN_EVIDENCE',
      `${e.id}: domain ${e.ownership.domain} appears in none of its fixtures' notes`,
    )
  }
  const first = named[0]!
  return {
    claimedName: e.ownership.name,
    claimedDomain: e.ownership.domain,
    strength,
    verified: strength === 'PAYLOAD_FIELD' || strength === 'TEXT_FULL',
    count: ownershipCountOf(first.notes),
    fixtures: e.ownership.fixtures,
  }
}

/** The sentence an ATS config carries as `employer.evidence`, built from what was read. */
export function employerEvidenceText(o: OwnershipRecord): string {
  const count = o.count === null ? '' : ` (${o.count.matched} of ${o.count.total})`
  return `${o.strength}${count}`
}

export function buildManifest(input: BuildInput): Manifest {
  const known = new Set<string>(jobSourceTypeSchema.options)
  const seenTypes = new Set<string>()
  const types: ManifestType[] = []
  const entries: ManifestEntry[] = []
  const ids = new Set<string>()
  const configKeys = new Set<string>()

  for (const def of input.definitions) {
    if (!known.has(def.type))
      throw new ManifestError('UNKNOWN_PROVIDER', `${def.type} is not a JobSourceType`)
    if (seenTypes.has(def.type))
      throw new ManifestError('DUPLICATE_DISPOSITION', `${def.type} has two dispositions`)
    seenTypes.add(def.type)
    const type = def.type as JobSourceType

    const reporting = isReporting(def.disposition)
    const adapter = input.adapters.get(type)
    if (reporting) {
      if (adapter === undefined) {
        throw new ManifestError(
          'NO_ADAPTER',
          `${type} is declared implemented and no adapter was supplied`,
        )
      }
      if (adapter.type !== type) {
        throw new ManifestError(
          'UNKNOWN_PROVIDER',
          `the adapter supplied for ${type} says it is ${adapter.type}`,
        )
      }
    }
    if (!reporting && def.entries.length > 0) {
      throw new ManifestError(
        'NO_ADAPTER',
        `${type} is not implemented on the reporting contract and cannot carry entries`,
      )
    }

    const fixtures =
      def.fixtureDir === undefined ? [] : readFixtureDir(input.fixtureRoot, def.fixtureDir)
    const permissions = [...new Set(fixtures.map((f) => f.permission))]
    const permission = weakest(PERMISSION_STRENGTH, permissions) ?? null
    checkAuth(def, permissions)
    checkAttribution(def, fixtures)

    const blockers: Blocker[] = []
    if (def.disposition.kind === 'BLOCKED') {
      blockers.push({ code: 'NO_ADAPTER', detail: def.disposition.reason })
    }
    if (reporting) {
      blockers.push(...permissionBlockers(permissions))
      // Vacuously true for a source with no fixture at all: it has no capture either.
      if (fixtures.every((f) => f.evidence === 'SENTINEL')) {
        blockers.push({
          code: 'NO_CAPTURE',
          detail:
            fixtures.length === 0
              ? 'no fixture was committed'
              : 'every fixture is a hand-written unit example',
        })
      }
      blockers.push(...reconcileStatus(def, permission))
    }
    const reason = blockers.map((b) => `${b.code}: ${b.detail}`).join('; ')
    if (reason.length > READINESS_REASON_MAX_CHARS) {
      throw new ManifestError(
        'REASON_TOO_LONG',
        `${type}: readiness reason is ${reason.length} characters`,
      )
    }

    const policyRefs = [
      ...new Map(
        fixtures.map((f) => [
          `${f.termsUrl}|${f.termsCheckedAt}`,
          { termsUrl: f.termsUrl, termsCheckedAt: f.termsCheckedAt },
        ]),
      ).values(),
    ]
    types.push({
      type,
      provider: def.provider,
      disposition: def.disposition,
      fixtures,
      permission,
      policyRefs,
      auth: def.auth,
      attribution: def.attribution,
      endpointVariant: def.endpointVariant,
      scopeKind: def.scopeKind,
      requestsPerRun: def.requestsPerRun ?? 1,
      quota: def.quota ?? null,
      status: def.status ?? null,
      blockers,
      deadlines: def.deadlines ?? [],
      payloadVerified: fixtures.length > 0 && fixtures.every((f) => f.evidence === 'CAPTURE'),
    })

    for (const e of def.entries) {
      checkId(e.id)
      if (ids.has(e.id)) throw new ManifestError('DUPLICATE_ID', `${e.id} is declared twice`)
      ids.add(e.id)
      checkCadence(def, e)
      const ownership = ownershipOf(def, e, fixtures)
      const config: Record<string, unknown> = { ...e.config }
      if (ownership !== null) {
        config['employer'] = {
          name: ownership.claimedName,
          domain: ownership.claimedDomain,
          evidence: employerEvidenceText(ownership),
        }
      }
      if ('configVersion' in config || 'namespace' in config) {
        throw new ManifestError(
          'CONFIG_SHAPE',
          `${e.id}: config stores neither configVersion (a column) nor namespace (derived)`,
        )
      }
      const key = `${type}|${canonicalJson(config)}`
      if (configKeys.has(key))
        throw new ManifestError(
          'DUPLICATE_CONFIG',
          `${e.id} repeats another entry's (type, config)`,
        )
      configKeys.add(key)
      const configVersion = e.configVersion ?? 1
      let namespace: string
      try {
        // The adapter's OWN instance method, on the config as the adapter will receive it.
        const parsed = adapter!.parseConfig({ ...config, configVersion }) as { namespace: string }
        namespace = parsed.namespace
      } catch (err) {
        throw new ManifestError(
          'CONFIG_REJECTED',
          `${e.id}: ${(err as Error).message.slice(0, 300)}`,
        )
      }
      entries.push({
        id: e.id,
        type,
        config,
        configVersion,
        manifestVersion: 1,
        policyVersion: 1,
        namespace,
        legacySeed: e.legacySeed === true,
        intervalHours: e.intervalHours,
        budget: e.budget ?? null,
        ownership,
        verifiedEmployer:
          ownership !== null && ownership.verified
            ? { name: ownership.claimedName, domain: ownership.claimedDomain }
            : null,
        blockers,
        deadlines: def.deadlines ?? [],
      })
    }
  }

  for (const t of jobSourceTypeSchema.options) {
    if (!seenTypes.has(t)) throw new ManifestError('MISSING_DISPOSITION', `${t} has no disposition`)
  }
  checkQuota(types, entries)
  return { types, entries }
}

// ---------------------------------------------------------------------------
// Readiness at a clock
// ---------------------------------------------------------------------------

export interface Readiness {
  readonly status: ReadinessStatus
  readonly blockers: readonly Blocker[]
}

/**
 * Readiness of a type or an entry at `now`. `>=` on purpose, mirroring the adapter: Recruitee's own
 * test pins "exactly at the deadline" as already refused, and a manifest that said "ready" for one
 * more millisecond than the adapter would be the disagreement this exists to prevent.
 */
export function readinessAt(
  subject: Pick<ManifestType | ManifestEntry, 'blockers' | 'deadlines'> & {
    disposition?: DispositionDefinition
  },
  now: Date,
): Readiness {
  if (subject.disposition?.kind === 'IMPLEMENTED' && subject.disposition.contract === 'LEGACY') {
    return { status: 'LEGACY', blockers: [] }
  }
  const timed: Blocker[] = subject.deadlines
    .filter((d) => now.getTime() >= d.at.getTime())
    .map((d) =>
      d.kind === 'AUTH_REQUIRED_FROM'
        ? {
            code: 'AUTH_DEADLINE_PASSED' as const,
            detail: `credentials the collector cannot hold are required from ${d.at.toISOString()} (${d.symbol})`,
          }
        : {
            code: 'POLICY_EXPIRED' as const,
            detail: `the policy lapsed at ${d.at.toISOString()} (${d.symbol})`,
          },
    )
  const blockers = [...subject.blockers, ...timed]
  return { status: blockers.length === 0 ? 'CANDIDATE' : 'BLOCKED', blockers }
}

export const readinessReason = (r: Readiness): string | null =>
  r.blockers.length === 0 ? null : r.blockers.map((b) => `${b.code}: ${b.detail}`).join('; ')
