import { RESUME_LIMITS } from '@crm/shared'
import { MAX_POSTING_CHARS, type TailorBody } from '../extraction-worker/link-contract'
import { feedbackLine, redactAll, type WritingPayload } from '../resumes/verification/content-gates'
import type { ContactContext } from '../resumes/verification/contact-scan'
import type { Analysis } from './tailored-analysis'
import {
  bodyPosting,
  fitTailor,
  MAX_EMPLOYER_CHARS,
  MAX_TITLE_CHARS,
  tailorFits,
  type PreparedRun,
} from './tailored-prepare'

const MAX_FEEDBACK_LINES = 20

/** Every string of the payload JSON redacted, one value at a time, re-serialised canonically. */
function redactPayload(payload: string, contacts: readonly ContactContext[]): WritingPayload {
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return redactAll(v, contacts)
    if (Array.isArray(v)) return v.map(deep)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
    }
    return v
  }
  return deep(JSON.parse(payload)) as WritingPayload
}

/**
 * The run as the writer, the gates and the reviewer see it (R19, at the client boundary): the
 * senior's contacts redacted from every payload, posting and requirement field (each cut back to
 * its body cap, since a redaction marker can be longer than the text it replaces), the analysis
 * buckets, and the payload refitted to the worker cap against them.
 */
export function sanitizeRun(prepared: PreparedRun, analysis: Analysis): PreparedRun {
  const r = (text: string, max: number) => redactAll(text, prepared.contacts).slice(0, max)
  const posting = {
    ...prepared.posting,
    title: r(prepared.posting.title, MAX_TITLE_CHARS),
    employerName: r(prepared.posting.employerName, MAX_EMPLOYER_CHARS),
    text: r(prepared.posting.text, MAX_POSTING_CHARS),
  }
  const requirements = analysis.requirements.map((q) => ({
    name: r(q.name, RESUME_LIMITS.shortText),
    bucket: q.bucket,
  }))
  const payload = redactPayload(prepared.payload, prepared.contacts)
  const fitted = fitTailor(payload, bodyPosting({ posting, requirements }), [])
  return {
    ...prepared,
    payload: JSON.stringify(fitted.payload),
    posting,
    requirements,
    sentItems: fitted.sentItems,
  }
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
    feedback: feedback.slice(0, MAX_FEEDBACK_LINES).map((f) => feedbackLine(f, run.contacts)),
  }
  while (!tailorFits(body) && body.feedback.length > 0) {
    body = { ...body, feedback: body.feedback.slice(0, -1) }
  }
  return body
}
