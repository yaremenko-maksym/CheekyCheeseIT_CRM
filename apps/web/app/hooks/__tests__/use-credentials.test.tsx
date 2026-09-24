/**
 * use-credentials.ts — mutation-gate gap-fill (task-i18n-stage3a, Task 2).
 *
 * Before this file none of the four mutation hooks' toast text was
 * exercised by any test — component tests mock the hook module entirely, so
 * the real `onSuccess`/`onError` callbacks never ran under coverage. Pins
 * the exact uk toast text for each hook's success AND error path.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import {
  useCreateCredential,
  useUpdateCredential,
  useDeleteCredential,
  useUpdateUserCredential,
} from '../use-credentials'

function MutationProbe<TVariables>({
  hook,
  arg,
}: {
  hook: () => { mutate: (variables: TVariables) => void }
  arg: TVariables
}) {
  const mutation = hook()
  return (
    <button data-testid="fire" onClick={() => mutation.mutate(arg)}>
      fire
    </button>
  )
}

function renderProbe<TVariables>(
  hook: () => { mutate: (variables: TVariables) => void },
  arg: TVariables,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <MutationProbe hook={hook} arg={arg} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  vi.clearAllMocks()
})

describe('useCreateCredential', () => {
  it('success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      label: 'GitHub',
      login: 'a',
      url: null,
      notes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } })
    renderProbe(() => useCreateCredential('proj-1'), {
      label: 'GitHub',
      login: 'a',
      password: 'b',
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Пароль додано'))
  })

  it('error toast names the failed action and includes the error message', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useCreateCredential('proj-1'), {
      label: 'GitHub',
      login: 'a',
      password: 'b',
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося додати пароль: boom'),
    )
  })
})

describe('useUpdateCredential', () => {
  it('success toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      label: 'GitHub',
      login: 'a',
      url: null,
      notes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } })
    renderProbe(() => useUpdateCredential('proj-1'), {
      id: 'cred-1',
      data: { login: 'a', password: 'b' },
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Зміни збережено'))
  })

  it('error toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useUpdateCredential('proj-1'), {
      id: 'cred-1',
      data: { login: 'a', password: 'b' },
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося зберегти пароль: boom'),
    )
  })
})

describe('useDeleteCredential', () => {
  it('success toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useDeleteCredential('proj-1'), 'cred-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Пароль видалено'))
  })

  it('error toast', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useDeleteCredential('proj-1'), 'cred-1')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося видалити пароль: boom'),
    )
  })
})

describe('useUpdateUserCredential', () => {
  it('success toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {
      id: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      label: 'GitHub',
      login: 'a',
      url: null,
      notes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } })
    renderProbe(() => useUpdateUserCredential('user-1'), {
      id: 'cred-1',
      data: { login: 'a', password: 'b' },
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Зміни збережено'))
  })

  it('error toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useUpdateUserCredential('user-1'), {
      id: 'cred-1',
      data: { login: 'a', password: 'b' },
    })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося зберегти пароль: boom'),
    )
  })
})
