import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import type {
  ResumeContent,
  ResumeFacts,
  ResumeReportReason,
  ResumeVerificationErrorCode,
} from '@crm/shared'
import { toRenderableText, type GlyphFontSet } from '../resume-glyphs'
import { redactContacts, scanContacts, scanContexts, type ContactContext } from './contact-scan'
import { yearsOfExperience } from './derive-content'
import { findUngroundedTokens, type FactSource } from './fact-gate'
import {
  ENTAILMENT_PROVIDER,
  ENTAILMENT_THRESHOLD,
  resumeWriteInput,
  unavailableOrigin,
  WRITER_PROVIDER,
  type EntailmentClaim,
  type EntailmentScores,
  type WriterReply,
  type WriterTask,
  type WritingPayload,
} from './inference-clients'
import type { RunOrigin } from './run-columns'

/** One entry of `verification_report.gates`: a run writes only the shared reason codes (R46). */
export type GateResult = {
  gate: string
  ok: boolean
  items: { path: string; reason: ResumeReportReason }[]
}

/** Ends the run FAILED with `code`; `gates` are the stage results gathered so far. */
export class RunFailure extends Error {
  constructor(
    readonly code: ResumeVerificationErrorCode,
    readonly gates: GateResult[] = [],
    /** The provider that failed, for the log only (FR-A-2). */
    readonly origin: RunOrigin | null = null,
  ) {
    super(code)
    this.name = 'RunFailure'
  }
}

export interface ContentDeps {
  writer: { write(task: WriterTask, payload: string, feedback: string[]): Promise<WriterReply> }
  entailment: { score(claims: EntailmentClaim[]): Promise<EntailmentScores> }
  /** Runs before every model call; throws `RunFailure('STALLED')` past the run budget. */
  beforeModelCall(): Promise<void>
}

export interface ContentInput {
  facts: ResumeFacts
  frozen: ResumeContent
  /** One context per distinct name of the senior, each with every email of the senior. */
  contacts: ContactContext[]
  template: GlyphFontSet
  now: Date
}

export interface WrittenContent {
  content: ResumeContent
  gate: GateResult
  /** `summary` and `experience.<i>.bullets` paths that fell back to the notes (P10). */
  fallbacks: string[]
}

/**
 * The minimised facts (spec §5.2): never the name, an email, location, education, languages or
 * links. The shape is the worker link contract's `writingPayloadSchema`, inferred rather than
 * restated, so the producer below cannot build a key the worker would refuse (item 460).
 */
export type { WritingPayload }
type PayloadItem = WritingPayload['experience'][number]

export type Failure = { index: number; reason: ResumeReportReason; detail: string }

/** The first draft and two regenerations. */
const MAX_ATTEMPTS = 3
/** The most feedback lines one writer request carries (the tailored writer shares the cap). */
export const MAX_FEEDBACK_ITEMS = 20
const MAX_FEEDBACK_CHARS = 1000
/** Well under the entailment client's 256 KB request cap, leaving room for the questions. */
const MAX_CLAIM_GROUP_BYTES = 128_000
export const REDACTED = '[REDACTED]'

/** Every contact of every name context replaced, one raw field at a time (P8). */
export function redactAll(text: string, contacts: readonly ContactContext[]): string {
  return redactContacts(text, contacts)
}

/** A name, an email, a phone or the Telegram handle in `text` (or a redaction marker left in it). */
export function hasContact(text: string, contacts: readonly ContactContext[]): boolean {
  return (
    text.includes(REDACTED) ||
    scanContexts(contacts).some((ctx) => scanContacts(text, ctx).length > 0)
  )
}

/** Note text as a fallback bullet list: whitespace collapsed, blanks dropped. */
export function cleanedNotes(notes: readonly string[]): string[] {
  return notes.map((note) => note.replace(/\s+/gu, ' ').trim()).filter(Boolean)
}

export function writingPayload(input: ContentInput): WritingPayload {
  const r = (text: string) => redactAll(text, input.contacts)
  return {
    headline: r(input.facts.headline),
    skills: input.frozen.skills.map(r),
    yearsOfExperience: yearsOfExperience(input.facts.experience, input.now),
    experience: input.facts.experience.map((item) => ({
      company: r(item.company),
      role: r(item.role),
      start: item.start,
      end: item.end,
      current: item.current,
      technologies: item.technologies.map(r),
      notes: cleanedNotes(item.notes).map(r),
    })),
  }
}

/** Whether the worker accepts a request of this payload JSON and these feedback lines. */
export type WorkerFits = (payload: string, feedback: string[]) => boolean

/** `/resume-write`: its user message is at most 50 000 chars (P9). */
const resumeWriteFits: WorkerFits = (payload, feedback) =>
  resumeWriteInput(payload, feedback).length <= MAX_EXTRACTION_INPUT_CHARS

/**
 * The payload and feedback the worker accepts (`fits`, by default `/resume-write`'s cap).
 * Trailing experience items go first, never the first one (so a bullets call keeps its one item);
 * then feedback lines go, last first.
 */
export function fitToWorker(
  payload: WritingPayload,
  feedback: string[],
  workerFits: WorkerFits = resumeWriteFits,
): { payload: WritingPayload; feedback: string[] } {
  let p = payload
  let f = feedback
  const fits = () => workerFits(JSON.stringify(p), f)
  while (!fits() && p.experience.length > 1) {
    p = { ...p, experience: p.experience.slice(0, -1) }
  }
  while (!fits() && f.length > 0) f = f.slice(0, -1)
  return { payload: p, feedback: f }
}

function itemStatements(item: PayloadItem): string[] {
  const end = item.current ? 'present' : (item.end ?? 'unknown')
  return [
    `${item.role} at ${item.company}, from ${item.start ?? 'unknown'} to ${end}`,
    ...(item.technologies.length > 0
      ? [`Technologies at ${item.company}: ${item.technologies.join(', ')}`]
      : []),
    ...item.notes,
  ]
}

/** The payload as source statements for the entailment check of the summary. */
export function payloadStatements(p: WritingPayload): string[] {
  return [
    p.headline,
    `Skills: ${p.skills.join(', ')}`,
    `${p.yearsOfExperience} years of experience`,
    ...p.experience.flatMap(itemStatements),
  ].filter((s) => s.trim() !== '')
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Groups claims so each entailment request stays under its size cap. */
export function groupClaims(claims: readonly EntailmentClaim[]): EntailmentClaim[][] {
  const groups: EntailmentClaim[][] = []
  let size = 0
  for (const claim of claims) {
    const bytes = Buffer.byteLength(JSON.stringify(claim))
    const last = groups.at(-1)
    if (last && size + bytes <= MAX_CLAIM_GROUP_BYTES) {
      last.push(claim)
      size += bytes
    } else {
      groups.push([claim])
      size = bytes
    }
  }
  return groups
}

/**
 * Contact scan, then the fact gate, then Jev for the texts that passed both. Fails closed.
 * `sources` is the entailment source of every text, or of text `i` when it is a function (a
 * tailored bullet is judged against its own source bullets).
 */
export async function gateTexts(
  texts: string[],
  source: FactSource,
  sources: string[] | ((index: number) => string[]),
  input: Pick<ContentInput, 'contacts'>,
  deps: Pick<ContentDeps, 'entailment' | 'beforeModelCall'>,
): Promise<Failure[]> {
  const sourcesOf = typeof sources === 'function' ? sources : () => sources
  const failures: Failure[] = []
  const claims: EntailmentClaim[] = []
  texts.forEach((text, index) => {
    if (text === '') {
      failures.push({ index, reason: 'EMPTY', detail: 'it is empty' })
    } else if (hasContact(text, input.contacts)) {
      failures.push({
        index,
        reason: 'CONTACT_IN_TEXT',
        detail: 'it contains a name, an email address, a phone number, a link or a Telegram handle',
      })
    } else {
      const ungrounded = findUngroundedTokens(text, source)
      if (ungrounded.length > 0) {
        failures.push({
          index,
          reason: 'UNGROUNDED',
          detail: `it states things that are not in FACTS: ${ungrounded.join(', ')}`,
        })
      } else {
        claims.push({ id: `c${index}`, text, sources: sourcesOf(index) })
      }
    }
  })
  for (const group of groupClaims(claims)) {
    await deps.beforeModelCall()
    const scores = await deps.entailment.score(group)
    if (!(scores instanceof Map)) {
      throw new RunFailure('ENTAILMENT_UNAVAILABLE', [], {
        provider: ENTAILMENT_PROVIDER,
        reason: scores.cause,
      })
    }
    for (const claim of group) {
      // a missing score never reads as supported
      if ((scores.get(claim.id) ?? 0) < ENTAILMENT_THRESHOLD) {
        failures.push({
          index: Number(claim.id.slice(1)),
          reason: 'NOT_SUPPORTED',
          detail: 'FACTS do not support it',
        })
      }
    }
  }
  return failures.sort((a, b) => a.index - b.index)
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a redaction marker (the cut moves before
 * it) nor between the two halves of a surrogate pair.
 */
export function safeCut(text: string, max: number): string {
  let end = max
  const marker = text.lastIndexOf(REDACTED, end - 1)
  if (marker >= 0 && marker + REDACTED.length > end) end = marker
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * One feedback line the worker accepts: every line break it refuses (CR, LF, NEL, LS, PS, VT, FF)
 * becomes a space (SPEC-M-1) BEFORE the redaction, so a contact split by a break is redacted as
 * the joined text the model reads; then cut to 1000 chars (`safeCut`).
 */
export function feedbackLine(text: string, contacts: readonly ContactContext[]): string {
  const joined = text.replace(/[\r\n\u0085\u2028\u2029\x0B\x0C]+/gu, ' ')
  return safeCut(redactAll(joined, contacts), MAX_FEEDBACK_CHARS)
}

/** One line per failure (`feedbackLine`), at most 20 lines (the worker's limits). */
export function toFeedback(
  label: string,
  failures: readonly Failure[],
  contacts: readonly ContactContext[],
): string[] {
  return failures.slice(0, MAX_FEEDBACK_ITEMS).map((f) => {
    const line = f.index < 0 ? `${f.detail}.` : `${label} ${f.index + 1}: ${f.detail}.`
    return feedbackLine(line, contacts)
  })
}

async function write(
  task: WriterTask,
  sent: { payload: WritingPayload; feedback: string[] },
  deps: ContentDeps,
): Promise<Exclude<WriterReply, { kind: 'unavailable' }>> {
  await deps.beforeModelCall()
  const reply = await deps.writer.write(task, JSON.stringify(sent.payload), sent.feedback)
  if (reply.kind === 'unavailable') {
    throw new RunFailure('WRITER_UNAVAILABLE', [], unavailableOrigin(WRITER_PROVIDER, reply))
  }
  return reply
}

const BAD_INDEX: Failure = {
  index: -1,
  reason: 'BAD_INDEX',
  detail: 'Return exactly one item, with index 0, for the one experience item in FACTS',
}

async function writeSummary(
  input: ContentInput,
  payload: WritingPayload,
  deps: ContentDeps,
  clean: (text: string) => string,
): Promise<{ summary: string; failures: Failure[] }> {
  let feedback: string[] = []
  for (let attempt = 1; ; attempt++) {
    const sent = fitToWorker(payload, feedback)
    const reply = await write('summary', sent, deps)
    const summary = clean('summary' in reply ? reply.summary : '')
    const sentences = splitSentences(summary)
    const statements = payloadStatements(sent.payload)
    // The statements already list every skill and technology of the payload.
    const source = { text: statements.join('\n'), skills: [] }
    const failures: Failure[] =
      sentences.length === 0
        ? [{ index: -1, reason: 'EMPTY', detail: 'The summary is empty' }]
        : await gateTexts(sentences, source, statements, input, deps)
    if (failures.length === 0) return { summary, failures }
    if (attempt === MAX_ATTEMPTS) return { summary: '', failures }
    feedback = toFeedback('Sentence', failures, input.contacts)
  }
}

async function writeBullets(
  input: ContentInput,
  payload: WritingPayload,
  i: number,
  deps: ContentDeps,
  clean: (text: string) => string,
): Promise<{ bullets: string[] | null; failures: Failure[] }> {
  const item = payload.experience[i] as PayloadItem
  const statements = itemStatements(item)
  const source = { text: statements.join('\n'), skills: [...item.technologies, ...payload.skills] }
  let feedback: string[] = []
  for (let attempt = 1; ; attempt++) {
    // One item per call (P9): the only valid reply is exactly one item with index 0 (P8).
    const sent = fitToWorker({ ...payload, experience: [item] }, feedback)
    const reply = await write('bullets', sent, deps)
    const only = 'items' in reply && reply.items.length === 1 ? reply.items[0] : undefined
    let failures = [BAD_INDEX]
    if (only?.index === 0) {
      const bullets = only.bullets.map(clean)
      failures = await gateTexts(bullets, source, statements, input, deps)
      if (failures.length === 0) return { bullets, failures }
    }
    if (attempt === MAX_ATTEMPTS) return { bullets: null, failures }
    feedback = toFeedback('Bullet', failures, input.contacts)
  }
}

/** Model text as one renderable line: toRenderableText trims each line and drops blank edges. */
export function cleaner(template: GlyphFontSet): (text: string) => string {
  return (text) =>
    toRenderableText(text, template, { insertBreaks: false }).text.replace(/\s+/gu, ' ')
}

/**
 * Stages 3 and 4: writes the summary and every item's bullets, gates each, regenerates a failing one
 * up to twice with feedback, then falls back (summary to '', bullets to the cleaned notes).
 */
export async function writeGatedContent(
  input: ContentInput,
  deps: ContentDeps,
): Promise<WrittenContent> {
  const clean = cleaner(input.template)
  const payload = writingPayload(input)
  const items: GateResult['items'] = []
  const fallbacks: string[] = []

  const summary = await writeSummary(input, payload, deps, clean)
  if (summary.failures.length > 0) {
    fallbacks.push('summary')
    for (const f of summary.failures) items.push({ path: 'summary', reason: f.reason })
  }

  const experience: ResumeContent['experience'] = []
  for (const [i, frozen] of input.frozen.experience.entries()) {
    const written = await writeBullets(input, payload, i, deps, clean)
    if (written.bullets === null) {
      const path = `experience.${i}.bullets`
      fallbacks.push(path)
      for (const f of written.failures) items.push({ path, reason: f.reason })
    }
    experience.push({
      ...frozen,
      // Stryker disable next-line OptionalChaining: frozen is derived from facts item by item, so facts.experience[i] always exists
      bullets: written.bullets ?? cleanedNotes(input.facts.experience[i]?.notes ?? []),
    })
  }

  return {
    content: { ...input.frozen, summary: summary.summary, experience },
    gate: { gate: 'content', ok: fallbacks.length === 0, items },
    fallbacks,
  }
}

/**
 * Stages 3 and 4 of an `item` run (P10) for one path, `summary` or the bullets of item `target`:
 * written and gated like a full run, every other text of `base` (the staged content) kept as is.
 */
export async function writeGatedField(
  input: ContentInput,
  deps: ContentDeps,
  target: 'summary' | number,
  base: ResumeContent,
): Promise<WrittenContent> {
  const clean = cleaner(input.template)
  const payload = writingPayload(input)
  let content: ResumeContent
  let path: string
  let failures: Failure[]
  if (target === 'summary') {
    const written = await writeSummary(input, payload, deps, clean)
    // A summary failing every attempt keeps the previous one, as failed bullets fall back (FR-A-4).
    content = { ...base, summary: written.failures.length > 0 ? base.summary : written.summary }
    path = 'summary'
    failures = written.failures
  } else {
    const written = await writeBullets(input, payload, target, deps, clean)
    // Stryker disable next-line OptionalChaining: equivalent — the start UPDATE checked target against the staged items, which mirror the facts
    const bullets = written.bullets ?? cleanedNotes(input.facts.experience[target]?.notes ?? [])
    content = {
      ...base,
      experience: base.experience.map((item, i) => (i === target ? { ...item, bullets } : item)),
    }
    path = `experience.${target}.bullets`
    // writeBullets returns bullets only with no failures, so these are the fallback's reasons
    failures = written.failures
  }
  return {
    content,
    gate: {
      gate: 'content',
      ok: failures.length === 0,
      items: failures.map((f) => ({ path, reason: f.reason })),
    },
    fallbacks: failures.length > 0 ? [path] : [],
  }
}
