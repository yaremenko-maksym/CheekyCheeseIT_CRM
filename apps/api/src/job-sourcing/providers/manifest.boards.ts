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
 *
 * The evidence check proves only that a committed capture names the employer (whole-word match); a
 * human PR review still judges that the capture is authentic.
 *
 * Per-host request rate (owner decision Q11) is NOT enforced here or by any board type today: no
 * `hostRate` is declared for the board types until U11 adds the request-counting host budget.
 */

const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const BOARD_ADDED_BY = ['manual', 'discovery', 'proposal'] as const

const boardLineSchema = z
  .object({
    token: z.string().regex(TOKEN_PATTERN),
    /** At least 3 characters: the evidence check looks for the whole name in a capture's notes. */
    employer: z.string().min(3).max(200),
    /** `null` is stated, not omitted. A hostname: lowercase labels, a dot, no scheme, path or port. */
    domain: z.string().regex(HOSTNAME_PATTERN).nullable(),
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
  /**
   * Shared by every provider's call: employer name (case-insensitive) and domain already claimed by
   * a board, so the same employer under two ATS types is refused (DUPLICATE_EMPLOYER).
   */
  readonly claimed?: Map<string, string>
}

export function boardEntries({
  prefix,
  lines,
  profileFor,
  claimed,
}: BoardEntriesInput): EntryDefinition[] {
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
    if (claimed !== undefined) {
      const keys = [
        `employer:${b.employer.toLowerCase()}`,
        ...(b.domain === null ? [] : [`domain:${b.domain}`]),
      ]
      for (const key of keys) {
        const other = claimed.get(key)
        if (other !== undefined) {
          throw new ManifestError(
            'DUPLICATE_EMPLOYER',
            `${id} repeats ${key} already listed as ${other}`,
          )
        }
      }
      for (const key of keys) claimed.set(key, id)
    }
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
