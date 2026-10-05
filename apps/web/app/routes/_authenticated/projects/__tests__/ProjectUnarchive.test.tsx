/**
 * Mikado leaf 4 — characterization of the two components extracted from
 * `$projectId.tsx` into `ProjectUnarchive.tsx`. They were reachable only from
 * Playwright; the mutation gate runs the unit suite only, so this file pins the
 * CURRENT behavior (labels, request URLs, 409-cascade hand-off, modal close).
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import type { UnarchiveCascadeEntity } from '@/hooks/use-archive'
import { ProjectCascadeUnarchiveModal, ProjectUnarchiveHeaderButton } from '../ProjectUnarchive'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'

const PROJECT_ID = 'b0000000-0000-4000-8000-000000000001'
const ENTITIES: UnarchiveCascadeEntity[] = [
  { type: 'user', id: 'u1', name: 'Олексій Коваленко' },
  { type: 'team', id: 't1', name: 'Команда Альфа' },
]

beforeEach(async () => {
  await loadCatalog('uk')
  vi.mocked(api.post).mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.error).mockReset()
})

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>, {
    wrapper: I18nTestProvider,
  })
}

function axiosError(status: number, data: unknown) {
  return Object.assign(new Error('request failed'), { response: { status, data } })
}

describe('ProjectUnarchiveHeaderButton', () => {
  function renderButton(onCascadeRequired = vi.fn()) {
    wrap(
      <ProjectUnarchiveHeaderButton
        projectId={PROJECT_ID}
        projectName="Проєкт"
        onCascadeRequired={onCascadeRequired}
      />,
    )
    return onCascadeRequired
  }

  it('renders the «Відновити» button, enabled, with its testid', () => {
    renderButton()
    const btn = screen.getByTestId('project-unarchive-button')
    expect(btn).toHaveTextContent('Відновити')
    expect(btn).toBeEnabled()
  })

  it('click POSTs the plain unarchive URL (no cascade) and does not hand off on success', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    const onCascade = renderButton()
    await userEvent.click(screen.getByTestId('project-unarchive-button'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Проєкт відновлено'))
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/unarchive`)
    expect(onCascade).not.toHaveBeenCalled()
  })

  it('is disabled while the request is pending', async () => {
    vi.mocked(api.post).mockReturnValue(new Promise(() => {}))
    renderButton()
    await userEvent.click(screen.getByTestId('project-unarchive-button'))
    await waitFor(() => expect(screen.getByTestId('project-unarchive-button')).toBeDisabled())
  })

  it('409 + requiresCascade lifts the entities to the parent, without an error toast', async () => {
    vi.mocked(api.post).mockRejectedValue(
      axiosError(409, { requiresCascade: true, entities: ENTITIES }),
    )
    const onCascade = renderButton()
    await userEvent.click(screen.getByTestId('project-unarchive-button'))
    await waitFor(() => expect(onCascade).toHaveBeenCalledWith(ENTITIES))
    expect(onCascade).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('409 without requiresCascade does not hand off', async () => {
    vi.mocked(api.post).mockRejectedValue(axiosError(409, { requiresCascade: false }))
    const onCascade = renderButton()
    await userEvent.click(screen.getByTestId('project-unarchive-button'))
    await waitFor(() => expect(screen.getByTestId('project-unarchive-button')).toBeEnabled())
    expect(onCascade).not.toHaveBeenCalled()
  })

  it('a non-409 failure does not hand off and shows the error toast', async () => {
    vi.mocked(api.post).mockRejectedValue(
      axiosError(500, { requiresCascade: true, entities: ENTITIES, message: 'boom' }),
    )
    const onCascade = renderButton()
    await userEvent.click(screen.getByTestId('project-unarchive-button'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    expect(onCascade).not.toHaveBeenCalled()
  })
})

describe('ProjectCascadeUnarchiveModal', () => {
  function renderModal(onClose = vi.fn()) {
    wrap(
      <ProjectCascadeUnarchiveModal
        projectId={PROJECT_ID}
        projectName="Проєкт Ікс"
        entities={ENTITIES}
        onClose={onClose}
      />,
    )
    return onClose
  }

  it('lists the project name and every cascade entity with its type label', () => {
    renderModal()
    expect(screen.getByText('Відновити пов’язане')).toBeInTheDocument()
    expect(screen.getByText('Проєкт Ікс')).toBeInTheDocument()
    expect(screen.getByTestId('cascade-entity-user')).toHaveTextContent('Користувач (сеньйор)')
    expect(screen.getByTestId('cascade-entity-user')).toHaveTextContent('Олексій Коваленко')
    expect(screen.getByTestId('cascade-entity-team')).toHaveTextContent('Команда')
    expect(screen.getByTestId('cascade-entity-team')).toHaveTextContent('Команда Альфа')
    expect(screen.getByTestId('cascade-unarchive-confirm')).toHaveTextContent('Відновити все')
  })

  it('confirm POSTs with ?cascade=true, then closes', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    const onClose = renderModal()
    await userEvent.click(screen.getByTestId('cascade-unarchive-confirm'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/unarchive?cascade=true`)
    expect(toast.success).toHaveBeenCalledWith('Відновлено: проєкт, сеньйор, команда')
  })

  it('cancel closes without sending any request', async () => {
    const onClose = renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.post).not.toHaveBeenCalled()
  })

  it('while the request is pending the confirm shows «Відновлення…» and is disabled', async () => {
    vi.mocked(api.post).mockReturnValue(new Promise(() => {}))
    const onClose = renderModal()
    await userEvent.click(screen.getByTestId('cascade-unarchive-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('cascade-unarchive-confirm')).toHaveTextContent('Відновлення…'),
    )
    expect(screen.getByTestId('cascade-unarchive-confirm')).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
