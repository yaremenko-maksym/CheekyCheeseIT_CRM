/**
 * task-crm-vacancies-ui — `CandidateCard` (AC5 + spec §5) interaction tests.
 *
 * Pins:
 * 1. `isNew`/ring/badge are ALL derived from `status === 'NEW'` (no separate
 *    field — spec §5 explicitly calls out the macet's `isNew` as an artifact).
 * 2. Contact chips (telegram/github/linkedin) only render when present.
 * 3. Cover letter block only renders when non-empty.
 * 4. Status SegmentedToggle calls PATCH with the new status.
 * 5. Download resume (task-candidate-card-resume AC1): refetches the
 *    presigned URL then navigates via `window.location.href` (NOT
 *    `window.open` — that was the mobile popup-blocking bug; a real
 *    mobile-viewport Playwright download proof lives in
 *    apps/e2e/tests/vacancies.spec.ts).
 * 6. Delete goes through an AlertDialog confirm (not immediate).
 * 7. Preview button (task-candidate-card-resume AC2) opens ResumePreviewDialog.
 * 8. Telegram handle renders as a `t.me/` link only for a valid handle
 *    (task-candidate-card-resume AC4); invalid stays plain text.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VacancyApplication } from '@crm/shared'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const apiGet = vi.fn()
const apiPatch = vi.fn().mockResolvedValue({ data: {} })
const apiDelete = vi.fn().mockResolvedValue({ data: {} })
vi.mock('@/lib/axios', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
}))

// ResumePreviewDialog's own presigned-URL -> fetch -> blob pipeline has
// dedicated coverage in use-resume-blob.test.tsx + ResumePreviewDialog.test.tsx
// — mocked here so CandidateCard's tests stay about wiring the button to the
// dialog, not about the real blob pipeline (which would otherwise attempt a
// real, unmocked global `fetch()` once the dialog opens).
vi.mock('@/hooks/use-resume-blob', () => ({
  useApplicationResumeBlob: () => ({
    blobUrl: null,
    isLoading: false,
    hasError: false,
    isUnsupportedFormat: false,
  }),
}))

import { CandidateCard } from '../components/CandidateCard'

function makeApplication(overrides: Partial<VacancyApplication> = {}): VacancyApplication {
  return {
    id: 'app-1',
    vacancyId: 'vac-1',
    fullName: 'Иван Петров',
    email: 'ivan@example.com',
    telegram: null,
    linkedinUrl: null,
    githubUrl: null,
    coverLetter: null,
    resumeSizeBytes: 12345,
    status: 'NEW',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderCard(application: VacancyApplication) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CandidateCard vacancyId="vac-1" application={application} />
    </QueryClientProvider>,
  )
}

describe('CandidateCard — NEW derivation (§5)', () => {
  it('status NEW: renders «Новый» badge + ring highlight', () => {
    renderCard(makeApplication({ status: 'NEW' }))
    expect(screen.getByTestId('candidate-new-badge-app-1')).toHaveTextContent('Новый')
    expect(screen.getByTestId('candidate-card-app-1').className).toMatch(/ring-1/)
  })

  it('status VIEWED: no «Новый» badge, no ring', () => {
    renderCard(makeApplication({ status: 'VIEWED' }))
    expect(screen.queryByTestId('candidate-new-badge-app-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('candidate-card-app-1').className).not.toMatch(/ring-1/)
  })

  it('status REJECTED: no «Новый» badge, no ring', () => {
    renderCard(makeApplication({ status: 'REJECTED' }))
    expect(screen.queryByTestId('candidate-new-badge-app-1')).not.toBeInTheDocument()
  })
})

describe('CandidateCard — conditional chips + cover letter', () => {
  it('renders no contact chips when telegram/github/linkedin are all null', () => {
    renderCard(makeApplication())
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument()
    expect(screen.queryByText('LinkedIn')).not.toBeInTheDocument()
  })

  it('renders only the chips that are present', () => {
    renderCard(
      makeApplication({
        telegram: '@ivan',
        githubUrl: 'https://github.com/ivan',
        linkedinUrl: null,
      }),
    )
    expect(screen.getByText('@ivan')).toBeInTheDocument()
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.queryByText('LinkedIn')).not.toBeInTheDocument()
  })

  it('github/linkedin chips link to the real URL, not a placeholder #', () => {
    renderCard(makeApplication({ githubUrl: 'https://github.com/ivan' }))
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/ivan',
    )
  })

  // security-MED (PR #396 review): `vacancyApplicationSchema` (read DTO) does
  // NOT re-assert the https:// protocol the write-side schema enforces — a
  // legacy/malicious row could carry `javascript:...`. React does not block
  // `javascript:` in a rendered href, so the component itself must guard it.
  it('renders a non-clickable chip (no <a>) when githubUrl is a javascript: URL', () => {
    renderCard(makeApplication({ githubUrl: 'javascript:alert(1)' }))
    const chip = screen.getByText('GitHub')
    expect(screen.queryByRole('link', { name: 'GitHub' })).toBeNull()
    expect(chip.tagName.toLowerCase()).not.toBe('a')
  })

  it('renders a non-clickable chip when linkedinUrl is a javascript: URL', () => {
    renderCard(makeApplication({ linkedinUrl: 'javascript:alert(1)' }))
    expect(screen.getByText('LinkedIn')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'LinkedIn' })).toBeNull()
  })

  // task-candidate-card-resume AC4 — telegram: valid handle -> clickable
  // t.me/ link; invalid/free-text (anonymous public form) -> stays plain
  // text, same "border-case boundary" as safeExternalHref's javascript: guard.
  it('valid telegram handle renders as a clickable https://t.me/ link', () => {
    renderCard(makeApplication({ telegram: '@armghyan' }))
    const link = screen.getByTestId('candidate-telegram-link')
    expect(link).toHaveAttribute('href', 'https://t.me/armghyan')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveTextContent('@armghyan')
  })

  it('invalid telegram value (free text from the public form) stays plain, non-clickable text', () => {
    renderCard(makeApplication({ telegram: 'пишите мне в телеграм плз' }))
    expect(screen.queryByTestId('candidate-telegram-link')).not.toBeInTheDocument()
    // Role query rather than `closest('a')` on the text node (task-lint-teeth):
    // states "this free text is not a link" as a user would experience it.
    expect(screen.getByText('пишите мне в телеграм плз')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'пишите мне в телеграм плз' })).toBeNull()
  })

  it('telegram handle below the 5-char minimum stays plain text (boundary)', () => {
    renderCard(makeApplication({ telegram: '@abcd' }))
    expect(screen.queryByTestId('candidate-telegram-link')).not.toBeInTheDocument()
    expect(screen.getByText('@abcd')).toBeInTheDocument()
  })

  it('does not render the cover letter <details> when empty', () => {
    renderCard(makeApplication({ coverLetter: null }))
    expect(screen.queryByText('Сопроводительное письмо')).not.toBeInTheDocument()
  })

  it('renders the collapsible cover letter block when present', () => {
    renderCard(makeApplication({ coverLetter: 'Я хочу у вас работать.' }))
    expect(screen.getByText('Сопроводительное письмо')).toBeInTheDocument()
    expect(screen.getByText('Я хочу у вас работать.')).toBeInTheDocument()
  })
})

describe('CandidateCard — status toggle (PATCH)', () => {
  beforeEach(() => apiPatch.mockClear())

  it('clicking «Просмотрено» PATCHes the new status', async () => {
    renderCard(makeApplication({ status: 'NEW' }))
    fireEvent.click(screen.getByTestId('candidate-status-app-1-VIEWED'))
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/vacancies/vac-1/applications/app-1', {
        status: 'VIEWED',
      }),
    )
  })

  it('clicking the already-active status is a no-op (SegmentedToggle convention)', () => {
    renderCard(makeApplication({ status: 'NEW' }))
    fireEvent.click(screen.getByTestId('candidate-status-app-1-NEW'))
    expect(apiPatch).not.toHaveBeenCalled()
  })
})

describe('CandidateCard — resume download (presigned URL, task-candidate-card-resume AC1)', () => {
  // Real happy-dom `window.location.href =` attempts an actual (async)
  // navigation, which is both slow and irrelevant here — this test only
  // cares WHAT the component assigns, not that a real page-load happens.
  // Replacing `window.location` with a plain mutable object is the standard
  // technique for asserting a same-document-navigation call site.
  const originalLocation = window.location

  beforeEach(() => {
    apiGet.mockReset()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: '' },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
  })

  it('refetches the presigned URL then navigates via window.location.href (NOT window.open)', async () => {
    apiGet.mockResolvedValue({
      data: { url: 'https://r2.example/resume.pdf', expiresAt: '2026-01-01T00:10:00.000Z' },
    })
    renderCard(makeApplication())
    fireEvent.click(screen.getByTestId('candidate-download-app-1'))
    await waitFor(() => expect(window.location.href).toBe('https://r2.example/resume.pdf'))
    expect(apiGet).toHaveBeenCalledWith('/vacancies/vac-1/applications/app-1/resume-url')
  })

  // code-review round 2: safeExternalHref guards the navigation — a
  // non-http(s) URL from the API never reaches window.location.href.
  it('rejects a non-http(s) presigned URL instead of navigating (defence-in-depth)', async () => {
    apiGet.mockResolvedValue({
      data: { url: 'javascript:alert(1)', expiresAt: '2026-01-01T00:10:00.000Z' },
    })
    renderCard(makeApplication())
    fireEvent.click(screen.getByTestId('candidate-download-app-1'))
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    expect(window.location.href).toBe('')
  })
})

// task-candidate-card-resume AC2 — «Просмотр» opens the resume preview
// dialog. The dialog's own content branching (unsupported format / PdfPreview
// / download-inside-dialog) is covered directly in ResumePreviewDialog.test.tsx —
// this only pins that CandidateCard actually wires the button to it.
describe('CandidateCard — resume preview button (task-candidate-card-resume AC2)', () => {
  it('clicking «Просмотр» opens the resume preview dialog with the candidate name in the title', () => {
    renderCard(makeApplication({ fullName: 'Иван Петров' }))
    expect(screen.queryByTestId('resume-preview-dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('candidate-preview-app-1'))

    expect(screen.getByTestId('resume-preview-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('resume-preview-title')).toHaveTextContent('Иван Петров')
  })

  it('closing the dialog removes it from the DOM again', () => {
    renderCard(makeApplication())
    fireEvent.click(screen.getByTestId('candidate-preview-app-1'))
    expect(screen.getByTestId('resume-preview-dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('resume-preview-close'))
    expect(screen.queryByTestId('resume-preview-dialog')).not.toBeInTheDocument()
  })
})

// task-file-storage-hardening §2: resumeSizeBytes is null once the 180-day
// file-only retention purge has cleared the file — the application row
// (this card) survives, but there is nothing left to download.
describe('CandidateCard — purged resume (resumeSizeBytes null, §2)', () => {
  it('renders a muted "resume deleted" note instead of the download/preview buttons', () => {
    renderCard(makeApplication({ resumeSizeBytes: null }))
    expect(screen.queryByTestId('candidate-download-app-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('candidate-preview-app-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('candidate-resume-purged-app-1')).toHaveTextContent('Резюме удалено')
  })

  it('still renders the download/preview buttons when resumeSizeBytes is present', () => {
    renderCard(makeApplication({ resumeSizeBytes: 12345 }))
    expect(screen.getByTestId('candidate-download-app-1')).toBeInTheDocument()
    expect(screen.getByTestId('candidate-preview-app-1')).toBeInTheDocument()
    expect(screen.queryByTestId('candidate-resume-purged-app-1')).not.toBeInTheDocument()
  })
})

describe('CandidateCard — delete (AlertDialog confirm gate)', () => {
  beforeEach(() => apiDelete.mockClear())

  it('clicking the delete icon opens a confirm dialog WITHOUT deleting yet', () => {
    renderCard(makeApplication({ fullName: 'Иван Петров' }))
    fireEvent.click(screen.getByTestId('candidate-delete-app-1'))
    expect(screen.getByText('Удалить отклик?')).toBeInTheDocument()
    expect(apiDelete).not.toHaveBeenCalled()
  })

  it('confirm dialog does NOT mention a filename (§11 п.6 — no such field in schema)', () => {
    renderCard(makeApplication({ fullName: 'Иван Петров' }))
    fireEvent.click(screen.getByTestId('candidate-delete-app-1'))
    expect(screen.queryByText(/\.pdf/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Отклик кандидата Иван Петров будет удалён/)).toBeInTheDocument()
  })

  it('confirming calls DELETE /vacancies/:vacancyId/applications/:appId', async () => {
    renderCard(makeApplication())
    fireEvent.click(screen.getByTestId('candidate-delete-app-1'))
    fireEvent.click(screen.getByTestId('candidate-delete-confirm-app-1'))
    await waitFor(() =>
      expect(apiDelete).toHaveBeenCalledWith('/vacancies/vac-1/applications/app-1'),
    )
  })
})
