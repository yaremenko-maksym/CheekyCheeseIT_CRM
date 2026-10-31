import { ASHBY_BOARDS } from './boards/ashby.boards'
import { GREENHOUSE_BOARDS } from './boards/greenhouse.boards'
import { LEVER_BOARDS } from './boards/lever.boards'
import { PERSONIO_BOARDS } from './boards/personio.boards'
import { RECRUITEE_BOARDS } from './boards/recruitee.boards'
import { WORKABLE_BOARDS } from './boards/workable.boards'
import {
  ASHBY_KIND,
  GREENHOUSE_KIND,
  LEVER_KIND,
  PERSONIO_KIND,
  RECRUITEE_KIND,
  WORKABLE_KIND,
  type AtsBoardKind,
} from './sources/ats-config'

/**
 * Board discovery (source fetch strategy ADR, section 8a, unit U8b): which employer boards do the
 * stored source records already point at that no board file lists yet?
 *
 * SENDS NO REQUEST. It reads three URL columns of rows we already hold and parses the strings; there
 * is no network import in this module. The token gate is the adapters' own (`AtsBoardKind`): a token
 * that an adapter would refuse in `parseConfig` is never listed, so the output is always a valid
 * board-file `token`.
 */

export type BoardProvider = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | 'personio'

interface BoardUrlShape {
  readonly provider: BoardProvider
  readonly kind: AtsBoardKind
  readonly host: string
  /** `path`: the token is the first path segment; `subdomain`: the one label left of the host. */
  readonly tokenAt: 'path' | 'subdomain'
}

/** The public board URL shapes of ADR 8a. */
export const BOARD_URL_SHAPES: readonly BoardUrlShape[] = [
  { provider: 'greenhouse', kind: GREENHOUSE_KIND, host: 'boards.greenhouse.io', tokenAt: 'path' },
  { provider: 'lever', kind: LEVER_KIND, host: 'jobs.lever.co', tokenAt: 'path' },
  { provider: 'ashby', kind: ASHBY_KIND, host: 'jobs.ashbyhq.com', tokenAt: 'path' },
  { provider: 'workable', kind: WORKABLE_KIND, host: 'apply.workable.com', tokenAt: 'path' },
  { provider: 'recruitee', kind: RECRUITEE_KIND, host: 'recruitee.com', tokenAt: 'subdomain' },
  { provider: 'personio', kind: PERSONIO_KIND, host: 'jobs.personio.de', tokenAt: 'subdomain' },
]

export interface BoardRef {
  readonly provider: BoardProvider
  readonly token: string
}

/** The board a URL points at, or `null`. Pure; the token is lower-cased as the adapters require. */
export function boardTokenFromUrl(raw: string): BoardRef | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  for (const { provider, kind, host, tokenAt } of BOARD_URL_SHAPES) {
    let candidate: string | undefined
    if (tokenAt === 'path') {
      if (url.hostname === host) candidate = url.pathname.split('/')[1]
    } else if (url.hostname.endsWith(`.${host}`)) {
      candidate = url.hostname.slice(0, -(host.length + 1))
    }
    if (candidate === undefined) continue
    const token = candidate.toLowerCase()
    if (token.length <= kind.slugMaxChars && kind.slugPattern.test(token)) {
      return { provider, token }
    }
  }
  return null
}

type BoardLines = Partial<Record<BoardProvider, readonly unknown[]>>

const COMMITTED_BOARDS: BoardLines = {
  greenhouse: GREENHOUSE_BOARDS,
  lever: LEVER_BOARDS,
  ashby: ASHBY_BOARDS,
  workable: WORKABLE_BOARDS,
  recruitee: RECRUITEE_BOARDS,
  personio: PERSONIO_BOARDS,
}

/**
 * `provider:token` of every board file line. A Lever EU board is a different board from the global
 * one of the same token, and discovery only reads the global shape, so those lines are left out.
 */
export function knownBoardTokens(files: BoardLines = COMMITTED_BOARDS): Set<string> {
  const known = new Set<string>()
  for (const [provider, lines] of Object.entries(files)) {
    for (const line of lines ?? []) {
      const { token, region } = line as { token?: unknown; region?: unknown }
      if (typeof token === 'string' && region === undefined) known.add(`${provider}:${token}`)
    }
  }
  return known
}

export interface DiscoveryRow {
  original_url: string | null
  display_url: string | null
  application_url: string | null
  opportunity_id: string | null
  /** LEAD or TRIAGE rows of the linked opportunity (EXCLUDED is not a match). */
  matches: number
}

/** What a `pg` Pool or client offers; the one seam of this module. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: DiscoveryRow[] }>
}

export interface DiscoveredBoard extends BoardRef {
  readonly opportunities: number
  readonly matches: number
}

const URL_COLUMNS = ['original_url', 'display_url', 'application_url'] as const

// Cheap prefilter so the database hands back only candidate rows; the parse above is the real gate.
const DISCOVERY_SQL = `SELECT r.original_url, r.display_url, r.application_url,
  l.opportunity_id,
  COALESCE((SELECT count(*) FROM job_opportunity_matches m
            WHERE m.opportunity_id = l.opportunity_id AND m.outcome <> 'EXCLUDED'), 0)::int AS matches
FROM job_source_records r
LEFT JOIN job_opportunity_sources l ON l.source_record_id = r.id AND l.unlinked_at IS NULL
WHERE ${URL_COLUMNS.map((c) => `r.${c} ILIKE ANY($1)`).join(' OR ')}`

/** Board tokens in stored record URLs that no board file lists, with distinct opportunity and match counts. */
export async function discoverBoardTokens(
  db: Queryable,
  known: ReadonlySet<string> = knownBoardTokens(),
): Promise<DiscoveredBoard[]> {
  const patterns = BOARD_URL_SHAPES.map((s) => `%${s.host}%`)
  const { rows } = await db.query(DISCOVERY_SQL, [patterns])
  // provider:token -> opportunity id -> matches; one entry per opportunity however many URLs named it
  const found = new Map<string, { ref: BoardRef; opportunities: Map<string, number> }>()
  for (const row of rows) {
    const refs = new Map<string, BoardRef>()
    for (const column of URL_COLUMNS) {
      const raw = row[column]
      const ref = raw === null ? null : boardTokenFromUrl(raw)
      if (ref !== null) refs.set(`${ref.provider}:${ref.token}`, ref)
    }
    for (const [key, ref] of refs) {
      if (known.has(key)) continue
      const entry = found.get(key) ?? { ref, opportunities: new Map() }
      found.set(key, entry)
      if (row.opportunity_id !== null) entry.opportunities.set(row.opportunity_id, row.matches)
    }
  }
  return [...found.values()]
    .map(({ ref, opportunities }) => ({
      ...ref,
      opportunities: opportunities.size,
      matches: [...opportunities.values()].reduce((a, b) => a + b, 0),
    }))
    .sort(
      (a, b) =>
        b.opportunities - a.opportunities ||
        b.matches - a.matches ||
        a.provider.localeCompare(b.provider) ||
        a.token.localeCompare(b.token),
    )
}
