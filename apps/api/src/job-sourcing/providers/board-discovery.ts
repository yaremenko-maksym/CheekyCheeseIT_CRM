import type { Pool } from 'pg'
import {
  ASHBY_HOST,
  GH_HOST,
  LEVER_HOST,
  PERSONIO_HOST,
  RECRUITEE_HOST,
  WORKABLE_HOST,
} from '../identity/ats-job-key'
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
  /** The host patterns `ats-job-key` already treats as this vendor's board hosts (EU variants included). */
  readonly host: RegExp
  /** `path`: the token is the first path segment; `subdomain`: group 1 of the host pattern. */
  readonly tokenAt: 'path' | 'subdomain'
  /** Substring the SQL prefilter looks for; looser than `host` on purpose, the parse is the gate. */
  readonly like: string
}

/** The public board URL shapes of ADR 8a, hosts from `ats-job-key`. */
export const BOARD_URL_SHAPES: readonly BoardUrlShape[] = [
  {
    provider: 'greenhouse',
    kind: GREENHOUSE_KIND,
    host: GH_HOST,
    tokenAt: 'path',
    like: 'greenhouse.io',
  },
  { provider: 'lever', kind: LEVER_KIND, host: LEVER_HOST, tokenAt: 'path', like: 'lever.co' },
  {
    provider: 'ashby',
    kind: ASHBY_KIND,
    host: ASHBY_HOST,
    tokenAt: 'path',
    like: 'jobs.ashbyhq.com',
  },
  {
    provider: 'workable',
    kind: WORKABLE_KIND,
    host: WORKABLE_HOST,
    tokenAt: 'path',
    like: 'apply.workable.com',
  },
  {
    provider: 'recruitee',
    kind: RECRUITEE_KIND,
    host: RECRUITEE_HOST,
    tokenAt: 'subdomain',
    like: 'recruitee.com',
  },
  {
    provider: 'personio',
    kind: PERSONIO_KIND,
    host: PERSONIO_HOST,
    tokenAt: 'subdomain',
    like: 'jobs.personio.',
  },
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
    const m = host.exec(url.hostname)
    if (m === null) continue
    const candidate = tokenAt === 'path' ? url.pathname.split('/')[1] : m[1]
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
 * `provider:token` of EVERY board file line, regional ones (Lever EU) included: a token a file
 * already lists is never offered again, whichever deployment's URL named it.
 */
export function knownBoardTokens(files: BoardLines = COMMITTED_BOARDS): Set<string> {
  const known = new Set<string>()
  for (const [provider, lines] of Object.entries(files)) {
    for (const line of lines ?? []) {
      const { token } = line as { token?: unknown }
      if (typeof token === 'string') known.add(`${provider}:${token}`)
    }
  }
  return known
}

export type DiscoveryRow = {
  /** The record's non-null URLs (original, display, application). */
  urls: string[]
  opportunity_id: string | null
  /** LEAD or TRIAGE rows of the linked opportunity (EXCLUDED is not a match). */
  matches: number
}

/** What a `pg` Pool or client offers; the one seam of this module. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: DiscoveryRow[] }>
}

/** Typed adapter over a `pg` Pool: the row type is checked, no cast. */
export function queryablePool(pool: Pick<Pool, 'query'>): Queryable {
  return {
    query: async (text, values) => {
      const { rows } = await pool.query<DiscoveryRow>(text, values)
      return { rows }
    },
  }
}

export interface DiscoveredBoard extends BoardRef {
  readonly opportunities: number
  readonly matches: number
}

// Cheap prefilter so the database hands back only candidate rows; the parse above is the real gate.
const DISCOVERY_SQL = `SELECT array_remove(ARRAY[r.original_url, r.display_url, r.application_url], NULL) AS urls,
  l.opportunity_id,
  COALESCE((SELECT count(*) FROM job_opportunity_matches m
            WHERE m.opportunity_id = l.opportunity_id AND m.outcome <> 'EXCLUDED'), 0)::int AS matches
FROM job_source_records r
LEFT JOIN job_opportunity_sources l ON l.source_record_id = r.id AND l.unlinked_at IS NULL
WHERE r.original_url ILIKE ANY($1) OR r.display_url ILIKE ANY($1) OR r.application_url ILIKE ANY($1)`

/** Board tokens in stored record URLs that no board file lists, with distinct opportunity and match counts. */
export async function discoverBoardTokens(
  db: Queryable,
  known: ReadonlySet<string> = knownBoardTokens(),
): Promise<DiscoveredBoard[]> {
  const patterns = BOARD_URL_SHAPES.map((s) => `%${s.like}%`)
  const { rows } = await db.query(DISCOVERY_SQL, [patterns])
  // provider:token -> opportunity id -> matches; one entry per opportunity however many URLs named it
  const found = new Map<string, { ref: BoardRef; opportunities: Map<string, number> }>()
  for (const row of rows) {
    const refs = new Map<string, BoardRef>()
    for (const url of row.urls) {
      const ref = boardTokenFromUrl(url)
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
