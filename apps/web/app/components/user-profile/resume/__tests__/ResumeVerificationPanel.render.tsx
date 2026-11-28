import { act, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Mock } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type SeniorResumeDto,
  type SeniorResumeResponse,
} from '@crm/shared'
import { I18nTestProvider } from '@/test/i18n'
import { useSeniorResume } from '@/hooks/use-senior-resume'
import { ResumeVerificationPanel, VerificationBadge } from '../ResumeVerificationPanel'

export const RUN_ID = '22222222-2222-4222-8222-222222222222'
export const USER = '33333333-3333-4333-8333-333333333333'

export const STAGED: NonNullable<SeniorResumeDto['staged']> = {
  runId: RUN_ID,
  content: {
    ...EMPTY_RESUME_CONTENT,
    summary: 'Backend engineer with five years of TypeScript.',
    experience: [
      {
        company: 'Acme',
        role: 'Lead Engineer',
        period: '2021 - 2024',
        bullets: ['Led a team of five', 'Cut build time in half'],
      },
    ],
  },
  layout: DEFAULT_RESUME_LAYOUT,
  templateName: 'classic',
  pdfAvailable: true,
  editedPaths: [],
}

export function makeResponse(
  overrides: Partial<SeniorResumeDto> = {},
  canConfirm = true,
): SeniorResumeResponse {
  const resume: SeniorResumeDto = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: USER,
    content: EMPTY_RESUME_CONTENT,
    status: 'READY',
    errorCode: null,
    errorMessage: null,
    quotaResetsAt: null,
    sourceFileName: null,
    sourceFileSizeBytes: null,
    hasSourceFile: false,
    version: 3,
    updatedByUserId: null,
    updatedByName: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    layout: DEFAULT_RESUME_LAYOUT,
    templateName: 'classic',
    hasCustomTemplate: false,
    renderStatus: 'READY',
    renderError: null,
    pdfUpToDate: true,
    facts: {
      ...EMPTY_RESUME_FACTS,
      headline: 'Backend Engineer',
      experience: [
        {
          company: 'Acme',
          role: 'Lead Engineer',
          location: null,
          start: '2021-01',
          end: '2024-06',
          current: false,
          technologies: ['TypeScript'],
          notes: ['Led a team of five people'],
        },
      ],
    },
    verificationStatus: 'AWAITING_CONFIRM',
    verificationErrorCode: null,
    verificationReport: { gates: [], fallbacks: [] },
    verifiedVersion: null,
    verifiedAt: null,
    verifiedByName: null,
    recheckNeededAt: null,
    header: { displayName: null, email: null, phone: null, telegram: null },
    headerDefaults: {
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      phone: null,
      telegram: null,
    },
    staged: STAGED,
    verificationBusy: false,
    ...overrides,
  }
  return { resume, canEdit: true, canConfirm }
}

/** The panel (and the toolbar badge) fed by the real resume query, as ResumeTab feeds them. */
export function Wired() {
  const { data } = useSeniorResume(USER)
  if (!data?.resume) return null
  return (
    <>
      <VerificationBadge resume={data.resume} />
      <ResumeVerificationPanel
        userId={USER}
        resume={data.resume}
        canConfirm={data.canConfirm}
        onChangeFacts={() => {}}
      />
    </>
  )
}

export const createStagedPdfGets = (getMock: Mock) => () =>
  getMock.mock.calls.filter(([url]) => url === `/users/${USER}/resume/staged-pdf`).length

export function createRenderWired(getMock: Mock, postMock: Mock) {
  return function renderWired(initial: SeniorResumeResponse, stagedPdf?: Blob) {
    let response = initial
    getMock.mockImplementation(async (url: string) => {
      if (!url.endsWith('/staged-pdf')) return { data: response }
      return stagedPdf ? { data: stagedPdf } : Promise.reject(new Error('no staged PDF here'))
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <I18nTestProvider>{children}</I18nTestProvider>
      </QueryClientProvider>
    )
    const view = render(<Wired />, { wrapper: wrap })
    /** The write (POST unless named) answers `next`, and so does every resume GET after it. */
    const postMovesServerTo = (next: SeniorResumeResponse, write = postMock) =>
      write.mockImplementation(() => {
        response = next
        return Promise.resolve({ data: next })
      })
    /** The server moved on: the next resume GET answers `next`, and the query refetches now. */
    const serverMovesTo = async (next: SeniorResumeResponse) => {
      response = next
      await act(() => qc.invalidateQueries())
    }
    return { ...view, serverMovesTo, postMovesServerTo }
  }
}
