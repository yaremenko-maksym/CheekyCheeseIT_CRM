/**
 * Deterministic fact gate (verified-base-resume Task 9; shared with the tailored plan).
 *
 * AI output may rephrase the source facts but must not add to them: every
 * number, vocabulary skill and capitalised (likely proper) noun in the output
 * has to exist in the source. Pure: no I/O, no Nest providers.
 */
import { canonicalSkill, mentionsSkill, SKILL_SYNONYM_GROUPS } from '@crm/shared'

export interface FactSource {
  text: string
  skills: string[]
}

interface Candidate {
  index: number
  token: string
}

const NUMBER = /\d+(?:\.\d+)?/gu
const CAPITALISED = /(?<![\p{L}\p{N}#+])\p{Lu}[\p{L}\p{N}#+]+/gu
/** Text start, after `.` `!` `?` or a newline, or after a bullet that opens its line. */
const SENTENCE_START = /(?:^|[.!?\n]|(?:^|\n)[^\S\n]*[-*•])\s*$/u
/** Words for locating a skill's surface form; the leading dot keeps `.NET` whole. */
const WORD = /\.?[\p{L}\p{N}#+]+/gu
/** The longest alias in `SKILL_SYNONYM_GROUPS` (`Google Cloud Platform`) has three words. */
const MAX_SKILL_WORDS = 3

/**
 * Skill mentions in `text`, left to right, longest spelling first; a matched
 * window consumes its words, so the `JS` of `Node JS` is not also JavaScript.
 */
function* skillSpans(text: string): Generator<Candidate & { canonical: string }> {
  const words = [...text.matchAll(WORD)]
  let next = 0
  for (const [i, first] of words.entries()) {
    if (i < next) continue
    for (let n = MAX_SKILL_WORDS; n >= 1; n--) {
      const last = words[i + n - 1]
      if (!last) continue // the window runs past the last word
      const token = text.slice(first.index, last.index + last[0].length)
      const canonical = canonicalSkill(token)
      if (SKILL_SYNONYM_GROUPS.some((group) => group.canonical === canonical)) {
        yield { index: first.index, token, canonical }
        next = i + n
        break
      }
    }
  }
}

/**
 * Tokens of `text` absent from `source`, deduplicated case-insensitively in
 * order of first appearance. Numbers match as whole tokens (`140` does not
 * ground `40`); words and skills match case-insensitively through
 * `mentionsSkill`, so a synonym (`Postgres` / `PostgreSQL`) grounds its group.
 * A capitalised word is skipped when it opens a sentence or is one letter long.
 */
export function findUngroundedTokens(text: string, source: FactSource): string[] {
  const output = text.normalize('NFC')
  const grounded = (token: string) =>
    mentionsSkill(source.text, token) || source.skills.some((skill) => mentionsSkill(skill, token))
  const sourceNumbers = new Set(
    [source.text, ...source.skills].flatMap((part) => [...part.matchAll(NUMBER)].map(([n]) => n)),
  )

  const candidates: Candidate[] = []
  for (const m of output.matchAll(NUMBER)) {
    if (!sourceNumbers.has(m[0])) candidates.push({ index: m.index, token: m[0] })
  }
  for (const m of output.matchAll(CAPITALISED)) {
    if (SENTENCE_START.test(output.slice(0, m.index)) || grounded(m[0])) continue
    candidates.push({ index: m.index, token: m[0] })
  }
  const spans = [...skillSpans(output)]
  for (const { canonical } of SKILL_SYNONYM_GROUPS) {
    if (!mentionsSkill(output, canonical) || grounded(canonical)) continue
    // A mention only inside a longer skill (`JS` of `Node JS`) has no span of its own and is not one.
    const span = spans.find((s) => s.canonical === canonical)
    if (span) candidates.push(span)
  }

  const seen = new Set<string>()
  return candidates
    .sort((a, b) => a.index - b.index)
    .map(({ token }) => token)
    .filter((token) => {
      const key = token.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
