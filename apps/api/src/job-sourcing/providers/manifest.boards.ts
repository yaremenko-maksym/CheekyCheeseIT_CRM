import { z } from 'zod'
import type { FetchProfile } from '../scheduling/next-slot'
import { type EntryDefinition, ManifestError } from './manifest'

/**
 * Employer boards as data (source fetch strategy ADR, section 8a, unit U8a).
 *
 * One file per ATS provider under `./boards/`, one line per board. `boardEntries` turns the lines of
 * one provider into the `EntryDefinition`s the manifest builder already validates, so everything the
 * builder checks about a hand-written entry (the adapter's own `parseConfig` and so the token
 * charset, the IANA zone, the evidence capture, the host key, duplicate configs) holds for a line.
 *
 * What a file can NOT do, by construction:
 *  - enable a board: the line has no `enabled` key and the schema is strict, and the seed delta
 *    inserts every row disabled;
 *  - make a board due without evidence: `evidence: null` yields an entry carrying the
 *    `NO_BOARD_EVIDENCE` blocker, which the ledger reads as `entryReadiness` BLOCKED. The blocker goes
 *    away only when a PR names committed captures (the supervised smoke's output) that the builder
 *    then reads, and checks the employer against.
 */

/** Owner decision 11: 2 requests a minute per multi-board host (120 an hour). */
export const HOST_REQUESTS_PER_MINUTE = 2

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const BOARD_ADDED_BY = ['manual', 'discovery', 'proposal'] as const

const boardLineSchema = z
  .object({
    token: z.string().regex(TOKEN_PATTERN),
    employer: z.string().min(1).max(200),
    /** `null` is stated, not omitted: a board whose employer has no known domain says so. */
    domain: z.string().min(1).max(253).nullable(),
    /** An IANA zone; the builder's profile check refuses an unknown one. */
    timeZone: z.string().min(1),
    /** Lever only: the API region. */
    region: z.literal('eu').optional(),
    /** Personio only: the feed language. */
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    addedBy: z.enum(BOARD_ADDED_BY),
    /**
     * REQUIRED key. File names of committed captures under the provider's fixture directory, or
     * `null` while the board is awaiting its first supervised smoke.
     */
    evidence: z.array(z.string().min(1)).min(1).nullable(),
  })
  .strict()

export interface BoardEntriesInput {
  /** The id prefix of the provider (`greenhouse` gives `greenhouse.board.<token>`). */
  readonly prefix: string
  /** The parsed content of a board file. Untrusted: validated here. */
  readonly lines: unknown
  /** The provider's default profile, given the board's zone (ADR 8a). */
  readonly profileFor: (timeZone: string) => FetchProfile
}

export function boardEntries({ prefix, lines, profileFor }: BoardEntriesInput): EntryDefinition[] {
  if (!Array.isArray(lines)) {
    throw new ManifestError('BOARD_LINE_INVALID', `${prefix}: a board file holds an array of lines`)
  }
  const seen = new Set<string>()
  return lines.map((raw: unknown, index) => {
    const parsed = boardLineSchema.safeParse(raw)
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join('.') || 'line'}: ${i.message}`)
      throw new ManifestError(
        'BOARD_LINE_INVALID',
        `${prefix} line ${index + 1}: ${why.join('; ')}`,
      )
    }
    const b = parsed.data
    const id = `${prefix}.board.${b.region === undefined ? '' : `${b.region}.`}${b.token}`
    if (seen.has(id)) throw new ManifestError('DUPLICATE_BOARD', `${id} is listed twice`)
    seen.add(id)
    return {
      id,
      config: {
        board: b.token,
        ...(b.region === undefined ? {} : { region: b.region }),
        ...(b.language === undefined ? {} : { language: b.language }),
      },
      fetchProfile: profileFor(b.timeZone),
      ...(b.evidence === null
        ? { awaitingEvidence: true as const }
        : { ownership: { fixtures: b.evidence, name: b.employer, domain: b.domain } }),
    }
  })
}

/**
 * The arithmetic of a host's budget (ADR 8a): `boards` list requests, `perMinute` allowed. A sweep
 * (one list request of every board) takes `boards / perMinute` minutes, so a board is asked about
 * every sweep, and never more often than its profile says.
 */
export function hostSweep(boards: number, perMinute: number) {
  if (!(perMinute > 0)) throw new RangeError('hostSweep: the budget must be positive')
  const sweepMinutes = boards / perMinute
  return {
    sweepMinutes,
    intervalHours: sweepMinutes / 60,
    /** `max(profile interval, sweep)`: freshness degrades with scale; the request rate does not grow. */
    effectiveIntervalMinutes: (profileMinutes: number) => Math.max(profileMinutes, sweepMinutes),
  }
}
