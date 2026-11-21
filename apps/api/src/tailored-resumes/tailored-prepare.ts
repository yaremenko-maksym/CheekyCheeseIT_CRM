import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import type {
  JobSourceType,
  ResumeContent,
  ResumeLayoutOptions,
  ResumeTemplateName,
  TailoredResumeErrorCode,
} from '@crm/shared'
import { eq } from 'drizzle-orm'
import type { DatabaseService } from '../database/database.service'
import { seniorResumes } from '../database/schema'
import type { S3Service } from '../documents/s3.service'
import { tailorWorkerInput, type TailorBody } from '../extraction-worker/link-contract'
import { loadOpportunity } from '../job-sourcing/runtime/recompute-inputs'
import { stripContacts } from '../job-sourcing/structuring/contact-strip'
import type { ResumeTextExtractionService } from '../resumes/resume-text-extraction.service'
import { resolveTemplateName } from '../resumes/resume-typst.service'
import {
  redactAll,
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

const MAX_TITLE_CHARS = 300
const MAX_EMPLOYER_CHARS = 200
const FALLBACK_TITLE = 'Job opening'

/** The `/resume-tailor` user message the worker builds is within its input cap. */
export function tailorFits(body: TailorBody): boolean {
  return tailorWorkerInput(body).length <= MAX_EXTRACTION_INPUT_CHARS
}

/**
 * `fitToWorker`'s trimming (trailing experience items, never the first, then feedback lines, last
 * first), budgeted with the message the worker builds and the client checks (`tailorWorkerInput`),
 * so the posting and its requirements count too.
 */
export function fitTailor(
  payload: WritingPayload,
  posting: TailorBody['posting'],
  feedback: string[],
): { payload: WritingPayload; feedback: string[]; sentItems: number } {
  let p = payload
  let f = feedback
  const fits = () => tailorFits({ payload: JSON.stringify(p), posting, feedback: f })
  while (!fits() && p.experience.length > 1) p = { ...p, experience: p.experience.slice(0, -1) }
  while (!fits() && f.length > 0) f = f.slice(0, -1)
  return { payload: p, feedback: f, sentItems: p.experience.length }
}

/** The posting as the `/resume-tailor` body carries it: the gap requirements are never sent. */
export function bodyPosting(
  prepared: Pick<PreparedRun, 'posting' | 'requirements'>,
): TailorBody['posting'] {
  const { title, employerName, text } = prepared.posting
  const labels = (bucket: Bucket) =>
    prepared.requirements.filter((r) => r.bucket === bucket).map((r) => r.name)
  return {
    title,
    employerName,
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
  const keywords = raw.tags.join(', ')
  const capped = capPosting(
    partial ? [raw.title, keywords].filter(Boolean).join('\n') : raw.description,
  )
  const posting: PreparedPosting = {
    title: raw.title.slice(0, MAX_TITLE_CHARS) || FALLBACK_TITLE,
    employerName: raw.employerName.slice(0, MAX_EMPLOYER_CHARS),
    text: capped.text,
    partial,
    truncated: capped.truncated,
  }
  const requirements = extractRequirements(`${raw.title}\n${raw.description}`, raw.tags).map(
    (name) => ({ name, bucket: bucketOf(name, base.content) }),
  )
  const full = writingPayload({
    // The summary is the headline the tailored summary is grounded in (spec: payload).
    facts: { ...contentToFacts(base.content), headline: base.content.summary },
    frozen: base.content,
    contacts: [...owner.contacts],
    template: base.templateName,
    now: i.now,
  })
  // Stryker disable next-line ArrayDeclaration: prepare sends no feedback; one extra line moves the budget by a few dozen chars, observable only by an exact-cap fixture
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
    // Stryker disable next-line ObjectLiteral: the selected columns are only observable against Postgres (tailored-prepare.integration.spec.ts)
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
