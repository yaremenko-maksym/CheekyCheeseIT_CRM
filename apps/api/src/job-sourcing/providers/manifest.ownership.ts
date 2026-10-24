/**
 * Reading what a fixture's provenance says about who owns a board, and how strongly.
 *
 * Its own small module so the adapter specs that read these figures (Lever, Ashby, Greenhouse,
 * `ats-config`) depend on THIS file and not on the manifest builder: a mutation run re-executes every
 * spec related to a mutated file, and the builder's several hundred mutants must not drag four
 * unrelated adapter suites along with them.
 */

export type OwnershipEvidence = 'PAYLOAD_FIELD' | 'TEXT_FULL' | 'TEXT_PARTIAL'

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
