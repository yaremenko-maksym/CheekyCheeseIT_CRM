/**
 * Shared route mocks for the senior resume tab (senior-resume.spec.ts and
 * resume-verification.spec.ts): the DTO builder and the asset routes every
 * resume page load fetches. Moved out of senior-resume.spec.ts (800-line cap).
 */
import type { Page } from '@playwright/test'
import { USERS } from './mock-data'
import { API_RE } from './route-helpers'

const SENIOR_ID = USERS.senior.id

const EMPTY_CONTENT = {
  summary: '',
  skills: [],
  experience: [],
  education: [],
  languages: [],
  links: [],
}

export interface ResumeStub {
  content?: unknown
  status?: string
  errorCode?: string | null
  errorMessage?: string | null
  quotaResetsAt?: string | null
  hasSourceFile?: boolean
  version?: number
  layout?: unknown
  renderStatus?: string
  renderError?: string | null
  pdfUpToDate?: boolean
  facts?: unknown
  verificationStatus?: string
  verifiedVersion?: number | null
  verificationBusy?: boolean
  verifiedAt?: string | null
  verifiedByName?: string | null
  verificationErrorCode?: string | null
  verificationReport?: unknown
  staged?: unknown
}

/** Mirrors DEFAULT_RESUME_LAYOUT — the E2E package does not import @crm/shared. */
export const DEFAULT_LAYOUT = {
  sectionOrder: ['summary', 'skills', 'experience', 'education', 'languages', 'links'],
  hiddenSections: [],
  density: 'normal',
  fontScale: 'normal',
}

/** Mirrors EMPTY_RESUME_FACTS — same reason as DEFAULT_LAYOUT above. */
export const EMPTY_FACTS = {
  headline: '',
  location: { city: '', country: '' },
  workFormat: null,
  skills: [],
  experience: [],
  education: [],
  languages: [],
  links: [],
}

export function resumeResponse(stub: ResumeStub | null, canEdit = true, canConfirm = false) {
  if (stub === null) return { resume: null, canEdit, canConfirm }
  return {
    resume: {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      userId: SENIOR_ID,
      content: stub.content ?? EMPTY_CONTENT,
      status: stub.status ?? 'READY',
      errorCode: stub.errorCode ?? null,
      errorMessage: stub.errorMessage ?? null,
      quotaResetsAt: stub.quotaResetsAt ?? null,
      sourceFileName: stub.hasSourceFile ? 'резюме.pdf' : null,
      sourceFileSizeBytes: stub.hasSourceFile ? 12345 : null,
      hasSourceFile: stub.hasSourceFile ?? false,
      version: stub.version ?? 1,
      updatedByUserId: null,
      updatedByName: null,
      createdAt: '2026-08-07T10:00:00.000Z',
      updatedAt: '2026-08-07T10:00:00.000Z',
      // task-resume-template: the layout half of the split. The template itself
      // is never in the DTO — only its label — which is what keeps it out of
      // reach of anything running in a browser.
      layout: stub.layout ?? DEFAULT_LAYOUT,
      templateName: 'classic',
      hasCustomTemplate: false,
      renderStatus: stub.renderStatus ?? 'READY',
      renderError: stub.renderError ?? null,
      pdfUpToDate: stub.pdfUpToDate ?? true,
      // verified-base-resume Task 13: the verification half of the DTO. A row
      // that never ran a check is a DRAFT with no staged result.
      facts: stub.facts ?? EMPTY_FACTS,
      verificationStatus: stub.verificationStatus ?? 'DRAFT',
      verificationErrorCode: stub.verificationErrorCode ?? null,
      verificationReport: stub.verificationReport ?? null,
      verifiedVersion: stub.verifiedVersion ?? null,
      verifiedAt: stub.verifiedAt ?? null,
      verifiedByName: stub.verifiedByName ?? null,
      staged: stub.staged ?? null,
      verificationBusy: stub.verificationBusy ?? false,
    },
    canEdit,
    canConfirm,
  }
}

export function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

/** The source URL and the (staged) PDF bytes — fetched by every resume page load. */
export async function mockResumeAssets(page: Page) {
  /**
   * The presigned-source query fires as soon as the tab knows a file exists
   * (`hasSourceFile: true`), so it MUST be mocked here rather than per-test.
   *
   * Leaving it out does not fail honestly: with no API running, the request
   * merely errors and the download button stays hidden — locally green. In CI
   * the API *is* running, answers 401, and the axios interceptor navigates to
   * /login, so the whole tab vanishes and every later locator times out with a
   * message that says nothing about the real cause. Exactly the trap the
   * fixtures file documents for /api/notifications.
   */
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/source$`), (route) =>
    route.fulfill(
      json({
        url: 'https://example.invalid/source',
        expiresAt: '2030-01-01T00:00:00.000Z',
        fileName: 'резюме.pdf',
      }),
    ),
  )
  /**
   * The rendered PDF — mocked for the SAME reason as the source URL above, and
   * it is the paragraph above that this omission proved out.
   *
   * The preview fetches these bytes into a Blob as soon as a resume has content
   * (`pdfUpToDate`), so from the moment that preview shipped, every test in this
   * file made an unmocked API call. Locally that merely errors and the preview
   * shows its error card — green. In CI the API answers 401, the axios
   * interceptor navigates to /login, the tab unmounts, and an assertion about
   * `resume-summary-view` fails with a message about a missing element rather
   * than about the logout that removed it.
   *
   * That is exactly the failure the comment above describes, one route later,
   * which is why it is being added to the SHARED helper rather than to the one
   * test that happened to notice.
   */
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/resume/(staged-)?pdf$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      // Enough of a PDF for the viewer to be handed a blob; the rendering
      // itself is Typst's job and is asserted in the API specs.
      body: '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    }),
  )
}
