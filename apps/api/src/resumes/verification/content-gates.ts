import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import type { ResumeContent, ResumeFacts, ResumeVerificationErrorCode } from '@crm/shared'
import { resumeWriteInput } from '../../extraction-worker/resume-write'
import { toRenderableText, type GlyphFontSet } from '../resume-glyphs'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'
import { yearsOfExperience } from './derive-content'
import { findUngroundedTokens, type FactSource } from './fact-gate'
import {
  ENTAILMENT_THRESHOLD,
  type EntailmentClaim,
  type WriterReply,
  type WriterTask,
} from './inference-clients'

/** One entry of `verification_report.gates`. */
export type GateResult = { gate: string; ok: boolean; items: { path: string; reason: string }[] }

/** Ends the run FAILED with `code`; `gates` are the stage results gathered so far. */
export class RunFailure extends Error {
  constructor(
    readonly code: ResumeVerificationErrorCode,
    readonly gates: GateResult[] = [],
  ) {
    super(code)
    this.name = 'RunFailure'
  }
}

export interface ContentDeps {
  writer: { write(task: WriterTask, payload: string, feedback: string[]): Promise<WriterReply> }
  entailment: { score(claims: EntailmentClaim[]): Promise<Map<string, number> | 'unavailable'> }
  /** Runs before every model call; throws `RunFailure('STALLED')` past the run budget. */
  beforeModelCall(): void
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

interface PayloadItem {
  company: string
  role: string
  start: string | null
  end: string | null
  current: boolean
  technologies: string[]
  notes: string[]
}
/** The minimised facts (spec §5.2): never the name, an email, location, education, languages or links. */
export interface WritingPayload {
  headline: string
  skills: string[]
  yearsOfExperience: number
  experience: PayloadItem[]
}

type Failure = { index: number; reason: string; detail: string }

/** The first draft and two regenerations. */
const MAX_ATTEMPTS = 3
const MAX_FEEDBACK_ITEMS = 20
const MAX_FEEDBACK_CHARS = 1000
/** Well under the entailment client's 256 KB request cap, leaving room for the questions. */
const MAX_CLAIM_GROUP_BYTES = 128_000
const REDACTED = '[REDACTED]'

/** Every contact of every name context replaced, one raw field at a time (P8). */
export function redactAll(text: string, contacts: readonly ContactContext[]): string {
  return contacts.reduce((acc, ctx) => redactContacts(acc, ctx), text)
}

function hasContact(text: string, contacts: readonly ContactContext[]): boolean {
  return text.includes(REDACTED) || contacts.some((ctx) => scanContacts(text, ctx).length > 0)
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

/**
 * The payload and feedback the worker accepts: its user message is at most 50 000 chars (P9). The
 * summary drops trailing experience items first; then feedback lines go, last first.
 */
export function fitToWorker(
  payload: WritingPayload,
  feedback: string[],
  dropItems: boolean,
): { payload: WritingPayload; feedback: string[] } {
  let p = payload
  let f = feedback
  const fits = () => resumeWriteInput(JSON.stringify(p), f).length <= MAX_EXTRACTION_INPUT_CHARS
  while (!fits() && dropItems && p.experience.length > 1) {
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
    .split(/(?<=[.!?])\s+/u)
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

/** Contact scan, then the fact gate, then Jev for the texts that passed both. Fails closed. */
async function gateTexts(
  texts: string[],
  source: FactSource,
  sources: string[],
  input: ContentInput,
  deps: ContentDeps,
): Promise<Failure[]> {
  const failures: Failure[] = []
  const claims: EntailmentClaim[] = []
  texts.forEach((text, index) => {
    if (text === '') {
      failures.push({ index, reason: 'EMPTY', detail: 'it is empty' })
    } else if (hasContact(text, input.contacts)) {
      failures.push({
        index,
        reason: 'CONTACT_IN_TEXT',
        detail: 'it contains a name, an email address or a phone number',
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
        claims.push({ id: `c${index}`, text, sources })
      }
    }
  })
  for (const group of groupClaims(claims)) {
    deps.beforeModelCall()
    const scores = await deps.entailment.score(group)
    if (scores === 'unavailable') throw new RunFailure('ENTAILMENT_UNAVAILABLE')
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

/** One line per failure, redacted, no CR/LF, at most 1000 chars and 20 lines (the worker's limits). */
export function toFeedback(
  label: string,
  failures: readonly Failure[],
  contacts: readonly ContactContext[],
): string[] {
  return failures.slice(0, MAX_FEEDBACK_ITEMS).map((f) => {
    const line = f.index < 0 ? `${f.detail}.` : `${label} ${f.index + 1}: ${f.detail}.`
    return redactAll(line, contacts)
      .replace(/[\r\n]+/gu, ' ')
      .slice(0, MAX_FEEDBACK_CHARS)
  })
}

async function write(
  task: WriterTask,
  sent: { payload: WritingPayload; feedback: string[] },
  deps: ContentDeps,
): Promise<Exclude<WriterReply, { kind: 'unavailable' }>> {
  deps.beforeModelCall()
  const reply = await deps.writer.write(task, JSON.stringify(sent.payload), sent.feedback)
  if (reply.kind === 'unavailable') throw new RunFailure('WRITER_UNAVAILABLE')
  return reply
}

function allSkills(p: WritingPayload): string[] {
  return [...p.skills, ...p.experience.flatMap((item) => item.technologies)]
}

async function writeSummary(
  input: ContentInput,
  payload: WritingPayload,
  deps: ContentDeps,
  clean: (text: string) => string,
): Promise<{ summary: string; failures: Failure[] }> {
  let feedback: string[] = []
  let failures: Failure[] = []
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const sent = fitToWorker(payload, feedback, true)
    const reply = await write('summary', sent, deps)
    const summary = clean('summary' in reply ? reply.summary : '')
    const sentences = splitSentences(summary)
    const statements = payloadStatements(sent.payload)
    const source = { text: statements.join('\n'), skills: allSkills(sent.payload) }
    failures =
      sentences.length === 0
        ? [{ index: -1, reason: 'EMPTY', detail: 'The summary is empty' }]
        : await gateTexts(sentences, source, statements, input, deps)
    if (failures.length === 0) return { summary, failures }
    feedback = toFeedback('Sentence', failures, input.contacts)
  }
  return { summary: '', failures }
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
  let failures: Failure[] = []
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // One item per call (P9): the only valid reply is exactly one item with index 0 (P8).
    const sent = fitToWorker({ ...payload, experience: [item] }, feedback, false)
    const reply = await write('bullets', sent, deps)
    const items = 'items' in reply ? reply.items : []
    const only = items.length === 1 && items[0]?.index === 0 ? items[0] : undefined
    if (only === undefined) {
      failures = [
        {
          index: -1,
          reason: 'BAD_INDEX',
          detail: 'Return exactly one item, with index 0, for the one experience item in FACTS',
        },
      ]
    } else {
      const bullets = only.bullets.map(clean)
      failures = await gateTexts(bullets, source, statements, input, deps)
      if (failures.length === 0) return { bullets, failures }
    }
    feedback = toFeedback('Bullet', failures, input.contacts)
  }
  return { bullets: null, failures }
}

/**
 * Stages 3 and 4: writes the summary and every item's bullets, gates each, regenerates a failing one
 * up to twice with feedback, then falls back (summary to '', bullets to the cleaned notes).
 */
export async function writeGatedContent(
  input: ContentInput,
  deps: ContentDeps,
): Promise<WrittenContent> {
  const clean = (text: string) =>
    toRenderableText(text, input.template, { insertBreaks: false })
      .text.replace(/\s+/gu, ' ')
      .trim()
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
      bullets: written.bullets ?? cleanedNotes(input.facts.experience[i]?.notes ?? []),
    })
  }

  return {
    content: { ...input.frozen, summary: summary.summary, experience },
    gate: { gate: 'content', ok: fallbacks.length === 0, items },
    fallbacks,
  }
}
