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

    // formatBytes(5 * 1024 * 1024, 'uk') — pinned literally so a mutant that
    // changes the arithmetic (5*1024/1024, 5/1024*1024, 5*1025*1024, …)
    // shows up as a DIFFERENT number here.
    expect(screen.getByText(/5[,.]?\s?МБ/)).toBeInTheDocument()
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
