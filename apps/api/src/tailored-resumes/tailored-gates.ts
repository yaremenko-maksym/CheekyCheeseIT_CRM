import {
  canonicalSkill,
  SKILL_SYNONYM_GROUPS,
  skillMentions,
  TECHNOLOGIES,
  type TailoredVerification,
} from '@crm/shared'
import {
  gateTexts,
  hasContact,
  payloadStatements,
  RunFailure,
  splitSentences,
  type ContentDeps,
  type Failure,
  type WritingPayload,
} from '../resumes/verification/content-gates'
import type { FactSource } from '../resumes/verification/fact-gate'
import type { RunOrigin } from '../resumes/verification/run-columns'
import { jevFailure } from './tailored-analysis'
import {
  bulletPath,
  COVER_MAX_WORDS,
  COVER_MIN_WORDS,
  wordCount,
  type FailingItem,
  type TailoredDraft,
} from './tailored-draft'
import type { PreparedRun } from './tailored-prepare'

export type GateDeps = Pick<ContentDeps, 'entailment' | 'beforeModelCall'>
export type ContentGate = TailoredVerification['gates'][number]

/** A gate unit: `summary`, `skills`, `coverLetter` or a bullet path. */
export const SUMMARY = 'summary'
export const SKILLS = 'skills'
export const COVER = 'coverLetter'

type Text = { path: string; text: string; sources: string[] }

/** `gateTexts` over `texts`, its failures under each text's path; a Jev outage as the tailored failure. */
async function gate(
  texts: readonly Text[],
  source: FactSource,
  prepared: PreparedRun,
  deps: GateDeps,
): Promise<FailingItem[]> {
  let failures: Failure[]
  try {
    failures = await gateTexts(
      texts.map((t) => t.text),
      source,
      // gateTexts passes the index of a text it was given
      (i) => (texts[i] as Text).sources,
      { contacts: [...prepared.contacts] },
      deps,
    )
  } catch (err) {
    if (err instanceof RunFailure && err.code === 'ENTAILMENT_UNAVAILABLE') {
      // gateTexts sets the entailment origin on every ENTAILMENT_UNAVAILABLE it throws
      throw jevFailure('ENTAILMENT_UNAVAILABLE', (err.origin as RunOrigin).reason)
    }
    throw err
  }
  return failures.map((f) => ({
    path: (texts[f.index] as Text).path,
    reason: f.reason,
    detail: f.detail,
  }))
}

const sentencesOf = (prefix: string, text: string, sources: string[]): Text[] =>
  splitSentences(text).map((s, k) => ({ path: `${prefix}.${k}`, text: s, sources }))

/** The cover letter's only premise beyond the payload; the posting's own words never ground a claim. */
export const APPLYING = 'the senior is applying to the role at the company'

/**
 * A title-shaped posting string: at most `MAX_NAME_TOKENS` tokens of letters (and `-` `/` `&` `+`
 * `#` inside), no clause word. Anything else (a digit, punctuation, a sentence) could carry a claim.
 */
const NAME_TOKEN = /^[\p{L}&/][\p{L}\-/&+#]*$/u
const MAX_NAME_TOKENS = 6
const CLAUSE_WORDS = new Set([
  'led',
  'managed',
  'built',
  'shipped',
  'delivered',
  'worked',
  'owned',
  'has',
  'have',
  'had',
  'is',
  'was',
  'years',
  'team',
  'experience',
])
const titleShaped = (literal: string): boolean => {
  const tokens = literal.split(/ +/u)
  return (
    tokens.length <= MAX_NAME_TOKENS &&
    tokens.every((t) => NAME_TOKEN.test(t) && !CLAUSE_WORDS.has(t.toLowerCase()))
  )
}
const KNOWN_SKILLS = [...SKILL_SYNONYM_GROUPS.map((g) => g.canonical), ...TECHNOLOGIES]
/** A token character on either side ends a whole-token match (`fact-gate`'s token alphabet). */
const TOKEN = '[\\p{L}\\p{N}#+]'

/**
 * A matcher of `literal` as whole tokens, case-insensitive, or `null` when `literal` must be gated
 * as written: not title-shaped (empty included), naming a known skill, or holding a contact.
 */
function neutralMatcher(literal: string, contacts: PreparedRun['contacts']): RegExp | null {
  const mentions = skillMentions(literal)
  if (!titleShaped(literal) || KNOWN_SKILLS.some(mentions)) return null
  if (hasContact(literal, contacts)) return null
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<!${TOKEN})${escaped}(?!${TOKEN})`, 'giu')
}

/**
 * Gates 10 and 11 on every model-written text of `draft` (or only the `units` given): a contact
 * (the senior's names, emails, phone, Telegram), the fact gate over the whole payload, skills a
 * subset of the base's, then Jev entailment: a bullet against the payload notes its
 * `sourceIndices` name, a summary sentence against the payload statements, a cover sentence also
 * against `APPLYING`. The posting is untrusted text, so its title and employer never ground a
 * claim: in a cover sentence a whole-token occurrence reads as "the role" / "the company" before
 * the fact gate and Jev, and only when that string carries no claim of its own (`neutralMatcher`);
 * otherwise the sentence is gated as written. The
 * cover letter body is 100..220 words; its greeting and closing are the CRM's and never gated.
 */
export async function gateDraft(
  draft: TailoredDraft,
  prepared: PreparedRun,
  deps: GateDeps,
  units?: ReadonlySet<string>,
): Promise<{ failing: FailingItem[]; gate: ContentGate }> {
  const wanted = (unit: string) => units === undefined || units.has(unit)
  const payload = JSON.parse(prepared.payload) as WritingPayload
  const statements = payloadStatements(payload)
  const source: FactSource = { text: statements.join('\n'), skills: payload.skills }
  const failing: FailingItem[] = []

  const texts: Text[] = []
  if (wanted(SUMMARY)) {
    const sentences = sentencesOf(SUMMARY, draft.summary, statements)
    if (sentences.length === 0) failing.push({ path: SUMMARY, reason: 'EMPTY' })
    texts.push(...sentences)
  }
  draft.items.forEach((item, i) => {
    // A validated draft has one item per sent payload item, and in-range sourceIndices.
    const notes = (payload.experience[i] as WritingPayload['experience'][number]).notes
    item.bullets.forEach((b, j) => {
      const path = bulletPath(i, j)
      if (!wanted(path)) return
      texts.push({ path, text: b.text, sources: b.sourceIndices.map((k) => notes[k] as string) })
    })
  })
  failing.push(...(await gate(texts, source, prepared, deps)))

  if (wanted(SKILLS)) {
    const own = new Set(payload.skills.flatMap((s) => [s, canonicalSkill(s)]))
    if (draft.skills.some((s) => hasContact(s, prepared.contacts))) {
      failing.push({ path: SKILLS, reason: 'CONTACT_IN_TEXT' })
    } else if (draft.skills.some((s) => !own.has(s))) {
      failing.push({ path: SKILLS, reason: 'UNGROUNDED' })
    }
  }

  if (wanted(COVER)) {
    const words = wordCount(draft.coverBody)
    if (words === 0) failing.push({ path: COVER, reason: 'EMPTY' })
    else if (words < COVER_MIN_WORDS || words > COVER_MAX_WORDS) {
      failing.push({ path: COVER, reason: 'COVER_LENGTH' })
    }
    const { title, employerName } = prepared.posting
    const neutrals: [RegExp | null, string][] = [
      [neutralMatcher(title, prepared.contacts), 'the role'],
      [neutralMatcher(employerName, prepared.contacts), 'the company'],
    ]
    const neutral = (text: string) =>
      neutrals.reduce((t, [re, word]) => (re === null ? t : t.replace(re, word)), text)
    // A sentence with a contact is gated as written, so the contact scan sees the original text.
    const sentences = sentencesOf(COVER, draft.coverBody, [...statements, APPLYING]).map((t) =>
      hasContact(t.text, prepared.contacts) ? t : { ...t, text: neutral(t.text) },
    )
    failing.push(...(await gate(sentences, source, prepared, deps)))
  }

  return {
    failing,
    gate: {
      gate: 'content',
      ok: failing.length === 0,
      items: failing.map(({ path, reason }) => ({ path, reason })),
    },
  }
}
