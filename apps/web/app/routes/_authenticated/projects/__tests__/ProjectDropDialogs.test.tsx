/**
 * Mikado leaf 9 — characterization of the drop picker + detach-confirm dialogs
 * extracted from `$projectId.tsx` into `ProjectDropDialogs.tsx`. Expected values
 * are hand-written literals (labels, URLs, testids), not derived from the code.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ProjectDropDialogs, type DropCandidate } from '../ProjectDropDialogs'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { api } from '@/lib/axios'

const CANDIDATES: DropCandidate[] = [
  { id: 'd1', displayName: 'Іван Петренко', email: 'ivan@example.com', avatarUrl: null },
  { id: 'd2', displayName: 'Марія Шевченко', email: 'maria@example.com', avatarUrl: null },
]

beforeEach(async () => {
  await loadCatalog('uk')
  vi.mocked(api.patch).mockReset()
})

function setup(props: Partial<React.ComponentProps<typeof ProjectDropDialogs>> = {}): {
  onCloseDropPicker: ReturnType<typeof vi.fn>
  onCloseDetachDropConfirm: ReturnType<typeof vi.fn>
} {
  const onCloseDropPicker = vi.fn()
  const onCloseDetachDropConfirm = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <ProjectDropDialogs
        projectId="proj-1"
        currentDropDisplayName="Олег Дроп"
        dropCandidates={CANDIDATES}
        dropPickerOpen={false}
        onCloseDropPicker={onCloseDropPicker}
        detachDropConfirmOpen={false}
        onCloseDetachDropConfirm={onCloseDetachDropConfirm}
        {...props}
      />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
  return { onCloseDropPicker, onCloseDetachDropConfirm }
}

describe('ProjectDropDialogs — picker', () => {
  it('renders nothing when both dialogs are closed', () => {
    setup()
    expect(screen.queryByTestId('attach-drop-dialog')).toBeNull()
    expect(screen.queryByTestId('detach-drop-dialog')).toBeNull()
  })

  it('lists every candidate with name, email and an assign button', () => {
    setup({ dropPickerOpen: true })
    expect(screen.getByTestId('attach-drop-dialog')).toBeTruthy()
    expect(screen.getByText('Прив’язати дропа')).toBeTruthy()
    expect(screen.getByText('Іван Петренко')).toBeTruthy()
    expect(screen.getByText('maria@example.com')).toBeTruthy()
    expect(screen.getByTestId('assign-drop-btn-d1').textContent).toBe('Призначити')
    expect(screen.getByTestId('assign-drop-btn-d2').getAttribute('aria-label')).toBe(
      'Призначити Марія Шевченко дропом',
    )
  })

  it('shows the empty state when there are no candidates', () => {
    setup({ dropPickerOpen: true, dropCandidates: [] })
    expect(screen.getByText('Немає доступних дропів')).toBeTruthy()
    expect(screen.queryByTestId('assign-drop-btn-d1')).toBeNull()
  })

  it('assign PATCHes { dropId } and closes BOTH dialogs on success', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { id: 'proj-1' } })
    const { onCloseDropPicker, onCloseDetachDropConfirm } = setup({ dropPickerOpen: true })
    await userEvent.click(screen.getByTestId('assign-drop-btn-d2'))
    await waitFor(() => expect(onCloseDropPicker).toHaveBeenCalled())
    expect(api.patch).toHaveBeenCalledWith('/projects/proj-1', { dropId: 'd2' })
    expect(onCloseDetachDropConfirm).toHaveBeenCalled()
  })

  it('disables assign buttons and shows pending label while the request is in flight', async () => {
    vi.mocked(api.patch).mockReturnValue(new Promise(() => {}))
    setup({ dropPickerOpen: true })
    await userEvent.click(screen.getByTestId('assign-drop-btn-d1'))
    await waitFor(() =>
      expect(screen.getByTestId('assign-drop-btn-d2').textContent).toBe('Призначаємо…'),
    )
    expect((screen.getByTestId('assign-drop-btn-d2') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Escape closes via onCloseDropPicker only', async () => {
    const { onCloseDropPicker, onCloseDetachDropConfirm } = setup({ dropPickerOpen: true })
    await userEvent.keyboard('{Escape}')
    expect(onCloseDropPicker).toHaveBeenCalledTimes(1)
    expect(onCloseDetachDropConfirm).not.toHaveBeenCalled()
  })
})

describe('ProjectDropDialogs — detach confirm', () => {
  it('shows title, current drop name and confirm/cancel labels', () => {
    setup({ detachDropConfirmOpen: true })
    expect(screen.getByTestId('detach-drop-dialog')).toBeTruthy()
    expect(screen.getByText('Відв’язати дропа?')).toBeTruthy()
    expect(screen.getByText('Олег Дроп')).toBeTruthy()
    expect(screen.getByTestId('detach-drop-confirm-btn').textContent).toBe('Відв’язати')
    expect(screen.getByText('Скасувати')).toBeTruthy()
  })

  it('falls back to the role label when the drop name is masked/absent', () => {
    setup({ detachDropConfirmOpen: true, currentDropDisplayName: undefined })
    expect(screen.getByText('Дроп')).toBeTruthy()
  })

  it('confirm PATCHes { dropId: null } and closes both dialogs', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { id: 'proj-1' } })
    const { onCloseDropPicker, onCloseDetachDropConfirm } = setup({ detachDropConfirmOpen: true })
    await userEvent.click(screen.getByTestId('detach-drop-confirm-btn'))
    await waitFor(() => expect(onCloseDetachDropConfirm).toHaveBeenCalled())
    expect(api.patch).toHaveBeenCalledWith('/projects/proj-1', { dropId: null })
    expect(onCloseDropPicker).toHaveBeenCalled()
  })

  it('cancel closes without any request', async () => {
    const { onCloseDetachDropConfirm } = setup({ detachDropConfirmOpen: true })
    await userEvent.click(screen.getByText('Скасувати'))
    expect(onCloseDetachDropConfirm).toHaveBeenCalledTimes(1)
    expect(api.patch).not.toHaveBeenCalled()
  })
})
