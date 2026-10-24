import { z } from 'zod'
import { baseSourceConfigSchema } from '../api-json.provider'
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
  readonly label: 'greenhouse' | 'lever' | 'ashby'
  /** Regional endpoint variants. The first is the default. One entry = no regional variant. */
  readonly regions: readonly [AtsRegion, ...AtsRegion[]]
  readonly slugMaxChars: number
}

/**
 * The longest board slug accepted. Observed slugs are 5-13 characters (`airbnb`, `cloudflare`,
 * `siteimprove`); 64 is far past any of them and still short enough that a slug cannot be the
 * bulk of a URL. The bound is the same for the three providers because nothing measured says
 * they differ, but each kind carries its own so a provider that turns out to differ changes one
 * line.
 */
export const ATS_SLUG_MAX_CHARS = 64

export const GREENHOUSE_KIND: AtsBoardKind = {
  label: 'greenhouse',
  regions: ['global'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
}
export const LEVER_KIND: AtsBoardKind = {
  label: 'lever',
  regions: ['global', 'eu'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
}
export const ASHBY_KIND: AtsBoardKind = {
  label: 'ashby',
  regions: ['global'],
  slugMaxChars: ATS_SLUG_MAX_CHARS,
}

/**
 * A board slug: lowercase letters and digits, with `-` and `_` allowed after the first character.
 *
 * NOT `slugString` from `as.ts`, deliberately. This pattern relaxes THREE things that one refuses:
 * a trailing hyphen, consecutive hyphens, and underscores. Only the first is evidenced: Lever has a
 * real site named `quantco-` (HTTP 200; `quantco` without the hyphen is 404, measured 2026-10-24).
 * The other two are not observed on any board read; they are accepted because the alphabet stays
 * closed (no separator, dot, percent or `@`), so they add no injection route.
 * Lowercase only because Greenhouse and Ashby treat case as insignificant (`LINEAR` answered 200,
 * measured) - accepting `Linear` and `linear` would give one board two namespaces, so two
 * identities for every vacancy on it. Lever is case-sensitive (`SPOTIFY` is 404), and every site
 * observed is lowercase, so lowercase-only costs nothing there that was measured.
 */
export const ATS_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export const atsBoardSlug = (kind: AtsBoardKind) =>
  z.string().min(1).max(kind.slugMaxChars).regex(ATS_SLUG_PATTERN)

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

/** One board, as a manifest group lists it: no version, no namespace (derived), no host. */
export const atsBoardEntrySchema = (kind: AtsBoardKind) =>
  z
    .object({
      board: atsBoardSlug(kind),
      region: z.enum(kind.regions).default(kind.regions[0]),
      employer: employerEvidenceSchema.nullable().default(null),
    })
    .strict()

/**
 * The config one adapter run receives: one board. The namespace is DERIVED from provider, region
 * and slug, so a config cannot name a namespace that disagrees with the board it fetches.
 */
export const atsBoardConfigSchema = (kind: AtsBoardKind) =>
  baseSourceConfigSchema
    .extend({
      board: atsBoardSlug(kind),
      region: z.enum(kind.regions).default(kind.regions[0]),
      employer: employerEvidenceSchema.nullable().default(null),
    })
    .strict()
    .refine((c) => c.query === null, {
      message: 'ATS boards are not searched; the board is the scope',
    })
    .refine((c) => c.window === null, { message: 'ATS boards have no date window' })
    .refine((c) => c.namespace === '' || c.namespace === atsNamespace(kind, c.region, c.board), {
      message: 'namespace is derived from the board and region and cannot be set to anything else',
    })
    .transform((c) => ({ ...c, namespace: atsNamespace(kind, c.region, c.board) }))

/** At most this many boards in one manifest group (plan Task 3.3). The 301st is refused. */
export const ATS_MAX_BOARDS_PER_GROUP = 300

/**
 * A manifest group: up to 300 boards sharing one `configVersion`. Two entries naming the same
 * board (same region, same slug) are refused: they would collect the same vacancies under one
 * namespace twice.
 */
export const atsBoardGroupSchema = (kind: AtsBoardKind) =>
  z
    .object({
      configVersion: baseSourceConfigSchema.shape.configVersion,
      boards: z.array(atsBoardEntrySchema(kind)).min(1).max(ATS_MAX_BOARDS_PER_GROUP),
    })
    .strict()
    .refine(
      (g) =>
        new Set(g.boards.map((b) => atsNamespace(kind, b.region, b.board))).size ===
        g.boards.length,
      { message: 'a board is listed twice in the group' },
    )
export type AtsBoardGroup = z.infer<ReturnType<typeof atsBoardGroupSchema>>

/** The per-board inputs `parseConfig` takes, in the group's order. */
export function boardConfigsOf(group: AtsBoardGroup) {
  return group.boards.map((b) => ({
    configVersion: group.configVersion,
    board: b.board,
    region: b.region,
    employer: b.employer,
  }))
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
