import { canonicalSkill, type TailoredVerification } from '@crm/shared'
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

/** The writer's feedback for a cover sentence naming the employer; it never quotes the name. */
const NAMES_EMPLOYER = 'it names the employer; write "your team" or "this role" instead'

/**
 * Look-alike letters, each beside the Latin letter of its shape (`LATIN`), case by case: `Ν` is N
 * and `ν` is v. Every letter is one UTF-16 unit, so an index into one indexes the other.
 */
export const LOOKALIKE = 'аеорсухіјѕԁԛԝвкмнтАВЕКМНОРСТХІЈЅУԀԚԜһҺӏүҮҽοαενρτυκβζηιμχΑΒΕΖΗΙΚΜΝΟΡΤΥΧɑ'
export const LATIN = 'aeopcyxijsdqwbkmhtABEKMHOPCTXIJSYDQWhHlyYeoaevptukbzniuxABEZHIKMNOPTYXa'

/** For matching only: NFKC, invisible characters and accents dropped, one space per run. */
const plain = (t: string): string =>
  t
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')

/** `plain`, then each look-alike letter as its Latin letter. */
const latin = (t: string): string =>
  [...plain(t)]
    .map((c) => {
      const i = LOOKALIKE.indexOf(c)
      return i < 0 ? c : (LATIN[i] as string)
    })
    .join('')

/** A trailing "(...)" and a trailing legal suffix; both literal, anchored and linear. */
const PARENTHETICAL = / ?\([^()]*\)$/u
const LEGAL_SUFFIX =
  /(?:, ?| )(?:& co|inc|llc|llp|ltd|limited|gmbh|ag|se|kg|co|corp|plc|pty|b\.?v|s\.?a|nv|oy|ab|srl|sarl|sp\. z o\.o)\.?$/iu

/**
 * Whether a text names `employer`: case-insensitive, a whole run of words (no letter or digit on
 * either side, so "Meta" is not in "metadata" or "met a"), under either folding of both sides:
 * `plain`, or `latin` for look-alike letters. The name is matched without its trailing
 * parentheticals and legal suffixes, four passes at most ("Acme" for "Acme GmbH & Co. KG"), which
 * also covers its full form; a name that is nothing else is matched whole. A blank employer names
 * nothing.
 */
function employerMatcher(employer: string): (text: string) => boolean {
  const matchers = [plain, latin].map((fold) => {
    const full = fold(employer).trim()
    let name = full
    for (let pass = 0; pass < 4; pass++) {
      name = name.replace(PARENTHETICAL, '').replace(LEGAL_SUFFIX, '')
    }
    name ||= full
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
    return (text: string) => name !== '' && re.test(fold(text))
  })
  return (text) => matchers.some((m) => m(text))
}

/**
 * Gates 10 and 11 on every model-written text of `draft` (or only the `units` given): a contact
 * (the senior's names, emails, phone, Telegram), the fact gate over the whole payload, skills a
 * subset of the base's, then Jev entailment: a bullet against the payload notes its
 * `sourceIndices` name, a summary or cover sentence against the payload statements. Every sentence
 * is gated as written, and the posting never grounds a claim. The letter never names the company
 * (owner decision 2026-11-22): a cover sentence holding the posting employer name (`employerMatcher`)
 * fails UNGROUNDED before the fact gate and Jev, even when that employer is in the facts; a name
 * found only across sentences fails the letter as a whole, and then none of its sentences goes to
 * the fact gate or Jev. The title is not matched: its words are generic and a past role can share them. Any other
 * posting-only token fails the fact gate only when it is capitalised mid-sentence; the rest is
 * Jev's to judge. The cover letter body is 100..220 words; its greeting and closing are the CRM's
 * and never gated.
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
    const namesEmployer = employerMatcher(prepared.posting.employerName)
    const gated: Text[] = []
    for (const t of sentencesOf(COVER, draft.coverBody, statements)) {
      if (namesEmployer(t.text)) {
        failing.push({ path: t.path, reason: 'UNGROUNDED', detail: NAMES_EMPLOYER })
      } else gated.push(t)
    }
    // A name holding ". ", "! " or "? " ("Dr. Oetker") spans sentences: the letter fails as a whole.
    // The letter is regenerated whole, so none of its sentences goes to the fact gate or Jev.
    if (namesEmployer(gated.map((t) => t.text).join(' '))) {
      failing.push({ path: COVER, reason: 'UNGROUNDED', detail: NAMES_EMPLOYER })
    } else failing.push(...(await gate(gated, source, prepared, deps)))
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
