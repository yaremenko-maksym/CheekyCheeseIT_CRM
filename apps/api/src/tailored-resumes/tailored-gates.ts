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
      (i) => texts[i]?.sources ?? [],
      { contacts: [...prepared.contacts] },
      deps,
    )
  } catch (err) {
    if (err instanceof RunFailure && err.code === 'ENTAILMENT_UNAVAILABLE') {
      throw jevFailure('ENTAILMENT_UNAVAILABLE', err.origin?.reason ?? 'unknown')
    }
    throw err
  }
  return failures.map((f) => ({
    path: texts[f.index]?.path ?? '',
    reason: f.reason,
    detail: f.detail,
  }))
}

const sentencesOf = (prefix: string, text: string, sources: string[]): Text[] =>
  splitSentences(text).map((s, k) => ({ path: `${prefix}.${k}`, text: s, sources }))

/**
 * Gates 10 and 11 on every model-written text of `draft` (or only the `units` given): a contact
 * (the senior's names, emails, phone, Telegram), the fact gate over the whole payload (the cover
 * letter also over the posting's employer and title), skills a subset of the base's, then Jev
 * entailment: a bullet against the payload notes its `sourceIndices` name, a summary or cover
 * sentence against the payload statements and the application itself. The cover letter body is
 * 100..220 words; its greeting and closing are the CRM's and never gated.
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
  const applying = `the senior is applying to ${prepared.posting.title} at ${prepared.posting.employerName}`
  const prose = [...statements, applying]
  const source: FactSource = { text: statements.join('\n'), skills: payload.skills }
  const failing: FailingItem[] = []

  const texts: Text[] = []
  if (wanted(SUMMARY)) {
    const sentences = sentencesOf(SUMMARY, draft.summary, prose)
    if (sentences.length === 0) failing.push({ path: SUMMARY, reason: 'EMPTY' })
    texts.push(...sentences)
  }
  draft.items.forEach((item, i) => {
    const notes = payload.experience[i]?.notes ?? []
    item.bullets.forEach((b, j) => {
      const path = bulletPath(i, j)
      if (!wanted(path)) return
      texts.push({ path, text: b.text, sources: b.sourceIndices.map((k) => notes[k] ?? '') })
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
    const coverSource: FactSource = {
      text: [source.text, prepared.posting.employerName, prepared.posting.title].join('\n'),
      skills: source.skills,
    }
    failing.push(
      ...(await gate(sentencesOf(COVER, draft.coverBody, prose), coverSource, prepared, deps)),
    )
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
