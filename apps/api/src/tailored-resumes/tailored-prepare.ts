import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import {
  RESUME_LIMITS,
  type JobSourceType,
  type ResumeContent,
  type ResumeLayoutOptions,
  type ResumeTemplateName,
  type TailoredResumeErrorCode,
} from '@crm/shared'
import { eq } from 'drizzle-orm'
import type { DatabaseService } from '../database/database.service'
import { seniorResumes } from '../database/schema'
import type { S3Service } from '../documents/s3.service'
import {
  MAX_POSTING_CHARS,
  tailorWorkerInput,
  type TailorBody,
} from '../extraction-worker/link-contract'
import { loadOpportunity } from '../job-sourcing/runtime/recompute-inputs'
import { stripContacts } from '../job-sourcing/structuring/contact-strip'
import type { ResumeTextExtractionService } from '../resumes/resume-text-extraction.service'
import { resolveTemplateName } from '../resumes/resume-typst.service'
import {
  fitToWorker,
  redactAll,
  safeCut,
  writingPayload,
  type WritingPayload,
} from '../resumes/verification/content-gates'
import type { ContactContext } from '../resumes/verification/contact-scan'
import { contentToFacts } from '../resumes/verification/derive-content'
import { loadOwnerContacts } from '../resumes/verification/verification-runner'
import { eligibilityOf } from './tailored-eligibility'
import { bucketOf, capPosting, extractRequirements, type Bucket } from './tailored-requirements'
import { TailoredRunFailure } from './tailored-run'

export type PrepareDeps = {
  db: DatabaseService
  s3: Pick<S3Service, 'getObject'>
  extraction: Pick<ResumeTextExtractionService, 'countRenderedPages'>
  onDemandTypes: readonly JobSourceType[]
}

export type PreparedPosting = {
  title: string
  employerName: string
  text: string
  /** No description and none pending: the text is the title and the stack keywords (spec Q3). */
  partial: boolean
  truncated: boolean
}

export type PreparedRun = {
  base: {
    id: string
    version: number
    content: ResumeContent
    templateName: ResumeTemplateName
    layout: ResumeLayoutOptions
    pdfPages: number
  }
  contacts: readonly ContactContext[]
  email: string
  /** The redacted, worker-sized `WritingPayload` as its canonical JSON string. */
  payload: string
  posting: PreparedPosting
  requirements: { name: string; bucket: Bucket }[]
  displayName: string
  /** Experience items sent to the writer; the items past it stay as in the base. */
  sentItems: number
}

export const MAX_TITLE_CHARS = 300
export const MAX_EMPLOYER_CHARS = 200
const FALLBACK_TITLE = 'Job opening'

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
 * The run as every model call sees it (R19, at the client boundary): the senior's contacts
 * redacted from every payload, posting and requirement string, each cut back to its body cap
 * (`safeCut`: a redaction marker can be longer than the text it replaces). A cut posting text is
 * `truncated`.
 */
export function redactRun(prepared: PreparedRun): PreparedRun {
  const r = (text: string, max: number) => safeCut(redactAll(text, prepared.contacts), max)
  const redacted = redactAll(prepared.posting.text, prepared.contacts)
  const text = safeCut(redacted, MAX_POSTING_CHARS)
  return {
    ...prepared,
    payload: JSON.stringify(redactPayload(prepared.payload, prepared.contacts)),
    posting: {
      ...prepared.posting,
      title: r(prepared.posting.title, MAX_TITLE_CHARS),
      employerName: r(prepared.posting.employerName, MAX_EMPLOYER_CHARS),
      text,
      truncated: prepared.posting.truncated || text.length < redacted.length,
    },
    requirements: prepared.requirements.map((q) => ({
      name: r(q.name, RESUME_LIMITS.shortText),
      bucket: q.bucket,
    })),
  }
}

/** The `/resume-tailor` user message the worker builds is within its input cap. */
export function tailorFits(body: TailorBody): boolean {
  return tailorWorkerInput(body).length <= MAX_EXTRACTION_INPUT_CHARS
}

/**
 * `fitToWorker` budgeted with the message the worker builds and the client checks
 * (`tailorWorkerInput`), so the posting and its requirements count too.
 */
export function fitTailor(
  payload: WritingPayload,
  posting: TailorBody['posting'],
  feedback: string[],
): { payload: WritingPayload; feedback: string[]; sentItems: number } {
  const fitted = fitToWorker(payload, feedback, (p, f) =>
    tailorFits({ payload: p, posting, feedback: f }),
  )
  return { ...fitted, sentItems: fitted.payload.experience.length }
}

/**
 * The posting as the `/resume-tailor` body carries it: the gap requirements are never sent, and
 * neither is the employer name (owner decision 2026-11-22: the cover letter never names it).
 */
export function bodyPosting(
  prepared: Pick<PreparedRun, 'posting' | 'requirements'>,
): TailorBody['posting'] {
  const { title, text } = prepared.posting
  const labels = (bucket: Bucket) =>
    prepared.requirements.filter((r) => r.bucket === bucket).map((r) => r.name)
  return {
    title,
    text,
    requirements: { existing: labels('existing'), supported: labels('supported') },
  }
}

type BaseRow = {
  verificationStatus: string
  version: number
  pdfS3Key: string | null
  content: ResumeContent
}

/**
 * Why the base cannot be tailored now, or its PDF key: the start-time checks, re-run at claim
 * time, since the base may have moved in between.
 */
export function checkBase<R extends BaseRow>(
  row: R | undefined,
  displayName: string,
  runBaseVersion: number,
): { code: TailoredResumeErrorCode } | { row: R & { pdfS3Key: string } } {
  if (row === undefined || row.verificationStatus !== 'VERIFIED' || row.pdfS3Key === null) {
    return { code: 'BASE_NOT_VERIFIED' }
  }
  if (row.version !== runBaseVersion) return { code: 'BASE_CHANGED' }
  // Stryker disable next-line BooleanLiteral: equivalent — only NON_LATIN_NAME and NON_ENGLISH are read, and POSTING_PENDING is neither
  const eligibility = eligibilityOf({ base: row, displayName, detailPending: false })
  return eligibility === 'NON_LATIN_NAME' || eligibility === 'NON_ENGLISH'
    ? { code: eligibility }
    : { row: { ...row, pdfS3Key: row.pdfS3Key } }
}

type RawPosting = {
  title: string
  employerName: string
  descriptionMd: string
  tags: readonly string[]
}

/** Contact shapes stripped, then the senior's own contacts redacted, from every posting string. */
function cleanPosting(raw: RawPosting, contacts: readonly ContactContext[]) {
  const clean = (text: string) => redactAll(stripContacts(text).text, contacts).trim()
  return {
    title: clean(raw.title),
    employerName: clean(raw.employerName),
    description: clean(raw.descriptionMd),
    tags: raw.tags.map(clean).filter(Boolean),
  }
}

/** The pure half of the prepare step: posting, requirements and the worker-sized payload. */
export function assemblePrepared(i: {
  base: PreparedRun['base']
  owner: { displayName: string; email: string; contacts: readonly ContactContext[] }
  opportunity: RawPosting
  now: Date
}): PreparedRun {
  const { base, owner } = i
  const raw = cleanPosting(i.opportunity, owner.contacts)
  const partial = raw.description === ''
  const title = safeCut(raw.title, MAX_TITLE_CHARS) || FALLBACK_TITLE
  const keywords = raw.tags.join(', ')
  // A partial posting is never an empty block: a blank title reads as the fallback (SPEC-L-2).
  const capped = capPosting(
    partial ? [title, keywords].filter(Boolean).join('\n') : raw.description,
  )
  const posting: PreparedPosting = {
    title,
    employerName: safeCut(raw.employerName, MAX_EMPLOYER_CHARS),
    text: capped.text,
    partial,
    truncated: capped.truncated,
  }
  const bucket = bucketOf(base.content)
  const requirements = extractRequirements(`${raw.title}\n${raw.description}`, raw.tags).map(
    (name) => ({ name, bucket: bucket(name) }),
  )
  const full = writingPayload({
    // The summary is the headline the tailored summary is grounded in (spec: payload).
    facts: { ...contentToFacts(base.content), headline: base.content.summary },
    frozen: base.content,
    contacts: [...owner.contacts],
    template: base.templateName,
    now: i.now,
  })
  const fitted = fitTailor(full, bodyPosting({ posting, requirements }), [])
  return {
    base,
    contacts: owner.contacts,
    email: owner.email,
    payload: JSON.stringify(fitted.payload),
    posting,
    requirements,
    displayName: owner.displayName,
    sentItems: fitted.sentItems,
  }
}

/**
 * Prepare a claimed run: re-check the base (it may have moved since start), load the owner's
 * contacts and the posting, and count the base PDF's pages (never re-rendered).
 */
export async function prepareTailoring(
  deps: PrepareDeps,
  p: {
    rowId: string
    runId: string
    opportunityId: string
    seniorId: string
    runBaseVersion: number
  },
): Promise<PreparedRun> {
  const [row] = await deps.db.db
    .select({
      id: seniorResumes.id,
      version: seniorResumes.version,
      content: seniorResumes.content,
      templateName: seniorResumes.templateName,
      layout: seniorResumes.layout,
      pdfS3Key: seniorResumes.pdfS3Key,
      verificationStatus: seniorResumes.verificationStatus,
    })
    .from(seniorResumes)
    .where(eq(seniorResumes.userId, p.seniorId))
    .limit(1)
  const owner = await loadOwnerContacts(deps.db, p.seniorId)
  if (owner === null) throw new TailoredRunFailure('INTERNAL_ERROR')
  const checked = checkBase(row, owner.displayName, p.runBaseVersion)
  if ('code' in checked) throw new TailoredRunFailure(checked.code)
  const base = checked.row
  const opportunity = await loadOpportunity(deps.db.db, p.opportunityId, deps.onDemandTypes)
  if (opportunity === null) throw new TailoredRunFailure('INTERNAL_ERROR')
  const { fields, companyName } = opportunity.canonical
  const pdfPages = await deps.extraction.countRenderedPages(await deps.s3.getObject(base.pdfS3Key))
  return assemblePrepared({
    base: {
      id: base.id,
      version: base.version,
      content: base.content,
      templateName: resolveTemplateName(base.templateName),
      layout: base.layout,
      pdfPages,
    },
    owner,
    opportunity: {
      title: fields.title,
      employerName: companyName,
      descriptionMd: fields.descriptionMd,
      tags: fields.tags ?? [],
    },
    now: new Date(),
  })
}
