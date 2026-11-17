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
/** A dot glued to the word (`.NET`, `Node.JS`) makes it part of a dotted token, left to the skill rule. */
const CAPITALISED = /(?<![\p{L}\p{N}#+.])\p{Lu}[\p{L}\p{N}#+]+/gu
/**
 * Text start, after `.` `!` `?` or a newline, or after a bullet or an item
 * number (`1)`) that opens its line. Not after `:`, which would hide `Stack: Kafka`.
 */
const SENTENCE_START = /(?:^|[.!?\n]|(?:^|\n)[^\S\n]*(?:[-*•–—▪]|\d+\)))\s*$/u
/** All caps, an inner capital or a digit (`AWS`, `GitHub`, `S3`): a name even when it opens a sentence. */
const NAME_SHAPED = /.\p{Lu}|\p{N}/u
/** Skill spellings that are also everyday English words when written in lowercase. */
const ENGLISH_WORDS = new Set([
  'go',
  'rest',
  'react',
  'node',
  'swift',
  'spark',
  'unity',
  'unreal',
  'solidity',
  'flutter',
  'playwright',
  'selenium',
  'android',
])
/**
 * Everyday words that are also a spelling of a role-stack skill group (`spark` of Apache Spark,
 * `unity` of Unity, `unreal` of Unreal Engine). Lowercase in the source they ground only
 * themselves, never another spelling of the group: "spark interest" does not ground `Apache Spark`,
 * "team unity" does not ground `Unity3D`. Older words (`node`, `go`) keep their grounding.
 * Inside a full spelling (`apache spark`, `unreal engine`, `unity 3d`) the word is the skill, not masked;
 * the words may be joined by whitespace, a dash or an underscore, as `stackTokens` folds them all.
 */
const EVERYDAY_ALIASES =
  /(?<![\p{L}\p{N}#+.])(?:(?<![Aa]pache[\s\p{Pd}_]+)spark|unity(?![\s\p{Pd}_]+3[dD])|unreal(?![\s\p{Pd}_]+[Ee]ngine))(?![\p{L}\p{N}#+])/gu
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
  const grounded = (token: string) => {
    const lower = token.toLowerCase()
    // Stryker disable next-line StringLiteral: the masked word sits between non-token characters on both sides, so '' and ' ' tokenise alike (probed: 23,716 source shapes x every dictionary spelling, 0 differences)
    const text = source.text.replace(EVERYDAY_ALIASES, (word) => (word === lower ? word : ' '))
    return mentionsSkill(text, token) || source.skills.some((skill) => mentionsSkill(skill, token))
  }
  const sourceNumbers = new Set(
    [source.text, ...source.skills].flatMap((part) => [...part.matchAll(NUMBER)].map(([n]) => n)),
  )

  const candidates: Candidate[] = []
  for (const m of output.matchAll(NUMBER)) {
    if (!sourceNumbers.has(m[0])) candidates.push({ index: m.index, token: m[0] })
  }
  for (const m of output.matchAll(CAPITALISED)) {
    if (grounded(m[0])) continue
    if (SENTENCE_START.test(output.slice(0, m.index)) && !NAME_SHAPED.test(m[0])) continue
    candidates.push({ index: m.index, token: m[0] })
  }
  const spans = [...skillSpans(output)]
  for (const { canonical } of SKILL_SYNONYM_GROUPS) {
    if (!mentionsSkill(output, canonical) || grounded(canonical)) continue
    // A mention only inside a longer skill (`JS` of `Node JS`) has no span of its own and is not one.
    // `go-live`, `the rest of`, `react to`, `each node`: English, not the skill;
    // so is `Go-live …` / `Rest of …` opening a sentence, where the capital says nothing
    const english = (s: Candidate) =>
      ENGLISH_WORDS.has(s.token) ||
      (ENGLISH_WORDS.has(s.token.toLowerCase()) && SENTENCE_START.test(output.slice(0, s.index)))
    const span = spans.find((s) => s.canonical === canonical && !english(s) && !grounded(s.token))
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
