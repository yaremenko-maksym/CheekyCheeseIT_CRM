/**
 * task-crm-vacancies-ui — `VacancySheet` (AC5 + spec §4.2) interaction tests.
 *
 * Pins:
 * 1. Auto-slug: typing a latin title fills the slug field (kebab-case).
 * 2. Editing the slug directly breaks the auto-link — a later title edit no
 *    longer overwrites the user's custom slug.
 * 3. Cyrillic title → slug stays empty (no bad transliteration attempted).
 * 4. Create mode calls POST /vacancies with the trimmed payload.
 * 5. Edit mode pre-fills from the given vacancy and calls PATCH /vacancies/:id.
 *
 * ContractEditor lazy-loads real CodeMirror (~500KB) — mocked here to a plain
 * textarea so the test doesn't pay that cost / fight Suspense timing, same
 * call other form tests in this codebase make for heavy lazy editors.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vacancy } from '@crm/shared'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="vacancy-form-description"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

const apiPost = vi.fn().mockResolvedValue({ data: {} })
const apiPatch = vi.fn().mockResolvedValue({ data: {} })
vi.mock('@/lib/axios', () => ({
  api: {
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}))

import { VacancySheet } from '../components/VacancySheet'

function renderSheet(vacancy: Vacancy | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <VacancySheet vacancy={vacancy} open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

const EXISTING_VACANCY: Vacancy = {
  id: 'vac-1',
  slug: 'existing-slug',
  title: 'Existing Title',
  domain: 'EDTECH',
  seniority: 'LEAD',
  employmentType: 'PART_TIME',
  location: 'Львов',
  publishedAt: null,
  descriptionMd: 'Existing description here.',
  status: 'DRAFT',
  closedAt: null,
  applicationsCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('VacancySheet — auto-slug generation (§4.2)', () => {
  it('typing a latin title fills the slug field (kebab-case)', () => {
    renderSheet(null)
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: 'Senior React Developer' },
    })
    expect(screen.getByTestId('vacancy-form-slug')).toHaveValue('senior-react-developer')
  })

  it('a Cyrillic title leaves the slug empty (no bad transliteration)', () => {
    renderSheet(null)
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: 'Старший разработчик' },
    })
    expect(screen.getByTestId('vacancy-form-slug')).toHaveValue('')
  })

  it('editing the slug manually breaks the auto-link — later title edits no longer overwrite it', () => {
    renderSheet(null)
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: 'Senior React Developer' },
    })
    expect(screen.getByTestId('vacancy-form-slug')).toHaveValue('senior-react-developer')

    fireEvent.change(screen.getByTestId('vacancy-form-slug'), {
      target: { value: 'my-custom-slug' },
    })
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: 'Senior React Developer II' },
    })
    expect(screen.getByTestId('vacancy-form-slug')).toHaveValue('my-custom-slug')
  })

  it('edit mode never auto-links — the existing slug is never overwritten by a title edit', () => {
    renderSheet(EXISTING_VACANCY)
    expect(screen.getByTestId('vacancy-form-slug')).toHaveValue('existing-slug')
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: 'Renamed Title' },
    })
    expect(screen.getByTestId('vacancy-form-slug')).toHaveValue('existing-slug')
  })
})

describe('VacancySheet — create mode submit', () => {
  beforeEach(() => apiPost.mockClear())

  // task-vacancies-form-simplify: «Уровень»/«Локация» controls are removed —
  // the payload never comes from user input for these two fields; the
  // schema's `.default()` fills them (createVacancySchema.seniority/location).
  it('submits POST /vacancies with the trimmed payload — seniority/location default to SENIOR/Remote', async () => {
    renderSheet(null)
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: '  Senior React Developer  ' },
    })
    fireEvent.change(screen.getByTestId('vacancy-form-description'), {
      target: { value: 'A long enough description for validation.' },
    })
    fireEvent.click(screen.getByTestId('vacancy-sheet-submit'))

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    const [url, payload] = apiPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/vacancies')
    expect(payload).toMatchObject({
      title: 'Senior React Developer',
      slug: 'senior-react-developer',
      domain: 'AI',
      seniority: 'SENIOR',
      employmentType: 'FULL_TIME',
      location: 'Remote',
    })
  })

  it('does NOT submit when required fields fail validation (title too short)', async () => {
    renderSheet(null)
    fireEvent.change(screen.getByTestId('vacancy-form-title'), { target: { value: 'ab' } })
    fireEvent.click(screen.getByTestId('vacancy-sheet-submit'))
    await new Promise((r) => setTimeout(r, 50))
    expect(apiPost).not.toHaveBeenCalled()
  })
})

describe('VacancySheet — edit mode', () => {
  beforeEach(() => apiPatch.mockClear())

  it('pre-fills the remaining fields from the given vacancy (no Уровень/Локация controls)', () => {
    renderSheet(EXISTING_VACANCY)
    expect(screen.getByTestId('vacancy-form-title')).toHaveValue('Existing Title')
    expect(screen.getByTestId('vacancy-form-description')).toHaveValue('Existing description here.')
    expect(screen.queryByTestId('vacancy-form-seniority')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vacancy-form-location')).not.toBeInTheDocument()
    expect(screen.getByText('Сохранить изменения')).toBeInTheDocument()
  })

  it('submits PATCH /vacancies/:id', async () => {
    renderSheet(EXISTING_VACANCY)
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: 'Updated Title' },
    })
    fireEvent.click(screen.getByTestId('vacancy-sheet-submit'))
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1))
    const [url, payload] = apiPatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/vacancies/vac-1')
    expect(payload).toMatchObject({ title: 'Updated Title' })
  })

  // Regression pin (task-vacancies-form-simplify AC2 "редактирование
  // существующих не ломается"): EXISTING_VACANCY is seniority: 'LEAD',
  // location: 'Львов' — since the form no longer collects either field, the
  // PATCH payload must never carry them (updateVacancySchema then treats
  // them as "no change", the backend keeps LEAD/Львов as-is).
  it('edit-mode PATCH payload never includes seniority/location (existing LEAD/Львов vacancy is left untouched)', async () => {
    renderSheet(EXISTING_VACANCY)
    fireEvent.change(screen.getByTestId('vacancy-form-title'), {
      target: { value: 'Renamed' },
    })
    fireEvent.click(screen.getByTestId('vacancy-sheet-submit'))
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1))
    const [, payload] = apiPatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload).not.toHaveProperty('seniority')
    expect(payload).not.toHaveProperty('location')
  })
})
