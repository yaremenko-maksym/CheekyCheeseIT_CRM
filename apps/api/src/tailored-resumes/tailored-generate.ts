import type { ResumeContent, TailoredVerification } from '@crm/shared'
import type { TailorBody } from '../extraction-worker/link-contract'
import {
  cleaner,
  feedbackLine,
  MAX_FEEDBACK_ITEMS,
  splitSentences,
  type WritingPayload,
} from '../resumes/verification/content-gates'
import { TAILOR_PROVIDER, type TailorReply, type TailorWriterClient } from './tailor-writer.client'
import type { Analysis, DecisionClient } from './tailored-analysis'
import {
  bulletPath,
  COVER_MAX_WORDS,
  COVER_MIN_WORDS,
  frozenFieldsEqual,
  mergeDraft,
  sourceBullets,
  validateTailorReply,
  wordCount,
  type BulletRef,
  type FailingItem,
  type TailoredDraft,
} from './tailored-draft'
import { COVER, gateDraft, SKILLS, SUMMARY, type GateDeps } from './tailored-gates'
import { bodyPosting, fitTailor, redactRun, tailorFits, type PreparedRun } from './tailored-prepare'
import { applyVerdicts, rescore, REVIEW_REWRITE_REASON, reviewBullets } from './tailored-review'
import { TailoredRunFailure } from './tailored-run'

/** D19: the first draft, two repairs and the cover letter's own regeneration. */
export const MAX_GENERATION_CALLS = 4
const MAX_CONTENT_CALLS = MAX_GENERATION_CALLS - 1

/**
 * The run as the writer, the gates and the reviewer see it: `redactRun` with the analysis
 * buckets, and the payload refitted to the worker cap against them.
 */
export function sanitizeRun(prepared: PreparedRun, analysis: Analysis): PreparedRun {
  const run = redactRun({ ...prepared, requirements: analysis.requirements })
  const { posting, requirements } = run
  const payload = JSON.parse(run.payload) as WritingPayload
  // Feedback is fitted per call (tailorBody); here the payload alone is fitted to the cap.
  const fitted = fitTailor(payload, bodyPosting({ posting, requirements }), [])
  return { ...run, payload: JSON.stringify(fitted.payload), sentItems: fitted.sentItems }
}

/**
 * The `/resume-tailor` body for a sanitised run: each feedback line one redacted line
 * (`feedbackLine`), at most 20, then trimmed last first until the worker's input fits. The payload
 * never shrinks here, so every reply of a run answers the same `sentItems`.
 */
export function tailorBody(run: PreparedRun, feedback: readonly string[]): TailorBody {
  let body: TailorBody = {
    payload: run.payload,
    posting: bodyPosting(run),
    feedback: feedback.slice(0, MAX_FEEDBACK_ITEMS).map((f) => feedbackLine(f, run.contacts)),
  }
  while (!tailorFits(body) && body.feedback.length > 0) {
    body = { ...body, feedback: body.feedback.slice(0, -1) }
  }
  return body
}

export type GenerateDeps = GateDeps & {
  writer: Pick<TailorWriterClient, 'tailor'>
  decision: DecisionClient
}

export type Generated = {
  content: ResumeContent
  coverBody: string
  /** Coverage and routes are the runner's (plan Task 10). */
  verification: Omit<TailoredVerification, 'coverage' | 'routes'>
  /** The bullets scored after content repair: changed, reverted, or never sent to the writer. */
  changedBullets: BulletRef[]
  /** The relevance score per bullet text (layout repair looks scores up by text). */
  relevance: Map<string, number>
  fit: number
}

type Bullet = TailoredDraft['items'][number]['bullets'][number]
type Writer = { calls: number; run: PreparedRun; deps: GenerateDeps }
/** The failing items per gate unit: `summary`, `skills`, `coverLetter` or a bullet path. */
type Pending = Map<string, FailingItem[]>

const writerFailure = (reason: 'INVALID_INPUT' | 'INVALID_OUTPUT'): TailoredRunFailure =>
  new TailoredRunFailure('WRITER_UNAVAILABLE', [], { provider: TAILOR_PROVIDER, reason })

/**
 * One writer call (each one a slot of `MAX_GENERATION_CALLS`), after the run budget check. A body
 * over the worker cap even with no feedback (a first item too long on its own) fails before both.
 */
async function write(w: Writer, feedback: readonly string[]): Promise<TailorReply> {
  const body = tailorBody(w.run, feedback)
  if (!tailorFits(body)) throw writerFailure('INVALID_INPUT')
  await w.deps.beforeModelCall()
  w.calls += 1
  const reply = await w.deps.writer.tailor(body)
  if (reply.kind === 'unavailable') {
    const origin = { provider: TAILOR_PROVIDER, reason: reply.reason, status: reply.status }
    const code = reply.reason === 'LIMITS_EXHAUSTED' ? 'LIMITS_EXHAUSTED' : 'WRITER_UNAVAILABLE'
    throw new TailoredRunFailure(code, [], origin)
  }
  return reply
}

// Stryker disable next-line Regex: every path comes from bulletPath or a gate (no prefix, no suffix); multi-digit indexes are tested
const BULLET = /^experience\.(\d+)\.bullets\.(\d+)$/u

/** The item and bullet of a bullet path; `undefined` for the other units. */
function indexesOf(path: string): { i: number; j: number } | undefined {
  const m = BULLET.exec(path)
  return m === null ? undefined : { i: Number(m[1]), j: Number(m[2]) }
}

const unitOf = (path: string): string =>
  indexesOf(path) === undefined ? (path.split('.')[0] as string) : path

/** A path names an item of the draft it was gated on (a validated draft has every sent item). */
const bulletsOf = (draft: TailoredDraft, i: number): Bullet[] =>
  (draft.items[i] as TailoredDraft['items'][number]).bullets

const refsOf = (items: readonly { bullets: readonly unknown[] }[]): BulletRef[] =>
  items.flatMap((item, i) =>
    item.bullets.map((_, j) => ({ item: i, bullet: j, path: bulletPath(i, j) })),
  )

function group(items: readonly FailingItem[]): Pending {
  const pending: Pending = new Map()
  for (const f of items) {
    const unit = unitOf(f.path)
    pending.set(unit, [...(pending.get(unit) ?? []), f])
  }
  return pending
}

/** A gate failed the unit's text; a unit with only the reviewer's `rewrite` passed the gates. */
const gateFailing = (items: readonly FailingItem[]): boolean =>
  items.some((f) => f.reason !== REVIEW_REWRITE_REASON)

const PLACES: Record<string, string> = {
  summary: 'Summary',
  skills: 'Skills',
  coverLetter: 'Cover letter',
}
/** The reasons a gate gives without a detail of its own. */
const REASONS: Record<string, string> = {
  EMPTY: 'it is empty',
  COVER_LENGTH: `the letter body must be ${COVER_MIN_WORDS} to ${COVER_MAX_WORDS} words`,
  CONTACT_IN_TEXT: 'it contains a name, an email address, a phone number or a handle',
}

/** Where a failing item is, in the writer's terms; a bullet also names its notes. */
function place(path: string, draft: TailoredDraft): string {
  const at = indexesOf(path)
  if (at !== undefined) {
    const own = bulletsOf(draft, at.i)[at.j] as Bullet
    return `Experience item ${at.i + 1}, bullet ${at.j + 1} (sourceIndices ${own.sourceIndices.join(', ')})`
  }
  const [unit, k] = path.split('.') as [string, string?]
  return k === undefined ? (PLACES[unit] as string) : `${PLACES[unit]} sentence ${Number(k) + 1}`
}

/** The CRM's own feedback: a place, then the gate's detail, a fixed reason or the reviewer line. */
function feedbackOf(pending: Pending, draft: TailoredDraft): string[] {
  return [...pending.values()]
    .flat()
    .map((f) => `${place(f.path, draft)}: ${f.detail ?? REASONS[f.reason] ?? f.reason}.`)
}

const sameSources = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((k) => b.includes(k))

/**
 * One repair round. Each pending unit takes the reply's text: a bullet takes the reply's bullet of
 * the same item with the same `sourceIndices` (none, and it stays pending as it is). Only those
 * units are gated again. One that passes is resolved; one that fails stays pending with the new
 * failures, except a rewrite of a bullet that had passed the gates, which keeps its previous text
 * and leaves pending (it is never fed back again).
 */
async function repair(
  draft: TailoredDraft,
  next: TailoredDraft,
  pending: Pending,
  run: PreparedRun,
  deps: GateDeps,
): Promise<TailoredDraft> {
  const cand: TailoredDraft = {
    ...draft,
    items: draft.items.map((item) => ({ bullets: [...item.bullets] })),
  }
  const units = new Set<string>()
  for (const unit of pending.keys()) {
    const at = indexesOf(unit)
    if (at === undefined) {
      if (unit === SUMMARY) cand.summary = next.summary
      else if (unit === SKILLS) cand.skills = next.skills
      else cand.coverBody = next.coverBody
    } else {
      const own = bulletsOf(draft, at.i)[at.j] as Bullet
      const theirs = bulletsOf(next, at.i).find((b) =>
        sameSources(b.sourceIndices, own.sourceIndices),
      )
      if (theirs === undefined) continue
      bulletsOf(cand, at.i)[at.j] = { text: theirs.text, sourceIndices: own.sourceIndices }
    }
    units.add(unit)
  }
  const failed = group((await gateDraft(cand, run, deps, units)).failing)
  for (const unit of units) {
    const now = failed.get(unit)
    if (now === undefined) pending.delete(unit)
    else if (gateFailing(pending.get(unit) as FailingItem[])) pending.set(unit, now)
    else {
      // Only a bullet carries a reviewer rewrite.
      const at = indexesOf(unit) as { i: number; j: number }
      bulletsOf(cand, at.i)[at.j] = bulletsOf(draft, at.i)[at.j] as Bullet
      pending.delete(unit)
    }
  }
  return cand
}

/**
 * The cover letter after the last repair: its failing sentences removed. When that removes more
 * than half of them, leaves under 100 words, or the body failed as a whole (empty, length), the
 * letter is regenerated once, in the last writer slot, and gated again; any failure then ends the
 * run with COVER_LETTER_UNGROUNDED. Only the reply's letter is used.
 */
async function finalCover(
  w: Writer,
  draft: TailoredDraft,
  failures: readonly FailingItem[],
): Promise<string> {
  const sentences = splitSentences(draft.coverBody)
  const dropped = new Set(failures.map((f) => f.path))
  const kept = sentences.filter((_, k) => !dropped.has(`${COVER}.${k}`))
  const body = kept.join(' ')
  const gutted =
    dropped.has(COVER) ||
    (sentences.length - kept.length) * 2 > sentences.length ||
    wordCount(body) < COVER_MIN_WORDS
  if (!gutted) return body
  const reply = await write(w, feedbackOf(new Map([[COVER, [...failures]]]), draft))
  const letter = cleaner(w.run.base.templateName)(reply.coverLetter)
  const gated = await gateDraft({ ...draft, coverBody: letter }, w.run, w.deps, new Set([COVER]))
  if (!gated.gate.ok) throw new TailoredRunFailure('COVER_LETTER_UNGROUNDED', [gated.gate])
  return letter
}

/**
 * Spec §6.4 items 9–12 and content repair: the first draft (an invalid reply is retried once with
 * the validation feedback; invalid twice in a row → WRITER_UNAVAILABLE / INVALID_OUTPUT), the
 * reviewer's verdicts, gates 10 and 11, up to two repairs with the failing items and the reviewer's
 * rewrites fed back, then the reverts: a bullet to the base bullets of its `sourceIndices` (each its
 * own bullet), the summary and the skills to the base's, a cover sentence removed. Every bullet
 * without a score from the first review is scored at the end.
 */
export async function generateVerified(
  prepared: PreparedRun,
  analysis: Analysis,
  deps: GenerateDeps,
): Promise<Generated> {
  const run = sanitizeRun(prepared, analysis)
  const base = prepared.base.content
  const w: Writer = { calls: 0, run, deps }
  const draftOf = async (feedback: readonly string[]) =>
    validateTailorReply(await write(w, feedback), base, run.sentItems, run.base.templateName)

  let first = await draftOf([])
  if (!first.ok) first = await draftOf(first.feedback)
  if (!first.ok) throw writerFailure('INVALID_OUTPUT')

  // The reviewer goes before the gates: its cuts settle the bullet paths every later step uses.
  await deps.beforeModelCall()
  const firstRefs = refsOf(first.draft.items)
  const review = await reviewBullets(
    deps.decision,
    mergeDraft(base, first.draft),
    firstRefs,
    run,
    analysis.injectionSuspected,
  )
  // A bullet keeps its score while it is the same object: a repair or a revert makes a new one.
  const scores = new Map(
    firstRefs.map((ref) => [
      bulletsOf(first.draft, ref.item)[ref.bullet] as Bullet,
      review.relevance.get(ref.path),
    ]),
  )
  const cut = applyVerdicts(first.draft, review.verdicts)
  let draft = cut.draft
  const pending = group([...(await gateDraft(draft, run, deps)).failing, ...cut.rewrite])

  let invalid: string[] = []
  while (pending.size > 0 && w.calls < MAX_CONTENT_CALLS) {
    const next = await draftOf([...invalid, ...feedbackOf(pending, draft)])
    if (next.ok) {
      invalid = []
      draft = await repair(draft, next.draft, pending, run, deps)
    } else if (invalid.length > 0) throw writerFailure('INVALID_OUTPUT')
    else invalid = next.feedback
  }

  const failing = new Map([...pending].filter(([, items]) => gateFailing(items)))
  // Every reverted path names the returned content: a bullet of two sources is two base bullets.
  const revertedPaths: string[] = []
  const items = draft.items.map((item, i) => {
    const bullets: Bullet[] = []
    for (const [j, b] of item.bullets.entries()) {
      if (!failing.has(bulletPath(i, j))) {
        bullets.push(b)
        continue
      }
      const notes = sourceBullets(base, i)
      for (const k of b.sourceIndices) {
        revertedPaths.push(bulletPath(i, bullets.length))
        // Stryker disable next-line ArrayDeclaration: a reverted bullet is only merged (text), never gated again
        bullets.push({ text: notes[k] as string, sourceIndices: [k] })
      }
    }
    return { bullets }
  })
  let { summary, skills } = draft
  if (failing.has(SUMMARY)) {
    summary = base.summary
    revertedPaths.push(SUMMARY)
  }
  if (failing.has(SKILLS)) {
    skills = base.skills
    revertedPaths.push(SKILLS)
  }
  const reverted: TailoredDraft = { summary, skills, items, coverBody: draft.coverBody }
  // Stryker disable next-line ArrayDeclaration: a cover with no failure is returned as it is (finalCover)
  const coverBody = await finalCover(w, reverted, failing.get(COVER) ?? [])
  const content = mergeDraft(base, { ...reverted, coverBody })
  // Gate 9 as an assertion: mergeDraft copies every frozen field from the base.
  // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable by construction
  if (!frozenFieldsEqual(base, content)) throw new TailoredRunFailure('INTERNAL_ERROR')

  const known = new Map<string, number>()
  items.forEach((item, i) =>
    item.bullets.forEach((b, j) => {
      const s = scores.get(b)
      if (s !== undefined) known.set(bulletPath(i, j), s)
    }),
  )
  const refs = refsOf(content.experience)
  const changedBullets = refs.filter((ref) => !known.has(ref.path))
  await deps.beforeModelCall()
  const more = await rescore(
    deps.decision,
    content,
    changedBullets,
    run,
    analysis.injectionSuspected,
  )
  const relevance = new Map<string, number>()
  for (const ref of refs) {
    const s = known.get(ref.path) ?? more.get(ref.path)
    const text = (content.experience[ref.item] as ResumeContent['experience'][number]).bullets[
      ref.bullet
    ] as string
    if (s !== undefined && !relevance.has(text)) relevance.set(text, s)
  }

  return {
    content,
    coverBody,
    verification: {
      // The gate reports the returned content, which passes by construction: every failing unit
      // was reverted to the base or removed, or the regenerated letter passed (else the run threw).
      gates: [{ gate: 'content', ok: true, items: [] }],
      revertedPaths,
      keptFromBase: revertedPaths.length,
      gaps: run.requirements.filter((r) => r.bucket === 'gap').map((r) => r.name),
      injectionSuspected: analysis.injectionSuspected,
      postingPartial: run.posting.partial,
      postingTruncated: run.posting.truncated,
    },
    changedBullets,
    relevance,
    fit: review.fit,
  }
}
