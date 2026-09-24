/**
 * use-user-profile.ts — mutation-gate gap-fill (task-i18n-stage3a, Task 2).
 * `seniorShareErrorMessage`'s own default fallback and four mutation hooks
 * (`useUpdateMe`, `useUpdateMeRequisites`, `useAdminSetNote`,
 * `useUnarchiveUser`) had zero coverage on their real callbacks — component
 * tests either mock the hook module or never assert on the toast text.
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
  seniorShareErrorMessage,
  useUpdateMe,
  useUpdateMeRequisites,
  useAdminSetNote,
  useUnarchiveUser,
} from '../use-user-profile'

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

describe('seniorShareErrorMessage — own default fallback (no `fallback` argument passed)', () => {
  it('a non-404/409 error with no message at all falls through to the OWN generic fallback', () => {
    // Kills the StringLiteral mutant on the module-level `msg` this function
    // falls back to when NEITHER a 404/409 mapping NOR a caller-supplied
    // fallback applies — every caller in this codebase always passes its
    // own fallback, so this is the only place that specific string is read.
    expect(seniorShareErrorMessage({})).toBe('Не вдалося виконати дію')
  })
})

describe('useUpdateMe', () => {
  it('success toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useUpdateMe(), { displayName: 'New Name' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Збережено'))
  })

  it('error toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useUpdateMe(), { displayName: 'New Name' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося зберегти: boom'))
  })
})

describe('useUpdateMeRequisites', () => {
  it('success toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useUpdateMeRequisites(), { paymentMethod: 'USDT_ERC20' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Реквізити оновлено'))
  })

  it('error toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useUpdateMeRequisites(), { paymentMethod: 'USDT_ERC20' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Не вдалося оновити реквізити: boom'),
    )
  })
})

describe('useAdminSetNote', () => {
  it('success toast', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useAdminSetNote('user-1'), { note: 'left the company' })
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Нотатку збережено'))
  })
})

describe('useUnarchiveUser', () => {
  it('isSenior=true → names both the senior and the team', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useUnarchiveUser('user-1', { isSenior: true }), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Сеньйора та команду відновлено'),
    )
  })

  it('isSenior=false/omitted → the generic "user restored" toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} })
    renderProbe(() => useUnarchiveUser('user-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Користувача відновлено з архіву'),
    )
  })

  it('error toast', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    renderProbe(() => useUnarchiveUser('user-1'), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося відновити: boom'))
  })
})
