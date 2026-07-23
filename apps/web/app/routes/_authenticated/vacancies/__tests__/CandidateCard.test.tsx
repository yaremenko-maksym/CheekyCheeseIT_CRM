/**
 * task-crm-vacancies-ui — `CandidateCard` (AC5 + spec §5) interaction tests.
 *
 * Pins:
 * 1. `isNew`/ring/badge are ALL derived from `status === 'NEW'` (no separate
 *    field — spec §5 explicitly calls out the macet's `isNew` as an artifact).
 * 2. Contact chips (telegram/github/linkedin) only render when present.
 * 3. Cover letter block only renders when non-empty.
 * 4. Status SegmentedToggle calls PATCH with the new status.
 * 5. Download resume: refetches the presigned URL then `window.open`s it.
 * 6. Delete goes through an AlertDialog confirm (not immediate).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
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
    expect(screen.getByText('GitHub').closest('a')).toHaveAttribute(
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
    expect(chip.closest('a')).toBeNull()
    expect(chip.tagName.toLowerCase()).not.toBe('a')
  })

  it('renders a non-clickable chip when linkedinUrl is a javascript: URL', () => {
    renderCard(makeApplication({ linkedinUrl: 'javascript:alert(1)' }))
    const chip = screen.getByText('LinkedIn')
    expect(chip.closest('a')).toBeNull()
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

describe('CandidateCard — resume download (presigned URL)', () => {
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

  beforeEach(() => {
    apiGet.mockReset()
    openSpy.mockClear()
  })

  it('refetches the presigned URL then window.opens it', async () => {
    apiGet.mockResolvedValue({
      data: { url: 'https://r2.example/resume.pdf', expiresAt: '2026-01-01T00:10:00.000Z' },
    })
    renderCard(makeApplication())
    fireEvent.click(screen.getByTestId('candidate-download-app-1'))
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://r2.example/resume.pdf',
        '_blank',
        'noopener,noreferrer',
      ),
    )
    expect(apiGet).toHaveBeenCalledWith('/vacancies/vac-1/applications/app-1/resume-url')
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
