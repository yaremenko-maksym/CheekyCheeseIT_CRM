/**
 * useChangePersonalEmail / useResendPersonalEmailInvite — mutation-gate
 * closure (security-review PR #623 round 5): this file had zero prior
 * coverage of either hook's `onSuccess` toast branching, so the gate found
 * every conditional inside both callbacks surviving unmutated.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { useChangePersonalEmail, useResendPersonalEmailInvite } from '../use-user-profile'

/** Fires the given mutation once on click and exposes nothing else — the
 * hooks under test are pure side-effect (toast) machines, so a tiny probe
 * component is enough; no need for `renderHook` + manual `act()` wrangling
 * across an async mutation. Generic over the mutation's own variables type
 * (`string | null` for `useChangePersonalEmail`, `void` for
 * `useResendPersonalEmailInvite`) — `react-query`'s `UseMutateFunction` is
 * contravariant in its parameter, so a widened `unknown` signature here is
 * not assignable to it; matching the real type is required, not cosmetic. */
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <MutationProbe hook={hook} arg={arg} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useChangePersonalEmail — onSuccess toast branches', () => {
  it('delivered === null (removal / no-op) → names the removed access, not the generic "Сохранено"', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true, delivered: null },
    })
    renderProbe(() => useChangePersonalEmail('u-1'), null)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Личный адрес удалён — вход по нему больше не работает.',
      ),
    )
  })

  it('delivered === true → the "email sent" success toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true, delivered: true },
    })
    renderProbe(() => useChangePersonalEmail('u-1'), 'new@example.com')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Письмо отправлено на личный адрес'),
    )
  })

  it('delivered === false → the delivery-FAILED error toast, not success', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true, delivered: false },
    })
    renderProbe(() => useChangePersonalEmail('u-1'), 'new@example.com')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Письмо не ушло — почтовый сервис не ответил. Попробуйте ещё раз через пару минут.',
      ),
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a rejected request shows the backend error message', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Этот адрес уже занят другим пользователем.'),
    )
    renderProbe(() => useChangePersonalEmail('u-1'), 'taken@example.com')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Ошибка: Этот адрес уже занят другим пользователем.',
      ),
    )
  })

  it('PATCHes the exact endpoint for this user with the given address', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true, delivered: true },
    })
    renderProbe(() => useChangePersonalEmail('u-42'), 'x@example.com')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/users/u-42/personal-email', {
        personalEmail: 'x@example.com',
      }),
    )
  })
})

describe('useResendPersonalEmailInvite — onSuccess toast branches', () => {
  it('delivered === true → success toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true, delivered: true },
    })
    renderProbe(() => useResendPersonalEmailInvite('u-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Письмо отправлено на личный адрес'),
    )
  })

  it('delivered === false → delivery-failed error toast, not success', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true, delivered: false },
    })
    renderProbe(() => useResendPersonalEmailInvite('u-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Письмо не ушло — почтовый сервис не ответил. Попробуйте ещё раз через пару минут.',
      ),
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('POSTs the exact resend-invite endpoint for this user', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true, delivered: true },
    })
    renderProbe(() => useResendPersonalEmailInvite('u-7'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/users/u-7/personal-email/resend-invite'),
    )
  })
})
