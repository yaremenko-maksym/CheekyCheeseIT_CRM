/**
 * ResumeVerificationPanel — staged PDF (preview, download, template line).
 * Split out of ResumeVerificationPanel.test.tsx (at the size cap).
 */
import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '@/test/i18n'
import {
  STAGED,
  createRenderWired,
  createStagedPdfGets,
  makeResponse,
} from './ResumeVerificationPanel.render'

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}))
vi.mock('@/lib/axios', () => ({ api: { get: getMock, post: postMock, put: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const renderWired = createRenderWired(getMock, postMock)
const stagedPdfGets = createStagedPdfGets(getMock)

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

describe('ResumeVerificationPanel — staged PDF', () => {
  it('staged PDF refetches when the check finishes (CHECKING -> AWAITING_CONFIRM)', async () => {
    const { serverMovesTo } = renderWired(makeResponse())
    await waitFor(() => expect(stagedPdfGets()).toBe(1))

    // A staged edit starts a run: same runId, the old PDF is still on the row.
    await serverMovesTo(makeResponse({ verificationStatus: 'CHECKING', verificationBusy: true }))
    expect(await screen.findByTestId('resume-confirm-checking')).toBeInTheDocument()
    expect(stagedPdfGets()).toBe(1)

    await serverMovesTo(makeResponse())
    await waitFor(() => expect(screen.queryByTestId('resume-confirm-checking')).toBeNull())
    await waitFor(() => expect(stagedPdfGets()).toBe(2))
  })

  it('names the template of the staged PDF', async () => {
    renderWired(makeResponse({ staged: { ...STAGED, templateName: 'modern' } }))
    const pdf = await screen.findByTestId('resume-staged-pdf')
    expect(within(pdf).getByTestId('resume-staged-pdf-template')).toHaveTextContent(
      'Шаблон: Сучасний',
    )
  })

  it('gives the staged PDF preview its own accessible name, not the filename default', async () => {
    // happy-dom's URL inherits real object-URL statics: spy them and unmount before restoring,
    // so the hook's unmount revoke lands on the spy, not on the real method.
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:staged')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const name = 'Попередній перегляд PDF резюме до підтвердження'
    try {
      const view = renderWired(makeResponse(), new Blob(['%PDF'], { type: 'application/pdf' }))
      const object = await screen.findByTestId('resume-staged-pdf-object')
      expect(await within(object).findByTitle(name)).toHaveAccessibleName(name)
      view.unmount()
      expect(revoke).toHaveBeenCalledWith('blob:staged')
    } finally {
      create.mockRestore()
      revoke.mockRestore()
    }
  })

  it('no staged PDF fetch while busy', async () => {
    renderWired(makeResponse({ verificationStatus: 'QUEUED', verificationBusy: true }))
    const pdf = await screen.findByTestId('resume-staged-pdf')
    expect(stagedPdfGets()).toBe(0)
    // No download of a PDF the run is about to replace.
    expect(within(pdf).queryByRole('link', { name: 'Завантажити PDF' })).toBeNull()
  })
})
