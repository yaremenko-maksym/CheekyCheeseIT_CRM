import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
import { SLUG_PATTERN } from './as'
import type {
  CollectionBatch,
  CollectionContext,
  ReportingJobSourceProvider,
  ValidatedSourceConfig,
} from '../reporting-provider'

/**
 * Board configuration shared by the ATS adapters (Greenhouse, Lever, Ashby here; Task 3.4 builds
 * Workable, SmartRecruiters, Recruitee and Personio on the same module).
 *
 * AN ATS SOURCE IS A BOARD, AND A BOARD CONFIG IS VERIFIED DATA, NOT A GUESS. Three consequences
 * shape everything below:
 *
 * 1. THE SLUG BECOMES A URL PATH SEGMENT, so it is the one config field that can steer a request.
 *    It is refused by ALPHABET, not by a list of bad inputs: `[a-z0-9_-]` has no `/`, `%`, `.`,
 *    `@`, `:`, `\`, `?`, `#` or whitespace, so `../x`, `a/b`, `a%2Fb`, `.`, `..`, `user@host` and
 *    `evil.example` are refused for one reason (they are not in the alphabet) instead of seven
 *    reasons somebody had to think of. Every refusal happens in `parseConfig`, before any request.
 * 2. THE HOST IS THE ADAPTER'S, NEVER THE CONFIG'S. Every config schema here is `.strict()`, so a
 *    `host`, `baseUrl` or `url` key is an unknown key and the whole config is refused. The only
 *    thing a config chooses is a REGION from a closed set, and the adapter maps it to a host.
 * 3. THE EMPLOYER IS EVIDENCE, NEVER A DERIVATION. `employer` is `null` unless somebody verified
 *    the board's owner from the provider's own payload and wrote down how. Nothing here (or in any
 *    adapter) turns `stripe` into `Stripe`: a title-cased slug is a guess, and a guessed company
 *    name written onto vacancies is a false statement about who is hiring. An observation with no
 *    employer is QUARANTINED (`MISSING_COMPANY`) by the observation builder, which is the correct
 *    outcome for a board whose owner nobody verified.
 */

export type AtsRegion = 'global' | 'eu'

export interface AtsBoardKind {
  /** The namespace prefix; part of every identity key, so it never changes once a board is live. */
  readonly label:
    'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee' | 'personio'
  /** Regional endpoint variants. The first is the default. One entry = no regional variant. */
  readonly regions: readonly [AtsRegion, ...AtsRegion[]]
  readonly slugMaxChars: number
  /**
   * The alphabet of this provider's board slugs. Per provider because the evidence is per provider:
   * a provider whose board is a DNS label (Task 3.4: Recruitee, Personio) or whose identifiers are
   * case-sensitive needs a different pattern, and should add it here rather than reshape this file.
   * Every pattern must stay closed: no separator, dot, percent, `@` or whitespace.
   */
  readonly slugPattern: RegExp
}

/**
 * The longest board slug accepted. Observed slugs are 5-13 characters (`airbnb`, `cloudflare`,
 * `siteimprove`); 64 is far past any of them and still short enough that a slug cannot be the
 * bulk of a URL. The bound is the same for the three providers because nothing measured says
 * they differ, but each kind carries its own so a provider that turns out to differ changes one
 * line.
 */
export const ATS_SLUG_MAX_CHARS = 64

/**
 * Slugs are lowercase only: Greenhouse and Ashby treat case as insignificant (`LINEAR` answered
 * 200, measured), so accepting `Linear` and `linear` would give one board two namespaces and every
 * vacancy on it two identities. Lever is case-sensitive (`SPOTIFY` is 404) and every site observed
 * is lowercase, so lowercase-only costs nothing there that was measured.
 *
 * Greenhouse and Ashby use the shared `SLUG_PATTERN` from `as.ts` (lowercase alphanumerics joined
 * by single hyphens): no underscore, no trailing or doubled hyphen has been seen on either, so
 * neither is accepted until somebody measures one.
 */
export const GREENHOUSE_KIND: AtsBoardKind = {
  label: 'greenhouse',
  regions: ['global'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
  slugPattern: SLUG_PATTERN,
}

/**
 * Lever accepts exactly one thing beyond `SLUG_PATTERN`: a trailing hyphen. It is evidenced: Lever
 * has a real site named `quantco-` (HTTP 200; `quantco` without the hyphen is 404, measured
 * 2026-10-24), which is why `slugString` is not used as it stands. Underscores and doubled hyphens
 * are NOT accepted: nothing measured needs them.
 */
export const LEVER_KIND: AtsBoardKind = {
  label: 'lever',
  regions: ['global', 'eu'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
  slugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/,
}
export const ASHBY_KIND: AtsBoardKind = {
  label: 'ashby',
  regions: ['global'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
  slugPattern: SLUG_PATTERN,
}

/**
 * TASK 3.4: THE SECOND HALF OF THE SECURITY SURFACE. For Greenhouse, Lever and Ashby the slug is a
 * path segment under a host the adapter fixed. For Recruitee (`{tenant}.recruitee.com`) and Personio
 * (`{tenant}.jobs.personio.de`) the tenant IS PART OF THE HOST, so a string that is merely safe in a
 * path can still steer the request: `evil.example` would make `evil.example.recruitee.com`, a
 * name with a dot adds a subdomain level, a unicode lookalike (or its `xn--` punycode spelling) is
 * a different host that renders like the intended one, and an empty tenant makes
 * `.recruitee.com`. So the alphabet of these two kinds is one DNS LABEL, written out exactly:
 *
 *  - lowercase ASCII letters, digits and hyphens only (no dot, so a tenant can never add a label;
 *    no uppercase, so one tenant cannot have two namespaces);
 *  - not starting or ending with a hyphen (RFC 1123);
 *  - at most 63 characters (RFC 1035 label limit), which `slugMaxChars` enforces beside the pattern;
 *  - never `--` in positions 3-4: the `xn--` prefix and every other reserved label form (RFC 5891
 *    section 4.2.3.1) is how a lookalike reaches a resolver, and no real tenant needs one.
 *
 * A one-character label is accepted (`a`); nothing measured needs one, but refusing it would be a
 * rule with no reason behind it.
 */
export const DNS_LABEL_PATTERN = /^(?![a-z0-9]{2}--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
export const DNS_LABEL_MAX_CHARS = 63

/**
 * Workable account subdomains (`huggingface`, `hirefellows`): a path segment under the adapter's
 * host, in the same alphabet as Greenhouse and Ashby. Every account measured on 2026-10-24 fits it;
 * a hyphenated or numeric one has not been seen, so none is claimed beyond what the pattern allows.
 */
export const WORKABLE_KIND: AtsBoardKind = {
  label: 'workable',
  regions: ['global'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
  slugPattern: SLUG_PATTERN,
}

/**
 * SmartRecruiters company identifiers are the last segment of a career-site URL and are
 * case-SENSITIVE in the documented examples (the documentation page uses `smartrecruiters`; the
 * employers' own sites use mixed case). NOTHING WAS MEASURED, because the API host's robots.txt
 * disallows this collector (see `__fixtures__/smartrecruiters/api-robots.provenance.json`), so
 * the alphabet is the CLOSED superset that cannot reach a host: ASCII letters and digits joined by
 * single hyphens or underscores. If the API turns out to treat case as insignificant, the same
 * company gets two namespaces from two spellings, which is the cost of not being able to measure.
 */
export const SMARTRECRUITERS_KIND: AtsBoardKind = {
  label: 'smartrecruiters',
  regions: ['global'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
  slugPattern: /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/,
}

/** Recruitee tenants are the subdomain of `{tenant}.recruitee.com`: a DNS label. */
export const RECRUITEE_KIND: AtsBoardKind = {
  label: 'recruitee',
  regions: ['global'],
  slugMaxChars: DNS_LABEL_MAX_CHARS,
  slugPattern: DNS_LABEL_PATTERN,
}

/**
 * Personio companies are the subdomain of `{company}.jobs.personio.de`: a DNS label. The `.de` and
 * `.com` hosts served byte-identical documents for the tenants measured, so they are ONE data set
 * and the host variant is not a region (it is not in the namespace); see `personio.provider.ts`.
 */
export const PERSONIO_KIND: AtsBoardKind = {
  label: 'personio',
  regions: ['global'],
  slugMaxChars: DNS_LABEL_MAX_CHARS,
  slugPattern: DNS_LABEL_PATTERN,
}

export const atsBoardSlug = (kind: AtsBoardKind) =>
  z.string().min(1).max(kind.slugMaxChars).regex(kind.slugPattern)

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/**
 * Who owns the board, and how that was established. `name` is the employer as the provider's own
 * payload spells it (or, where the provider sends no name, as the payload's text introduces
 * itself); `evidence` says which, in words a reviewer can check. A domain is optional and is a
 * bare hostname, never a URL.
 */
export const employerEvidenceSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    domain: z.string().regex(HOSTNAME_PATTERN).nullable().default(null),
    evidence: z.string().trim().min(1).max(500),
  })
  .strict()
export type EmployerEvidence = z.infer<typeof employerEvidenceSchema>

/** `greenhouse:stripe`, `lever:eu:siteimprove`: the region is in the namespace only where the provider has regions. */
export function atsNamespace(kind: AtsBoardKind, region: AtsRegion, board: string): string {
  return kind.regions.length > 1 ? `${kind.label}:${region}:${board}` : `${kind.label}:${board}`
}

/**
 * The three fields every board has. Exported (Task 3.4) so a provider with one more field builds
 * its own schema FROM these instead of loosening this module: Personio adds `language` and calls
 * `constrainAtsBoardConfig` / `atsBoardGroupOf` below, which apply the same rules.
 */
export const atsBoardFields = (kind: AtsBoardKind) => ({
  board: atsBoardSlug(kind),
  region: z.enum(kind.regions).default(kind.regions[0]),
  employer: employerEvidenceSchema.nullable().default(null),
})

/** One board, as a manifest group lists it: no version, no namespace (derived), no host. */
export const atsBoardEntrySchema = (kind: AtsBoardKind) => z.object(atsBoardFields(kind)).strict()

/**
 * The config one adapter run receives: one board. The namespace is DERIVED from provider, region
 * and slug, so a config cannot name a namespace that disagrees with the board it fetches.
 */
export const atsBoardConfigSchema = (kind: AtsBoardKind) =>
  constrainAtsBoardConfig(kind, baseSourceConfigSchema.extend(atsBoardFields(kind)).strict())

/** What every ATS board config carries, whatever else a provider adds to it. */
export interface AtsBoardConfigFields {
  namespace: string
  configVersion: number
  query: string | null
  window: { from: Date; to: Date } | null
  board: string
  region: AtsRegion
  employer: EmployerEvidence | null
}

/**
 * The rules a board config obeys, applied to a schema that may carry MORE fields than the three
 * (Task 3.4: Personio's `language`). `atsBoardConfigSchema` is this applied to the plain shape, so
 * a provider that extends the shape gets the same three rules and cannot write a weaker copy: the
 * board is the scope (no query), there is no date window, and the namespace is derived (a stated
 * one is refused unless it equals the derived one).
 */
export function constrainAtsBoardConfig<T extends AtsBoardConfigFields>(
  kind: AtsBoardKind,
  schema: z.ZodType<T>,
) {
  return schema
    .refine((c) => c.query === null, {
      message: 'ATS boards are not searched; the board is the scope',
    })
    .refine((c) => c.window === null, { message: 'ATS boards have no date window' })
    .refine((c) => c.namespace === '' || c.namespace === atsNamespace(kind, c.region, c.board), {
      message: 'namespace is derived from the board and region and cannot be set to anything else',
    })
    .transform((c) => ({ ...c, namespace: atsNamespace(kind, c.region, c.board) }))
}

/** At most this many boards in one manifest group (plan Task 3.3). The 301st is refused. */
export const ATS_MAX_BOARDS_PER_GROUP = 300

/**
 * A manifest group: up to 300 boards sharing one `configVersion`. Two entries naming the same
 * board (same region, same slug) are refused: they would collect the same vacancies under one
 * namespace twice.
 */
export const atsBoardGroupSchema = (kind: AtsBoardKind) =>
  atsBoardGroupOf(kind, atsBoardEntrySchema(kind))

/**
 * A group of whatever entry a provider lists: the plain entry above, or one with an extra field.
 * The limit and the duplicate rule are written once, here.
 */
export function atsBoardGroupOf<B extends { board: string; region: AtsRegion }>(
  kind: AtsBoardKind,
  entry: z.ZodType<B>,
) {
  return z
    .object({
      configVersion: baseSourceConfigSchema.shape.configVersion,
      boards: z.array(entry).min(1).max(ATS_MAX_BOARDS_PER_GROUP),
    })
    .strict()
    .refine(
      (g) =>
        new Set(g.boards.map((b) => atsNamespace(kind, b.region, b.board))).size ===
        g.boards.length,
      { message: 'a board is listed twice in the group' },
    )
}
export type AtsBoardGroup = z.infer<ReturnType<typeof atsBoardGroupSchema>>

/**
 * The per-board inputs `parseConfig` takes, in the group's order. Every field of the entry is
 * passed on, so a provider-specific one (Personio's `language`) reaches its config without this
 * function knowing it exists; for the three Task 3.3 providers the result is exactly the four
 * fields it always was.
 */
export function boardConfigsOf<B extends { board: string; region: AtsRegion }>(group: {
  configVersion: number
  boards: readonly B[]
}) {
  return group.boards.map((b) => ({ configVersion: group.configVersion, ...b }))
}

/**
 * PROPOSED politeness policy, NOT enforced and NOT a fact about any provider: wait this long
 * between two requests to the same ATS host. It is a number for whoever owns request pacing
 * (the collector, Task 2.5 / the transport) to adopt or replace; nothing in this module sleeps.
 *
 * One measured caution for that owner: Lever's robots.txt says `Crawl-delay: 1` (observed
 * 2026-10-24 on both `api.lever.co` and `api.eu.lever.co`), which is a longer gap than this
 * proposal, so a pacer that applies one number to all three providers is below Lever's own
 * request. Greenhouse's robots.txt only disallows `/embed/`; `api.ashbyhq.com/robots.txt` answers
 * 401, so Ashby states no pacing at all.
 */
export const ATS_PROPOSED_REQUEST_GAP_MS = 500

/**
 * The strings among `values`, in order: a mapper's way of saying "the department and the team,
 * whichever of them the provider sent". Exported so its behaviour is asserted where it lives
 * instead of through three mappers whose downstream normalizer would hide a leaked null.
 */
export function presentStrings(
  values: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  return (values ?? []).filter((v): v is string => typeof v === 'string')
}

/**
 * The text itself, or null when the provider sent nothing worth keeping: absent, null, or only
 * whitespace. Workable and Personio send `""` for "no value" (an empty `employment_type`, an empty
 * `city`), and an empty string kept as a tag or an employment type is a false statement that the
 * posting has one.
 */
export function nonBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * One location from its parts, in reading order and without the repeats ATS payloads carry ("New
 * York, New York, United States" becomes "New York, United States"): blank parts are dropped, and a
 * part equal to the one before it is dropped. Nothing is invented: three blank parts give null.
 */
export function placeOf(parts: readonly (string | null | undefined)[]): string | null {
  const kept: string[] = []
  for (const part of parts) {
    const text = nonBlank(part)
    if (text !== null && text !== kept.at(-1)) kept.push(text)
  }
  return kept.length === 0 ? null : kept.join(', ')
}

// ---------------------------------------------------------------------------
// Running a group: independent boards, independent failures
// ---------------------------------------------------------------------------

/**
 * What one board's run came to. `BOARD_NOT_FOUND` is a statement about THE BOARD (it was
 * removed, renamed, or never existed): the provider answered, and the answer was "no such board".
 * It is deliberately a different verdict from `SOURCE_FAILED`, which is "we could not get an
 * answer we can trust" (rate limit, 5xx, drift, network).
 */
export type BoardVerdict =
  'SUCCEEDED' | 'PARTIAL' | 'CANCELLED' | 'BOARD_NOT_FOUND' | 'SOURCE_FAILED' | 'CONFIG_INVALID'

/** What a verdict reads of a batch: its outcome and the status each request got. A real batch satisfies it; so does a literal in a test. */
export interface VerdictFacts {
  readonly outcome: CollectionBatch['outcome']
  readonly requests: readonly { readonly status: number | null }[]
}

/** The LAST request's status decides: a board that answers 404 after a transient failure is dead, and one that fails after a 404 is not known to be. */
export function boardVerdictOf(batch: VerdictFacts): Exclude<BoardVerdict, 'CONFIG_INVALID'> {
  switch (batch.outcome) {
    case 'SUCCEEDED':
    case 'PARTIAL':
    case 'CANCELLED':
      return batch.outcome
    default:
      // `FAILED`, and the store's `STARTED`, which a finished batch never carries. The 404 is read
      // from the STATUS the loop recorded, never from the body text.
      return batch.requests.at(-1)?.status === 404 ? 'BOARD_NOT_FOUND' : 'SOURCE_FAILED'
  }
}

/** A board whose provider was asked: it has a namespace, a verdict and the batch behind it. */
export interface BoardRan {
  readonly index: number
  readonly namespace: string
  readonly verdict: Exclude<BoardVerdict, 'CONFIG_INVALID'>
  readonly batch: CollectionBatch
  readonly configError: null
}

/** A board whose config was refused: no namespace could be derived, no request was made, no context was built. */
export interface BoardRefused {
  readonly index: number
  readonly namespace: null
  readonly verdict: 'CONFIG_INVALID'
  readonly batch: null
  readonly configError: string
}

export type BoardRun = BoardRan | BoardRefused

export interface BoardGroupRun {
  readonly boards: readonly BoardRun[]
  /** Namespaces whose provider answered 404. A board problem to fix in config, never a source outage. */
  readonly deadBoards: readonly string[]
  /** True iff some board could not be collected for a reason that is NOT the board's own. */
  readonly sourceFailure: boolean
}

/**
 * Collect every board of a group, each on its OWN context, one after another.
 *
 * `contextFor` is called once per board with that board's namespace. Handing each board its own
 * context is what makes checkpoints independent: board B resumes from B's checkpoint and a 404 on
 * board A neither moves nor erases it. A board whose config is refused makes no request and gets
 * no context. One board failing never stops the next: the group reports all of them.
 *
 * Sequential on purpose, and not paced: see `ATS_PROPOSED_REQUEST_GAP_MS`.
 */
export async function collectBoardGroup<TConfig extends ValidatedSourceConfig>(
  provider: ReportingJobSourceProvider<TConfig>,
  inputs: readonly unknown[],
  contextFor: (namespace: string) => CollectionContext,
): Promise<BoardGroupRun> {
  const boards: BoardRun[] = []
  for (const [index, input] of inputs.entries()) {
    let config: TConfig
    try {
      config = provider.parseConfig(input)
    } catch (error) {
      boards.push({
        index,
        namespace: null,
        verdict: 'CONFIG_INVALID',
        batch: null,
        configError: error instanceof Error ? error.message : 'config refused',
      })
      continue
    }
    const batch = await provider.collectReport(config, contextFor(config.namespace))
    boards.push({
      index,
      namespace: config.namespace,
      verdict: boardVerdictOf(batch),
      batch,
      configError: null,
    })
  }
  return {
    boards,
    deadBoards: boards.flatMap((b) => (b.verdict === 'BOARD_NOT_FOUND' ? [b.namespace] : [])),
    sourceFailure: boards.some((b) => b.verdict === 'SOURCE_FAILED'),
  }
}
