/**
 * AvatarUploadDialog.size-limit.test.tsx — task-i18n-stage3b (Task 1),
 * mutation-gate coverage.
 *
 * No unit test existed for this component at all before this PR (E2E-only).
 * `AVATAR_MAX_BYTES = 5 * 1024 * 1024` feeds BOTH the size-rejection branch
 * AND the error message's `limit` via `formatBytes` — an `ArithmeticOperator`
 * mutant on that constant (`5 * 1024 / 1024`, `5 / 1024 * 1024`, …) is only
 * observable through the FORMATTED number in the error text, so this test
 * selects an oversized file and asserts the exact "5 МБ" limit renders.
 *
 * Scoped to `handleFile`'s size-check branch only — reaches it BEFORE any
 * canvas/crop work, so `react-easy-crop` never mounts and nothing else needs
 * mocking beyond the two data-mutating hooks (upload/update), which this
 * branch never calls.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/hooks/use-user-profile', () => ({
  useUpdateMe: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-documents', () => ({
  useUploadDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AvatarUploadDialog } from '../AvatarUploadDialog'

beforeEach(async () => {
  await loadCatalog('uk')
})

function renderDialog() {
  return render(
    <AvatarUploadDialog
      open={true}
      onClose={() => {}}
      userId="user-1"
      avatarDocumentId={null}
      avatarUrl={null}
    />,
    { wrapper: I18nTestProvider },
  )
}

describe('AvatarUploadDialog — AVATAR_MAX_BYTES size-rejection message', () => {
  it('a file over 5 MB is rejected with the exact formatted "5 МБ" limit', () => {
    renderDialog()
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement

    // 6 MB — comfortably over the 5 MB limit, well under any float-rounding edge.
    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', {
      type: 'image/png',
    })
    fireEvent.change(input, { target: { files: [oversized] } })

    // The dialog's OWN static description also contains "5 МБ" ("Завантажте
    // файл (PNG, JPEG, GIF, WebP, до 5 МБ)…"), unconditionally — a plain
    // `/5\s?МБ/` match would pass against THAT text even if `handleFile`'s
    // size branch were mutated to `if (false)` (no error ever set) or its
    // message emptied to `t\`\``, which is exactly what happened here on the
    // first pass (mutation-gate Fix-round B: both mutants survived against
    // this same assertion). Anchoring on "виберіть менший" — wording unique
    // to the size-rejection message — actually requires the branch and the
    // real message text.
    expect(screen.getByText('Файл 6,0 МБ — максимум 5,0 МБ, виберіть менший')).toBeInTheDocument()
  })

  it('a file at exactly 5 MB is NOT rejected (boundary is > , not >=)', () => {
    renderDialog()
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement
    const exact = new File([new Uint8Array(5 * 1024 * 1024)], 'exact.png', {
      type: 'image/png',
    })
    fireEvent.change(input, { target: { files: [exact] } })
    expect(screen.queryByText(/максимум/)).not.toBeInTheDocument()
  })
})

// mutation-gate (@crm/web, Fix-round B, CI-MUT) — the source-tab toggle's own
// option labels + aria-label had zero unit assertion (only the size-rejection
// error text above was pinned).
describe('AvatarUploadDialog — source tab toggle labels', () => {
  it('renders the "Файл"/"Посилання" tab labels and the toggle group aria-label', () => {
    renderDialog()
    expect(screen.getByText('Файл')).toBeInTheDocument()
    expect(screen.getByText('Посилання')).toBeInTheDocument()
    expect(screen.getByLabelText('Джерело зображення')).toBeInTheDocument()
  })

  it('shows the "Читання файлу…" progress label the instant a valid file is selected, before the async FileReader resolves', () => {
    renderDialog()
    const input = screen.getByTestId('avatar-file-input') as HTMLInputElement
    const valid = new File([new Uint8Array(1024)], 'small.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [valid] } })
    // `handleFile` calls `progress.prepare()` (phase: 'preparing') SYNCHRONOUSLY
    // before constructing the FileReader — the label must already be on
    // screen here, before this test ever awaits the read's onload.
    expect(screen.getByText('Читання файлу…')).toBeInTheDocument()
  })
})
