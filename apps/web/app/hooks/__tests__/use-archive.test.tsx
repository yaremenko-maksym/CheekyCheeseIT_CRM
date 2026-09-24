/**
 * use-archive.ts — mutation-gate gap-fill (task-i18n-stage3a, Task 2).
 * Neither `useArchiveEntity` nor `useUnarchiveEntity`'s toast text/error
 * branching was exercised by any test before this file — component tests
 * (ArchiveUserDialog, team-archive E2E) mock the hook module or only ever
 * exercise ONE entity type through the real hook. Pins the per-entity-type
 * success text and the error-message-present/absent branches.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { delete: vi.fn(), post: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { useArchiveEntity, useUnarchiveEntity, type EntityType } from '../use-archive'

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

describe('useArchiveEntity — success toast per entity type', () => {
  it.each<[EntityType, string]>([
    ['user', 'Користувача заархівовано'],
    ['team', 'Команду та сеньйора заархівовано'],
    ['project', 'Проєкт заархівовано'],
  ])('%s → %s', async (entityType, expected) => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useArchiveEntity(entityType, 'e-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expected))
  })
})

describe('useArchiveEntity — error toast', () => {
  it('shows the backend message when present', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: 'Не можна архівувати активний проєкт' } },
    })
    renderProbe(() => useArchiveEntity('project', 'e-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не можна архівувати активний проєкт'),
    )
  })

  it('falls back to the generic message when the backend sends none', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    renderProbe(() => useArchiveEntity('project', 'e-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося заархівувати. Спробуйте ще раз'))
  })

  // Mutation-gate gap-fill: the optional-chaining CHAIN itself
  // (`err?.response?.data?.message`) needs a case per link where the
  // PREVIOUS link is present but THIS one is absent — a rejection with a
  // full `response.data.message` (above) or none at all (above) cannot
  // distinguish `err?.response` from `err.response`, or `data?.message`
  // from `data.message`: both forms evaluate identically when every link
  // up to the missing one is populated.
  it('a response WITH data but no message key does not throw — falls back cleanly', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue({ response: { data: {} } })
    renderProbe(() => useArchiveEntity('project', 'e-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося заархівувати. Спробуйте ще раз'))
  })

  it('a response with NO data at all does not throw reading .message off it — falls back cleanly', async () => {
    // Distinct from the `data: {}` case above: `{}.message` never touches
    // the `data?.` link at all (a defined object's missing key is
    // `undefined` already) — only `data` itself being absent exercises
    // THAT specific optional-chaining link.
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue({ response: {} })
    renderProbe(() => useArchiveEntity('project', 'e-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося заархівувати. Спробуйте ще раз'))
  })

  it('a rejection value that is not an object at all does not throw — falls back cleanly', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockRejectedValue(null)
    renderProbe(() => useArchiveEntity('project', 'e-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося заархівувати. Спробуйте ще раз'))
  })
})

describe('useUnarchiveEntity — success toast per entity type', () => {
  it('user', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useUnarchiveEntity('user', 'e-1'), {})
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Користувача відновлено'))
  })

  it('team', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useUnarchiveEntity('team', 'e-1'), {})
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Команду та сеньйора відновлено'),
    )
  })

  it('project, no cascade', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useUnarchiveEntity('project', 'e-1'), {})
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Проєкт відновлено'))
  })

  it('project, WITH cascade — names the whole restored set', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null })
    renderProbe(() => useUnarchiveEntity('project', 'e-1'), { cascade: true })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Відновлено: проєкт, сеньйор, команда'),
    )
  })
})

describe('useUnarchiveEntity — error toast', () => {
  it('a 409 (cascade required) shows NO toast — the caller handles the modal', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({ response: { status: 409 } })
    renderProbe(() => useUnarchiveEntity('project', 'e-1'), {})
    await userEvent.click(screen.getByTestId('fire'))
    // No waitFor target to await success on — give the microtask queue a
    // turn, then assert neither toast fired.
    await new Promise((r) => setTimeout(r, 0))
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows the backend message when present (non-409)', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 400, data: { message: 'Проєкт вже активний' } },
    })
    renderProbe(() => useUnarchiveEntity('project', 'e-1'), {})
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Проєкт вже активний'))
  })

  it('falls back to the generic message when the backend sends none', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue({ response: { status: 400 } })
    renderProbe(() => useUnarchiveEntity('project', 'e-1'), {})
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося відновити. Спробуйте ще раз'))
  })
})
