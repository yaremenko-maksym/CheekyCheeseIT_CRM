import type { JobCollectionCoverage, JobCollectionOutcome, JobMeterUnit } from '@crm/shared'
import { z } from 'zod'
import type { SourceObservation } from '../normalize/observation'

/**
 * The REPORTING provider contract (Task 2.3). A second, richer interface ALONGSIDE
 * `JobSourceProvider` in `../job-source.provider.ts` — the array contract (`collect` ->
 * `NormalizedPosting[]`) is deliberately NOT widened in place. DOU keeps the legacy one; Task 2.5
 * wraps it in an explicit legacy adapter.
 *
 * Every one of phase 3's ~25 adapters binds to `CollectionBatch`, so a field shaped badly here is
 * paid for 25 times. Two consequences the shapes below are built around:
 *
 * 1. THE PHASE-1 STORE OWNS THE VOCABULARY. Its schemas shipped and have production rows, so the
 *    outcome and coverage vocabularies are IMPORTED from `@crm/shared` and narrowed with `Exclude`,
 *    never retyped. Task 2.1's worst defect was a parallel vocabulary (`'NATIVE' | 'URL'` against
 *    the store's `'NATIVE_ID' | 'URL_FALLBACK'`) that a type cast kept from the compiler.
 * 2. OUTCOME AND COVERAGE ARE DERIVED, NEVER SUPPLIED. No adapter and no caller writes them; the
 *    collection loop computes them from what actually happened (`deriveOutcome` / `deriveCoverage`)
 *    and `buildCollectionBatch` is the only producer of a `CollectionBatch`. That is what makes
 *    "a failure never reports SUCCEEDED and never reports FULL_INVENTORY" structural rather than a
 *    rule each adapter author has to remember.
 */

/**
 * A BATCH is terminal by definition: it is what a finished attempt returns. The store's enum also
 * carries `STARTED` for a running attempt, which a returned batch can never be — so the batch's
 * vocabulary is the store's MINUS that one member, derived from it rather than written out.
 * `reporting-provider.store-conformance.spec.ts` pins that this `Exclude` still names exactly the
 * store's terminal members, so adding a sixth outcome upstream fails a test here.
 */
export type CollectionOutcome = Exclude<JobCollectionOutcome, 'STARTED'>

/** Imported wholesale: a provider has no coverage vocabulary of its own. */
export type CollectionCoverage = JobCollectionCoverage

/**
 * The error codes this base emits. The store deliberately keeps `jobErrorCodeSchema` OPEN (a
 * regex, not an enum) because the vocabulary is per adapter — so the closed set lives here, where
 * it is actually closed, and the conformance spec parses every member through the store's regex.
 *
 * `PERSISTENCE` is listed apart from `INVALID_RECORD` on purpose: a database failure is OUR fault
 * and must never be counted as a bad provider record (AC3).
 */
export const COLLECTION_ERROR_CODES = [
  'ACCESS_POLICY',
  'RATE_LIMIT',
  'TRANSIENT_NETWORK',
  'UPSTREAM',
  'PARSE_DRIFT',
  'INVALID_RECORD',
  'PERSISTENCE',
  'COST_STOP',
  'CANCELLED',
  'DEADLINE',
  'PAGE_CAP',
  'CURSOR_CYCLE',
  'PAYLOAD_TOO_LARGE',
  'ADAPTER_INVARIANT',
] as const

export type CollectionErrorCode = (typeof COLLECTION_ERROR_CODES)[number]

/** The redaction placeholder. Asserted BY NAME in tests, so both halves of "the key is gone and
 * something marks where it was" are checkable. */
export const REDACTED = '[REDACTED]'

/**
 * The brands that make construction the ONLY path.
 *
 * `buildCollectionBatch` called itself "the ONLY producer of a `CollectionBatch`" while
 * `CollectionBatch` was a plain exported interface — so any of phase 3's ~25 adapters could
 * implement `ReportingJobSourceProvider` and return an object literal, and `assertBatchInvariant`
 * would simply never run. A comment claiming exclusivity over a structural type is a convention,
 * and a convention held by 25 authors is a hope. The brand is the same device already used for
 * `Validated<T>`, applied to the thing the AC1 invariant actually lives on.
 *
 * Both symbols are module-private and both properties are installed non-enumerable, so neither
 * reaches `JSON.stringify`, a log line, or a database row.
 */
const BATCH_BUILT: unique symbol = Symbol('crm.jobSourcing.batchBuilt')
const REPORT_BUILT: unique symbol = Symbol('crm.jobSourcing.requestReportBuilt')

/** A sample of a refused item is bounded to this many characters before it is ever reported. */
export const MAX_SAMPLE_CHARS = 200

/** At most this many refused items are sampled per attempt, whatever the batch size. */
export const MAX_SAMPLES = 5

/** At most this many request reports are retained per attempt (bounded telemetry). */
export const MAX_REQUEST_REPORTS = 200

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** The time window a scope asked for. A scope with a window can never claim FULL_INVENTORY. */
export interface CollectionWindow {
  from: Date
  to: Date
}

/**
 * WHAT was collected: which board, under which query, at which config version, over which window.
 * `namespace` is the store's own word for a board / account scope (`jobSourceIdentitySchema`), not
 * a synonym invented here.
 *
 * `query` being non-null is what makes a scope a SEARCH scope, and a search scope that hits the
 * page cap is a WINDOW rather than a truncated inventory (AC1). A full-inventory scope that hits
 * the cap is PARTIAL — we were supposed to see everything and did not.
 */
export interface SourceCoverageScope {
  namespace: string
  query: string | null
  configVersion: number
  window: CollectionWindow | null
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * The PROVIDER-SIDE dispositions. Deliberately NOT the store's seven
 * (`created/revised/unchanged/duplicates/...`): those are persistence outcomes the collector
 * decides in Task 2.5, and a provider that reported them would be guessing.
 *
 * - `raw`        — items the provider handed us, before any validation
 * - `normalized` — items that became a `SourceObservation`
 * - `invalid`    — items the envelope or item schema refused, or whose mapper threw
 * - `quarantined`— items the observation builder refused (no identity, unsafe link, no title...)
 *
 * INVARIANT: `raw === normalized + invalid + quarantined`. Enforced by `assertCountsBalanced`,
 * which is what lets `toStoredReportCounts` hand the collector a `received` it can complete into a
 * report the store's own "exactly one disposition per received item" refine will accept.
 */
export interface CollectionCounts {
  raw: number
  normalized: number
  invalid: number
  quarantined: number
}

export class CountsImbalanceError extends Error {
  constructor(readonly counts: CollectionCounts) {
    super(
      `counts do not balance: raw=${counts.raw} != normalized=${counts.normalized} + invalid=${counts.invalid} + quarantined=${counts.quarantined}`,
    )
    this.name = 'CountsImbalanceError'
  }
}

export function assertCountsBalanced(counts: CollectionCounts): void {
  if (counts.raw !== counts.normalized + counts.invalid + counts.quarantined) {
    throw new CountsImbalanceError(counts)
  }
}

/**
 * The projection onto the store's report counts — the ONLY place the two count vocabularies meet,
 * and production code rather than a test helper, so the conformance spec checks a mapping the
 * system actually uses instead of one the test invented.
 *
 * Both of our refusal buckets land in the store's single `invalid`: from the store's point of view
 * an item it never received a row for is invalid, and it has no column for the distinction between
 * "the schema refused it" and "the identity seam refused it". The remaining store buckets
 * (`created/revised/unchanged/duplicates/persistenceErrors`) are the collector's to fill from
 * `normalized`, which is why they are absent here rather than zero.
 */
export function toStoredReportCounts(counts: CollectionCounts): {
  received: number
  invalid: number
  normalized: number
} {
  assertCountsBalanced(counts)
  return {
    received: counts.raw,
    invalid: counts.invalid + counts.quarantined,
    normalized: counts.normalized,
  }
}

// ---------------------------------------------------------------------------
// Request reports
// ---------------------------------------------------------------------------

/** What one subrequest cost, in the store's own meter units. */
export interface MeterCost {
  unit: JobMeterUnit
  amount: number
}

/**
 * One subrequest, as reported. Carries attempt, status, timestamps, error and metered cost — and
 * NO credentials: `url` and `error.message` pass through `redactSecrets` in
 * `buildRequestReport`, which is the only way to make one. A report assembled as a bare object
 * literal by an adapter would bypass that, which is why phase 3 adapters never build one: the
 * collection loop does.
 */
export interface RequestReportFields {
  /** 1-based retry ordinal of THIS subrequest. A retried page reports twice, not once. */
  attempt: number
  /** 1-based page ordinal within the attempt. */
  page: number
  /**
   * The request URL, credential-free — a claim `buildRequestReport` makes true rather than one the
   * caller has to. It is the reason this type is branded: a report assembled as a literal carries
   * whatever URL the adapter had, and the adapter had the credentialed one.
   */
  url: string
  /** HTTP status, or `null` when no response arrived (network failure, abort, deadline). */
  status: number | null
  startedAt: Date
  endedAt: Date
  error: { code: CollectionErrorCode; message: string } | null
  cost: MeterCost | null
}

/** Only `buildRequestReport` can make one — see the brand note on `CollectionBatch`. */
export type RequestReport = RequestReportFields & { readonly [REPORT_BUILT]: true }

/**
 * The query parameters whose VALUES are safe to report. An allowlist, not a denylist of
 * `token|key|secret`: the names a credential travels under are per provider and unknowable from
 * here, while the names that are genuinely boring are few and shared. Across 25 adapters a
 * denylist is a list of the leaks we happened to think of.
 *
 * EXPORTED so the tests can iterate it. Unexported, each of these thirty literals was a mutant no
 * assertion could reach: mutate `'per_page'` to `''` and nothing fails, because no test named
 * `per_page`. Thirty surviving mutants is the gate telling us the data was untested, not that the
 * gate was wrong — `reporting-provider.spec.ts` now drives both halves (every key keeps its value,
 * and a key NOT in the set loses it) off this export.
 */
export const REPORTABLE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'page',
  'per_page',
  'pagesize',
  'page_size',
  'limit',
  'offset',
  'start',
  'cursor',
  'after',
  'before',
  'q',
  'query',
  'search',
  'keywords',
  'sort',
  'order',
  'direction',
  'from',
  'to',
  'since',
  'until',
  'date',
  'updated_at',
  'location',
  'category',
  'remote',
  'format',
  'lang',
  'locale',
  'version',
  'v',
])

/**
 * THE INPUT BOUND, and why redaction needs one at all.
 *
 * Redaction runs on text DERIVED FROM UPSTREAM RESPONSES — a provider's error body, a refused
 * item's JSON — so its input length is chosen by the provider, not by us. The byte cap and the
 * page cap do not help: redaction happens after the bytes are already in hand.
 *
 * Every consumer in this module then truncates to `MAX_SAMPLE_CHARS` (200) or 500, so text beyond
 * this bound can never reach a report. Bounding the INPUT is therefore free, and it is the layer
 * that holds even if a future regex here is accidentally superlinear again.
 */
/**
 * 64 KiB — a DECISION, not an inheritance. It was briefly 1 MiB, which was wrong twice over: it
 * was chosen to make a timing test convenient, and it was raised 128× in the same change that
 * introduced a new quadratic regex behind it.
 *
 * Why 64 KiB: the largest thing this module ever EMITS is 500 characters (a request report's
 * message) or 200 (a sample), so 64 KiB is ~128× the biggest consumer — generous enough that a
 * verbose but legitimate provider error body or job posting is still redacted and sampled, while a
 * field above it is an anomaly rather than routine. It also sits three orders of magnitude below
 * the page byte cap (2 MiB), so "too long to redact" cannot be reached by a normal page.
 *
 * Why not larger: a 1 MiB error message in a report is its own problem independent of redaction
 * cost — it is telemetry nobody reads, stored per request.
 *
 * Why not smaller (16 KiB was considered): an oversized field is DROPPED, so the bound is also the
 * point at which we stop being able to diagnose a bad item at all. 16 KiB is within reach of one
 * verbose job posting, and losing the sample for exactly the items most worth inspecting is a poor
 * trade now that every pass behind this bound is linear.
 */
export const MAX_REDACTION_INPUT_CHARS = 65_536

/**
 * What a field becomes when it is too long to redact. A MARKER, not a truncation.
 *
 * THE PRINCIPLE THIS ENCODES: a bound that cannot be satisfied DROPS the field; it never emits a
 * partially-redacted one. Three bypasses in the first attempt at bounding this code all failed the
 * same way — open. `text.slice(0, bound)` before redaction can cut a registered secret in half,
 * and the surviving PREFIX matches no registered form, so it is emitted; a `{1,256}` quantifier
 * stops matching a 300-character password entirely, so the whole credential is emitted; a
 * `{4,1024}` token cap redacts the first 1024 characters and emits the tail. In each case the
 * input that defeats the bound is the input an attacker chooses.
 */
export const DROPPED_TOO_LONG = `${REDACTED} (field dropped: too long to redact)`

/**
 * `Basic`/`Bearer` and friends, wherever they appear — a header echoed into an error message is
 * the shape this catches. Structural: it does not need the credential to be registered.
 *
 * The token class admits `[` and `]` so that a token ALREADY half-replaced by the registered-secret
 * pass (`Basic [REDACTED]Omh1bnRlcjI=`, when `bob` is registered and its base64 prefix matched) is
 * still recognised as one token and removed whole. Registered secrets now run first — see
 * `redactSecrets` — so this is the normal case, not an edge one.
 *
 * WHY THIS ONE IS LINEAR and may stay a regex, unlike the three that were replaced. It is NOT the
 * «class»`+` followed by a delimiter shape: the quantified class is the LAST element, with nothing
 * after it to fail and force a retry, so once the class stops the match either succeeded or is
 * abandoned. The preceding `\s+` is quantified but its class is DISJOINT from the token class, so
 * giving back a whitespace character only exposes another whitespace character the token class
 * cannot accept either — one failed step, not a scan. And starts are anchored by a literal
 * alternation (`Basic|Bearer|Token|ApiKey`), so almost no position is even a candidate.
 *
 * The upper bound was deliberately REMOVED: `{4,1024}` redacted a long token's first 1024
 * characters and emitted the tail. Since the pattern is linear without a cap, the cap was pure
 * downside — it bought nothing and opened a bypass.
 */
const AUTH_SCHEME_RE = /\b(Basic|Bearer|Token|ApiKey)\s+([A-Za-z0-9+/=._~[\]-]{4,})/gi

/**
 * `user:password@` wherever it appears, not only where `URL` calls it userinfo.
 *
 * Found by one of this round's own tests rather than by a reviewer:
 * `bob:hunter2@api.example.com/x?token=abc123` PARSES — as scheme `bob:` with everything else in
 * an opaque path — so `URL.username` and `URL.password` are both empty, the structural userinfo
 * strip finds nothing, and `hunter2` reaches the report through the path. Redacting the shape
 * wherever it occurs costs us the occasional `a:b@c` in a path, which is the safe direction to err
 * in.
 *
 * IT IS A HAND-WRITTEN LINEAR SCAN RATHER THAN A REGEX, after this one pattern produced two
 * separate defects in two attempts:
 *
 *  1. As `([^\s:/?#@]+):([^\s:/?#@]+)@` it was QUADRATIC. On input shaped `'a:' + 'b'.repeat(n)`
 *     — allowed characters, one colon, no `@` — the second group scans to the end and backtracks
 *     one character at a time from every start position. Measured: 119 ms at 10 KB, 2 786 ms at
 *     50 KB, 11 773 ms at 100 KB, and this text comes from the provider's own error body, after
 *     the byte cap has already been spent. A hostile feed could hang the collector.
 *  2. Capping the quantifiers to `{1,256}` made it linear and opened a BYPASS: a 300-character
 *     password produces no match at all, so the entire credential is emitted verbatim. A
 *     300-character username matched but redacted only its last 256 characters — a partial leak
 *     that reads as success, because the output did change and the full credential is absent.
 *
 * The scan has neither problem and needs no cap: one pass, each character examined once, every
 * length handled. The cost is obvious from the code rather than from a measurement — which, having
 * been surprised by this pattern twice, is the property worth paying for.
 *
 * It redacts a slightly wider shape than the regex did (`a:b:c@` becomes one marker rather than
 * matching only `b:c@`). Redacting more is the safe direction.
 */
/**
 * What ends a run of candidate userinfo characters: whitespace, or any of `/ ? #`. `:` stays INSIDE
 * the run — it is the separator that makes the run a credential.
 *
 * A SET, exported, rather than the seven-way `||` this started as. That disjunction was data
 * wearing the clothes of logic: each comparison was a mutant no assertion reached, and the gate
 * reported twenty-six survivors on the one line. Exported so the test can assert the membership
 * against an independently written list AND exercise each delimiter's effect.
 */
export const USERINFO_RUN_DELIMITERS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '/',
  '?',
  '#',
])

function redactUserinfo(text: string): string {
  const out: string[] = []
  let copiedTo = 0
  let runStart = 0
  let runHasColon = false

  // Stryker disable next-line EqualityOperator: reading one past the end gives undefined, which matches neither '@' nor ':' and is not a run delimiter either, so the extra iteration appends nothing and the returned string is byte-identical for every input in this suite.
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '@') {
      // Stryker disable next-line ConditionalExpression,EqualityOperator: this length test is redundant given runHasColon, because runStart advances only on the two paths that also clear runHasColon (an at-sign and a delimiter), so an empty run carrying a colon is unreachable and no input can tell the two conditions apart.
      if (runHasColon && i > runStart) {
        out.push(text.slice(copiedTo, runStart), `${REDACTED}:${REDACTED}`)
        copiedTo = i
      }
      runStart = i + 1
      runHasColon = false
    } else if (ch === ':') {
      runHasColon = true
    } else if (USERINFO_RUN_DELIMITERS.has(ch ?? '')) {
      runStart = i + 1
      runHasColon = false
    }
  }
  out.push(text.slice(copiedTo))
  return out.join('')
}

/**
 * THE SHAPE THAT KEEPS PRODUCING QUADRATIC REGEXES, and the rule that replaces it.
 *
 * Three regexes in this file had the form «character class»`+` followed by a literal delimiter.
 * When the delimiter is ABSENT the class scans to the end of the input and then backtracks one
 * character per start position — quadratic, on text an attacker supplies for free. Measured:
 *
 *   `([^\s:/?#@]+):…@`      (userinfo)           11 773 ms at 100 KB of `'a:' + 'b'*n`
 *   `[a-z0-9+.-]*://…`      (this URL finder)     1 252 ms at  64 KB of `'a.'*n`
 *   `[.,;:!?]+$`            (trailing punctuation) 2 472 ms at  64 KB of `'.'*n + 'x'`
 *
 * THE RULE FOR THIS MODULE: find the delimiter with `indexOf`, then bound the walk. Linear, no
 * cap to get wrong, and the cost is legible from the code instead of from a measurement. The
 * userinfo scan above is the same move; these two are the remaining instances.
 *
 * The one regex that STAYS is `AUTH_SCHEME_RE` — see the linearity note on it.
 */

/** Scheme characters, as DATA so a test can cover them. `https`, `grpc+proto`, `x-my.scheme`. */
const SCHEME_CHARS: ReadonlySet<string> = new Set(
  'abcdefghijklmnopqrstuvwxyz0123456789+.-'.split(''),
)
/** A scheme must BEGIN with a letter: `1a://x` is not a URL. */
const SCHEME_FIRST_CHARS: ReadonlySet<string> = new Set('abcdefghijklmnopqrstuvwxyz'.split(''))
/**
 * The longest scheme we will walk back over. Real schemes are far shorter.
 *
 * It bounds how much preceding text can be absorbed into a URL span. A run of scheme characters
 * running into `://` is genuinely ambiguous — `qqqhttps` is a syntactically valid scheme — so there
 * is no principled split; this caps the damage at 32 characters instead of swallowing the whole
 * run, which is what the old `\b[a-z][a-z0-9+.-]*` did. Exported so the test can pin both sides.
 */
export const MAX_SCHEME_CHARS = 32
/** What ends a URL inside free text. Exported so a test can cover each one. */
export const URL_END_CHARS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '"',
  "'",
  '<',
  '>',
  '\\',
  ')',
  ']',
  '}',
])
/** Trailing punctuation that belongs to the sentence, not to the URL. */
export const URL_TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?'])

/**
 * Every `scheme://…` span in `text`, found by a single linear pass.
 *
 * Each `://` is located with `indexOf`, the scheme is read backwards over at most
 * `MAX_SCHEME_CHARS` characters, and the body is read forwards to the first terminator. Each
 * character is examined a bounded number of times, so the whole pass is linear in the input with
 * no backtracking anywhere.
 */
function findUrlSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let from = 0
  for (;;) {
    const sep = text.indexOf('://', from)
    if (sep === -1) return spans

    let start = sep
    while (
      // Stryker disable next-line ConditionalExpression,EqualityOperator: relaxing this bound reads text[-1], which is undefined, so SCHEME_CHARS.has('') is false and the backwards walk stops at the very same index; the guard documents the bound but cannot change where a scheme begins, so no input distinguishes the two.
      start > 0 &&
      sep - start < MAX_SCHEME_CHARS &&
      SCHEME_CHARS.has((text[start - 1] ?? '').toLowerCase())
    ) {
      start -= 1
    }
    // Trim any leading characters that cannot begin a scheme (`1a://`, `+x://`).
    // Stryker disable next-line ConditionalExpression,EqualityOperator: relaxing this bound lets the trim advance onto the separator itself, and the span test further down then rejects that span anyway, producing the identical result; both forms refuse a separator with no scheme letter before it.
    while (start < sep && !SCHEME_FIRST_CHARS.has((text[start] ?? '').toLowerCase())) {
      start += 1
    }

    // Stryker disable next-line StringLiteral: emptying this literal makes end start at the separator rather than after it, and the forward walk then crosses those same three characters because a colon and a slash are not terminators, so it halts at the identical index.
    let end = sep + '://'.length
    // Stryker disable next-line EqualityOperator: relaxing this bound reads one past the end, where the character is undefined and therefore not a terminator, and the resulting span is sliced against the string length anyway, so a one-too-far end yields the identical substring.
    while (end < text.length && !URL_END_CHARS.has(text[end] ?? '')) {
      end += 1
    }
    // Trailing sentence punctuation is not part of the URL. A loop, not `/[.,;:!?]+$/` — that
    // regex was the third quadratic instance in this file.
    // Stryker disable next-line ConditionalExpression,EqualityOperator: this lower bound is never approached, because the forward walk leaves end at least three characters past the separator and a slash is not trailing punctuation, so the trim always halts well above it and no input can reach the boundary itself.
    while (end > sep && URL_TRAILING_PUNCTUATION.has(text[end - 1] ?? '')) {
      end -= 1
    }

    // No scheme letter at all means this `://` is not a URL; skip past it rather than report one.
    if (start < sep) spans.push({ start, end })
    // Stryker disable next-line ArithmeticOperator,StringLiteral: this floor is never the larger operand, because end is always at least three characters past the separator by the walks above, so lowering the floor leaves the maximum unchanged and the scan resumes at the identical index.
    from = Math.max(end, sep + '://'.length)
  }
}

/**
 * Every written form the same secret can arrive in.
 *
 * Exact string matching was the whole of this function, and it only ever worked for the one shape
 * the tests used — an alphanumeric literal. Measured on a registered secret `ab/cd+ef=gh&ij k`:
 * reported as `?api_key=ab%2Fcd%2Bef%3Dgh%26ij%20k` through `encodeURIComponent` and as
 * `...%26ij+k` through `URLSearchParams`, both entirely unredacted; a percent-encoded unicode key
 * likewise. Any adapter that builds a URL the normal way leaks a secret containing `/ + = & space`
 * or any non-ASCII character.
 */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret])
  forms.add(encodeURIComponent(secret))
  forms.add(encodeURI(secret))
  // `URLSearchParams` is form-encoding, not percent-encoding: a space becomes `+`, which
  // `encodeURIComponent` never produces. Both reach a report.
  forms.add(new URLSearchParams([['v', secret]]).toString().slice('v='.length))
  // Stryker disable next-line StringLiteral: emptying the input encoding changes nothing, because Node's Buffer.from falls back to utf8 for an unrecognised encoding name rather than throwing — measured directly, the resulting base64 is byte-identical.
  forms.add(Buffer.from(secret, 'utf8').toString('base64'))
  // Stryker disable next-line StringLiteral: same fallback as the line above — an unrecognised input encoding silently becomes utf8, so the base64url form produced is unchanged.
  forms.add(Buffer.from(secret, 'utf8').toString('base64url'))
  // A one-character form would redact the whole string and say nothing.
  return [...forms].filter((f) => f.length > 1)
}

/**
 * Replace every known secret, in every form it can be written in, with `REDACTED`. Longest first.
 *
 * Longest-first matters: an API key and a prefix of it can both be registered (a key and its
 * account id share a prefix in several of phase 3's providers), and replacing the short one first
 * would leave the tail of the long one in the string.
 *
 * This is the SECRET-MATCHING half. It can only redact what was registered, which is why
 * `redactUrl` runs a structural pass first — "credential-free by construction" cannot rest on a
 * list the adapter author remembered to fill in.
 */
function redactRegisteredSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  // LONGEST FIRST: an API key and a prefix of it can both be registered, and replacing the short
  // one first would leave the tail of the long one standing.
  const usable = [...new Set(secrets.flatMap(secretForms))].sort((a, b) => b.length - a.length)
  for (const form of usable) {
    out = out.split(form).join(REDACTED)
  }
  return out
}

/** The structural passes: shapes that are credentials whether or not anyone registered them. */
function redactStructural(text: string): string {
  return redactUserinfo(text.replace(AUTH_SCHEME_RE, (_m, s: string) => `${s} ${REDACTED}`))
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  // REGISTERED SECRETS FIRST, then the structural regexes. The order is load-bearing and the first
  // edition had it backwards: a registered secret shaped like `u:p@ss-tail` was mangled by
  // `USERINFO_RE` into `[REDACTED]:[REDACTED]@ss-tail` BEFORE the secret loop ran, so `ss-tail`
  // was no longer part of any registered form, matched nothing, and survived into the report. The
  // structural passes destroy the very text the secret loop needs to recognise, so they go last.
  // DROPPED, not truncated — see `DROPPED_TOO_LONG`. Truncating first can cut a registered secret
  // in half and emit the prefix, which is the bypass this replaced.
  if (text.length > MAX_REDACTION_INPUT_CHARS) return DROPPED_TOO_LONG
  return redactStructural(redactRegisteredSecrets(text, secrets))
}

/**
 * Make one URL reportable: STRUCTURALLY first, then by secret matching.
 *
 * Structural, because the secret list is not a guarantee. Measured on the exact-match version:
 * `https://bob:hunter2@api.example.com/j?token=abc123` was reported verbatim with `secrets: []` —
 * nothing was registered, so nothing was redacted, and the report carried a password and a token.
 * Both are now gone whether or not anyone registered them.
 *
 * A URL that does not parse is not reported raw: it goes through secret matching and is then
 * dropped to a marker, because an unparsable string is exactly where a credential hides from the
 * structural pass.
 */
export function redactUrl(url: string, secrets: readonly string[]): string {
  if (url.length > MAX_REDACTION_INPUT_CHARS) return DROPPED_TOO_LONG
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `${REDACTED} (unparsable url)`
  }
  // Userinfo: never reportable, under any name. UNCONDITIONALLY — clearing an already-empty
  // username is a no-op, so the `if` that used to guard this was pure decoration: every mutant of
  // its condition (`true`, `false`, either `''` comparison) produced identical output, which is
  // the gate's way of saying the branch does not exist. Without it, the two `''` ARE observable:
  // assigning anything else injects userinfo into every reported URL.
  parsed.username = ''
  parsed.password = ''
  for (const key of [...parsed.searchParams.keys()]) {
    if (!REPORTABLE_QUERY_KEYS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, REDACTED)
    }
  }
  // Unconditional for the same reason: clearing an empty fragment changes nothing, so the guard
  // only gave the mutation gate a condition with no behaviour behind it.
  parsed.hash = ''
  // `searchParams.set` percent-encodes the marker's brackets (`%5BREDACTED%5D`), which is correct
  // URL encoding and useless to a human reading a report. The marker is a literal we own, so
  // putting it back is unambiguous — nothing else can produce that exact sequence here.
  const serialised = parsed.toString().split(encodeURIComponent(REDACTED)).join(REDACTED)
  return redactSecrets(serialised, secrets)
}

/**
 * Make free text reportable: every URL inside it through `redactUrl`, then secret matching over
 * the whole. An upstream error body echoes the request URL back, and a refused item can carry a
 * credentialed URL of its own (SR-L-3) — neither is a "url field", so neither reached `redactUrl`.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  if (text.length > MAX_REDACTION_INPUT_CHARS) return DROPPED_TOO_LONG
  const pieces: string[] = []
  let copiedTo = 0
  for (const { start, end } of findUrlSpans(text)) {
    pieces.push(text.slice(copiedTo, start), redactUrl(text.slice(start, end), secrets))
    copiedTo = end
  }
  pieces.push(text.slice(copiedTo))
  return redactSecrets(pieces.join(''), secrets)
}

export function buildRequestReport(
  // The FIELD shape: `Omit<RequestReport, ...>` would keep the brand and demand that the CALLER
  // already hold a built report, which is the opposite of what a builder is for.
  fields: Omit<RequestReportFields, 'url' | 'error'> & {
    url: string
    error: { code: CollectionErrorCode; message: string } | null
  },
  secrets: readonly string[],
): RequestReport {
  const report: RequestReportFields = {
    attempt: fields.attempt,
    page: fields.page,
    url: redactUrl(fields.url, secrets),
    status: fields.status,
    startedAt: fields.startedAt,
    endedAt: fields.endedAt,
    error: fields.error
      ? {
          code: fields.error.code,
          message: redactText(fields.error.message, secrets).slice(0, 500),
        }
      : null,
    cost: fields.cost,
  }
  Object.defineProperty(report, REPORT_BUILT, { value: true, enumerable: false })
  return report as RequestReport
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/**
 * A bounded trace of ONE refused item. Isolating a bad item (AC3) is only actionable if we can see
 * what it looked like, and only safe if what we keep is bounded and redacted — so a sample is
 * truncated to `MAX_SAMPLE_CHARS` and passes the same `redactSecrets` as a request URL.
 *
 * Not in the plan's interface sketch, which names counts but not samples while the prose requires
 * "bounded samples". A1 decision: it is a field of the batch, because the batch is the unit a
 * collection attempt reports and a sample belongs to the attempt, not to a page.
 */
export interface InvalidSample {
  page: number
  reason: string
  sample: string
}

export function buildInvalidSample(
  page: number,
  reason: string,
  raw: unknown,
  secrets: readonly string[],
): InvalidSample {
  let text: string
  try {
    text = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw))
  } catch {
    // Circular or otherwise unserializable: the sample is diagnostics, never a reason to fail.
    text = '[unserializable]'
  }
  return {
    page,
    // `redactText`, not `redactSecrets`: a refused item routinely carries a URL of its own, and
    // measured on the exact-match version a sample reported
    // `{"ref":"https://u:p@api.example.com/x?api_key=ab%2Fcd..."}` with the credential intact and
    // the key registered (SR-L-3). Truncation happens AFTER redaction, so a sample can never be
    // cut in a way that leaves half a credential standing.
    reason: redactText(reason, secrets).slice(0, MAX_SAMPLE_CHARS),
    sample: redactText(text, secrets).slice(0, MAX_SAMPLE_CHARS),
  }
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * Where an attempt got to, and under WHICH versions it got there. The three version fields are
 * the whole point: a checkpoint belongs to the config, adapter and policy that produced it
 * (`jobCollectionAttemptSchema` makes the same statement about `configVersion`), and resuming a
 * cursor minted under a different config would silently skip whatever the config change added.
 */
/** The ceiling of the store's `intColumnPositiveSchema` — a PostgreSQL `integer` column. */
export const PG_INT_MAX = 2_147_483_647

/** A cursor longer than this is not a cursor, it is a payload someone put in the wrong field. */
export const MAX_CURSOR_CHARS = 2048

/**
 * WHERE THE NEXT ATTEMPT STARTS — and nothing else. One question, three answers, no two of which
 * share a representation.
 *
 * The shape this replaces was `{ cursor: string | null; page: number }`, where `cursor: null` had
 * to mean BOTH "this provider paginates by number, so resume at `page + 1`" AND "the inventory ran
 * out". A cursor API loading the second one read it as the first and started again from page one
 * (CR-M-6), and `nextCursor() === null` meaning "exhausted" contradicted the field's own doc
 * comment. Prose cannot resolve that; the type can, so the type does.
 *
 * `RESTART` deliberately merges "exhausted" with "the trail cannot be picked up again": for the
 * only question this type answers they are the same answer. WHY the trail ended is carried by the
 * outcome and the request reports, where the difference is actually actionable.
 */
export type ResumePosition =
  /**
   * The trail continues. The next attempt resumes at `page + 1` by handing `cursor` back to the
   * provider. A cursor only reaches this shape after the adapter has successfully BUILT a request
   * from it — see `api-json.provider.ts`, where an unusable cursor becomes a `RESTART` instead of
   * being stored and replayed into the same rejection forever.
   *
   * A page-numbered provider is not a separate variant: its "cursor" is the page token it returns
   * (`String(page + 1)`, an `after=` value, whatever it uses), and `pageRequest` reads it from
   * `at.cursor`. A third `PAGE` variant was drafted and dropped — nothing in the spec seam can
   * produce it, since the only way to say "there is more" is to return a non-null cursor, and an
   * unreachable variant is a case every `switch` must handle and no test can reach.
   */
  | { kind: 'CURSOR'; page: number; cursor: string }
  /**
   * Discovery starts over from the beginning next time. Either the provider's inventory was
   * exhausted at `page`, or the trail cannot be resumed. Nothing is replayed.
   *
   * These two are ONE variant on purpose: for the only question this type answers — where does the
   * next attempt start — they have the same answer. WHY the trail ended is carried by the outcome
   * and the request reports, where the difference is actually actionable.
   */
  | { kind: 'RESTART'; page: number }

/**
 * Where an attempt got to, and under WHICH versions it got there. The three version fields are
 * the whole point: a checkpoint belongs to the config, adapter and policy that produced it
 * (`jobCollectionAttemptSchema` makes the same statement about `configVersion`), and resuming a
 * cursor minted under a different config would silently skip whatever the config change added.
 */
export interface ValidatedCheckpoint {
  configVersion: number
  policyVersion: number
  adapterVersion: string
  position: ResumePosition
  completedAt: Date
}

/**
 * THE SCHEMA THAT MAKES THE NAME TRUE.
 *
 * `ValidatedCheckpoint` used to be a bare interface whose name asserted a guarantee nothing
 * provided: the value came back from a store port typed `Promise<ValidatedCheckpoint | null>`, and
 * a row written by an older build, a hand-edited row, or a JSON round-trip satisfied the type by
 * assertion alone. Measured on the unparsed shape: `page: NaN` made the page cap vanish entirely
 * (`NaN > maxPages` is false) and the loop ran until the fake provider ran out — unbounded, not
 * merely large; `page: '7'` resumed at `'7' + 1 === '71'` and fetched nothing.
 *
 * So the boundary parses. `page` is bounded by the same PostgreSQL `integer` ceiling the store's
 * column has, because a checkpoint that cannot be persisted is not a checkpoint.
 */
export const resumePositionSchema: z.ZodType<ResumePosition> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CURSOR'),
    page: z.number().int().positive().max(PG_INT_MAX),
    cursor: z.string().min(1).max(MAX_CURSOR_CHARS),
  }),
  z.object({ kind: z.literal('RESTART'), page: z.number().int().positive().max(PG_INT_MAX) }),
])

export const validatedCheckpointSchema: z.ZodType<ValidatedCheckpoint> = z.object({
  configVersion: z.number().int().positive().max(PG_INT_MAX),
  policyVersion: z.number().int().positive().max(PG_INT_MAX),
  adapterVersion: z.string().min(1),
  position: resumePositionSchema,
  completedAt: z.coerce.date(),
})

/**
 * A checkpoint that can actually be resumed from. The narrowing is in the TYPE rather than left to
 * the caller: `decideCheckpoint` turns a `RESTART` position into `FRESH`, so a `RESUME` always
 * carries a cursor, and the loop reads `position.cursor` without re-checking a condition the
 * decision already settled.
 */
export type ResumableCheckpoint = ValidatedCheckpoint & {
  position: Extract<ResumePosition, { kind: 'CURSOR' }>
}

export type CheckpointDecision =
  | { kind: 'FRESH' }
  | { kind: 'RESUME'; from: ResumableCheckpoint }
  | {
      kind: 'RESTART_WITH_OVERLAP'
      /** `null` when the stored value did not parse: there is no checkpoint to report. */
      discarded: ValidatedCheckpoint | null
      mismatch: CheckpointMismatch
    }

export type CheckpointMismatch =
  'CONFIG_VERSION' | 'POLICY_VERSION' | 'ADAPTER_VERSION' | 'UNPARSABLE'

/**
 * Decide what a stored checkpoint is worth. A mismatch on ANY of the three versions discards the
 * cursor and restarts bounded discovery; the caller widens its window by the spec's overlap, so
 * the restart re-reads the boundary rather than trusting that nothing moved across it (AC4).
 *
 * Takes `unknown`, not `ValidatedCheckpoint | null`: the parameter type WAS the bug. A value that
 * fails the schema is treated exactly like a version mismatch — restart with overlap — because
 * both mean the same thing operationally ("we cannot trust where we were, so re-read the
 * boundary") and because refusing the attempt outright would make one bad row a permanent outage.
 *
 * Versions are checked in declaration order so the reported mismatch is deterministic: a test that
 * asserts `'CONFIG_VERSION'` for a checkpoint whose config AND adapter both moved is asserting a
 * fact, not an object-key order.
 */
export function decideCheckpoint(
  stored: unknown,
  current: { configVersion: number; policyVersion: number; adapterVersion: string },
): CheckpointDecision {
  if (stored === null || stored === undefined) return { kind: 'FRESH' }

  const parsed = validatedCheckpointSchema.safeParse(stored)
  if (!parsed.success) {
    return { kind: 'RESTART_WITH_OVERLAP', discarded: null, mismatch: 'UNPARSABLE' }
  }
  const checkpoint = parsed.data

  const mismatch: Exclude<CheckpointMismatch, 'UNPARSABLE'> | null =
    checkpoint.configVersion !== current.configVersion
      ? 'CONFIG_VERSION'
      : checkpoint.policyVersion !== current.policyVersion
        ? 'POLICY_VERSION'
        : checkpoint.adapterVersion !== current.adapterVersion
          ? 'ADAPTER_VERSION'
          : null
  if (mismatch !== null) {
    return { kind: 'RESTART_WITH_OVERLAP', discarded: checkpoint, mismatch }
  }
  // An exhausted or unresumable trail is not a resume instruction, whatever its versions say: a
  // `RESTART` position means discovery begins again, which is the one thing the old
  // `cursor: null` shape could not say without also meaning "page one of a cursor API". This is
  // also what keeps a capped attempt from freezing a source: it advances until the inventory runs
  // out, stores `RESTART`, and the attempt after that reads page one again.
  const position = checkpoint.position
  if (position.kind === 'RESTART') return { kind: 'FRESH' }
  return { kind: 'RESUME', from: { ...checkpoint, position } }
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

/**
 * The fields of a batch. NOT the type an adapter returns — see `CollectionBatch` below.
 */
export interface CollectionBatchFields {
  observations: SourceObservation[]
  outcome: CollectionOutcome
  coverage: CollectionCoverage
  scope: SourceCoverageScope
  requests: RequestReport[]
  counts: CollectionCounts
  checkpoint: ValidatedCheckpoint | null
  invalidSamples: InvalidSample[]
}

export type CollectionBatch = CollectionBatchFields & { readonly [BATCH_BUILT]: true }

/** True only of a batch that went through `buildCollectionBatch`. */
export function isBuiltBatch(value: unknown): value is CollectionBatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[BATCH_BUILT] === true
  )
}

export class UnbuiltBatchError extends Error {
  constructor() {
    super('a CollectionBatch reached the collector without going through buildCollectionBatch')
    this.name = 'UnbuiltBatchError'
  }
}

/**
 * The runtime half of the brand, for the dynamic boundary the type cannot reach: a provider
 * resolved from a registry, or one compiled separately from this package. The compile-time half
 * covers the 25 adapters that live in this repository.
 */
export function assertBuiltBatch(value: unknown): asserts value is CollectionBatch {
  if (!isBuiltBatch(value)) throw new UnbuiltBatchError()
}

/** Why an attempt stopped. `EXHAUSTED` is the only one that can carry SUCCEEDED. */
export type StopReason =
  'EXHAUSTED' | 'PAGE_CAP' | 'CURSOR_CYCLE' | 'ERROR' | 'CANCELLED' | 'COST_STOP'

export interface DerivationFacts {
  stop: StopReason
  /** Pages whose observations AND checkpoint were durably persisted. */
  pagesCompleted: number
  counts: CollectionCounts
  scope: SourceCoverageScope
  /**
   * Did this attempt start from a stored position rather than from the beginning?
   *
   * A batch describes ONE attempt, so an attempt that began at page 11 never looked at pages 1-10
   * and cannot claim to have seen the inventory — even when it then runs to exhaustion. Measured
   * before this field existed: a checkpoint at page 4, one fetch, `nextCursor` null, and the batch
   * reported `FULL_INVENTORY` on the strength of a single tail page (SPEC-L-2).
   */
  resumed: boolean
}

/**
 * The outcome, from what happened. `CANCELLED` wins over everything (an aborted run claims
 * nothing); an error with no completed page is `FAILED`; an error after at least one completed page
 * is `PARTIAL`, which is also what "one board failing" means for a multi-board attempt (AC1).
 *
 * A page cap or a cursor cycle is NOT a failure: we stopped on our own bound, having kept
 * everything we read. It reports `SUCCEEDED` and loses its claim on the COVERAGE axis instead,
 * which is the distinction `deriveCoverage` exists to carry.
 */
export function deriveOutcome(facts: DerivationFacts): CollectionOutcome {
  // An exhaustive switch rather than a fall-through `return 'SUCCEEDED'`. With a fall-through, any
  // unexpected stop reason — including one a future branch forgets to set — quietly becomes a
  // SUCCESS, which is the one answer this function must never invent. Here it throws.
  switch (facts.stop) {
    case 'CANCELLED':
      return 'CANCELLED'
    case 'ERROR':
    case 'COST_STOP':
      return facts.pagesCompleted > 0 ? 'PARTIAL' : 'FAILED'
    case 'EXHAUSTED':
    case 'PAGE_CAP':
    case 'CURSOR_CYCLE':
      return 'SUCCEEDED'
    default: {
      const unexpected: never = facts.stop
      throw new BatchInvariantError(`unknown stop reason: ${String(unexpected)}`)
    }
  }
}

/**
 * The coverage, from what happened. Read top to bottom — the first claim we cannot support wins:
 *
 * - a non-SUCCEEDED attempt has no coverage claim at all -> PARTIAL
 * - any item we could not observe means the inventory we report is demonstrably incomplete ->
 *   PARTIAL. (The store permits SUCCEEDED with `invalid > 0`, so the two axes disagree here on
 *   purpose: the attempt succeeded, the inventory is not full.)
 * - an attempt that RESUMED never read the pages before its start, so its inventory is incomplete
 *   by construction -> PARTIAL, even when it then ran to exhaustion (SPEC-L-2)
 * - a cap or cycle on a SEARCH scope (`query !== null`) is a WINDOW: a search was never going to
 *   enumerate an inventory, and a bounded slice of it is exactly what WINDOW means (AC1)
 * - the same cap on a FULL-INVENTORY scope is PARTIAL: we were supposed to see everything
 * - a scope that asked for a time window gets WINDOW even when exhausted
 * - only an exhausted, clean, unwindowed, unqueried, UNRESUMED scope is FULL_INVENTORY
 */
export function deriveCoverage(facts: DerivationFacts): CollectionCoverage {
  const outcome = deriveOutcome(facts)
  if (outcome !== 'SUCCEEDED') return 'PARTIAL'
  if (facts.counts.invalid > 0 || facts.counts.quarantined > 0) return 'PARTIAL'
  if (facts.resumed) return 'PARTIAL'
  const truncated = facts.stop === 'PAGE_CAP' || facts.stop === 'CURSOR_CYCLE'
  if (truncated) return facts.scope.query !== null ? 'WINDOW' : 'PARTIAL'
  if (facts.scope.window !== null || facts.scope.query !== null) return 'WINDOW'
  return 'FULL_INVENTORY'
}

export class BatchInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchInvariantError'
  }
}

/**
 * The invariant above all others, as a check rather than a convention: a failure never reports
 * SUCCEEDED and never reports FULL_INVENTORY.
 *
 * With `deriveOutcome` / `deriveCoverage` as the only producers this can never fire today — it is
 * the second line of defence for phase 3, where 25 adapters arrive and someone will eventually
 * assemble a batch by hand. It is tested DIRECTLY, against hand-made batches, because that is the
 * only way a guard against a future caller can have a failing test at all.
 */
export function assertBatchInvariant(
  // The FIELD shape, deliberately: this guard runs on a batch mid-construction, before the brand
  // is stamped, and it is tested directly against hand-made batches — which is the only way a
  // guard against a future caller can have a failing test at all.
  batch: Pick<CollectionBatchFields, 'outcome' | 'coverage' | 'counts'>,
): void {
  if (batch.outcome !== 'SUCCEEDED' && batch.coverage === 'FULL_INVENTORY') {
    throw new BatchInvariantError(`a ${batch.outcome} attempt cannot claim FULL_INVENTORY coverage`)
  }
  assertCountsBalanced(batch.counts)
}

/** The ONLY producer of a `CollectionBatch`. Outcome and coverage are arguments to nothing. */
export function buildCollectionBatch(input: {
  observations: SourceObservation[]
  facts: DerivationFacts
  requests: RequestReport[]
  checkpoint: ValidatedCheckpoint | null
  invalidSamples: InvalidSample[]
}): CollectionBatch {
  const batch: CollectionBatchFields = {
    observations: input.observations,
    outcome: deriveOutcome(input.facts),
    coverage: deriveCoverage(input.facts),
    scope: input.facts.scope,
    requests: input.requests.slice(0, MAX_REQUEST_REPORTS),
    counts: input.facts.counts,
    checkpoint: input.checkpoint,
    invalidSamples: input.invalidSamples.slice(0, MAX_SAMPLES),
  }
  assertBatchInvariant(batch)
  // `enumerable: false` IS load-bearing and IS asserted: the brand must not reach a database row.
  Object.defineProperty(batch, BATCH_BUILT, { value: true, enumerable: false })
  return batch as CollectionBatch
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The runtime marker a validated config carries. A phantom type alone would be free but invisible:
 * `apps/api/tsconfig.json` EXCLUDES `**\/*.spec.ts`, so a `@ts-expect-error` pinning the brand
 * would never be compiled by `pnpm typecheck` and the brand would be unverifiable. A
 * non-enumerable symbol is checkable at runtime, by a test that can actually fail.
 *
 * Non-enumerable so it never reaches `JSON.stringify`, a log line, or a database row.
 */
const CONFIG_VALIDATED: unique symbol = Symbol('crm.jobSourcing.configValidated')

/**
 * The minimum every source config carries, whatever the adapter. `namespace` and `configVersion`
 * are the store's words for the same two facts (`jobSourceIdentitySchema.namespace`,
 * `jobCollectionAttemptSchema.configVersion`).
 */
export interface SourceConfigFields {
  namespace: string
  configVersion: number
  query?: string | null
  window?: CollectionWindow | null
}

/**
 * An adapter's own config type, branded. Exported so that `defineApiJsonProvider` can name the
 * type `parseConfig` returns WITHOUT a cast of its own: the brand symbol is module-private, so a
 * caller that had to spell the intersection itself would be forced to approximate it
 * (`{ [k: symbol]: true }`) and then cast across the gap — which is how a cast stops being a
 * formality and starts masking a mismatch.
 */
export type Validated<T extends SourceConfigFields> = T & {
  readonly [CONFIG_VALIDATED]: true
}

export type ValidatedSourceConfig = Validated<SourceConfigFields>

/**
 * Stamp a config that a schema has just accepted.
 *
 * THE CAST: `as Validated<T>`. It is not masking a contract, and the reason is the call site, not
 * good intentions — `markValidated` is applied to the RESULT of a `.parse()`, so every structural
 * field has already been checked by Zod and the cast adds only the phantom property that
 * `defineProperty` just installed on the line above. Contrast the cast this feature was burned by
 * in Task 2.1, which asserted a VALUE's shape that nothing had checked.
 */
export function markValidated<T extends SourceConfigFields>(config: T): Validated<T> {
  // `writable` and `configurable` are omitted, not set to false: `defineProperty` already
  // defaults both to false, and a value that cannot differ is a value no test can pin.
  // `enumerable: false` IS stated, because it is load-bearing — see the spread test.
  Object.defineProperty(config, CONFIG_VALIDATED, { value: true, enumerable: false })
  return config as Validated<T>
}

export function isValidatedConfig(value: unknown): value is ValidatedSourceConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CONFIG_VALIDATED] === true
  )
}

export class UnvalidatedConfigError extends Error {
  constructor() {
    super('collectReport was given a config that parseConfig never validated')
    this.name = 'UnvalidatedConfigError'
  }
}

export function assertValidatedConfig(value: unknown): asserts value is ValidatedSourceConfig {
  if (!isValidatedConfig(value)) throw new UnvalidatedConfigError()
}

// ---------------------------------------------------------------------------
// Context and provider
// ---------------------------------------------------------------------------

/** One response body, as the fetch seam delivers it. TEXT, not parsed JSON: byte bounds and
 * egress policy are Task 2.2's; JSON depth and item bounds are ours. */
export interface FetchedText {
  status: number
  bodyText: string
  /** Lowercased header names. `null` for a response that carried none. */
  headers: Readonly<Record<string, string>>
  /** Validator for conditional requests; `null` when the provider sent none. */
  etag: string | null
}

export interface FetchRequest {
  url: string
  method?: 'GET' | 'POST'
  body?: string
  headers?: Readonly<Record<string, string>>
}

export interface MeterReservation {
  id: string
  unit: JobMeterUnit
  amount: number
}

/** How a reservation resolved. The store's own statuses minus the two the caller cannot assert
 * (`RESERVED` is where it starts; `SENT` is the transport's claim, not the loop's). */
export type ReservationResolution = 'USED' | 'RELEASED' | 'UNCERTAIN'

/**
 * Everything the loop needs from the world, as ports. Nothing here is constructed by the loop:
 * accept dependencies, do not create them — which is also what lets the whole loop be tested
 * through its own interface with fakes, rather than from behind it.
 */
export interface CollectionContext {
  /** Run identity. The same four facts `jobCollectionAttemptSchema` stores. */
  run: {
    sourceId: string
    cycleId: string
    attemptId: string
    fencingEpoch: number
  }
  policyVersion: number
  signal: AbortSignal
  /** Hard stop. Checked before every subrequest, so a deadline cannot be overrun by one page. */
  deadline: Date
  now(): Date
  /** Values that must never appear in a report. Redaction happens before anything is reported. */
  secrets: readonly string[]
  fetchText(request: FetchRequest): Promise<FetchedText>
  meter: {
    /** RESERVED before any I/O (the store's own ordering). Returns `null` when the budget refuses,
     * which is a COST_STOP, not an error. */
    reserve(unit: JobMeterUnit, amount: number): Promise<MeterReservation | null>
    reconcile(reservation: MeterReservation, resolution: ReservationResolution): Promise<void>
  }
  checkpoints: {
    load(): Promise<ValidatedCheckpoint | null>
    /**
     * Persist one completed page's observations AND its checkpoint, together, before the loop may
     * continue. One call rather than two because "completed pages and checkpoints persisted before
     * continuing" (AC4) is an ATOMICITY claim: two ports could be called in either order, or one
     * without the other, and the loop would still look right.
     */
    savePage(page: {
      observations: SourceObservation[]
      checkpoint: ValidatedCheckpoint
    }): Promise<void>
  }
  /** Conditional-request cache. A 304 reuses the stored body rather than refetching it. */
  cache: {
    get(key: string): Promise<{ etag: string; bodyText: string } | null>
    put(key: string, value: { etag: string; bodyText: string }): Promise<void>
  }
}

export interface ReportingJobSourceProvider<
  TConfig extends ValidatedSourceConfig = ValidatedSourceConfig,
> {
  readonly type: import('@crm/shared').JobSourceType
  parseConfig(raw: unknown): TConfig
  collectReport(config: TConfig, ctx: CollectionContext): Promise<CollectionBatch>
}
