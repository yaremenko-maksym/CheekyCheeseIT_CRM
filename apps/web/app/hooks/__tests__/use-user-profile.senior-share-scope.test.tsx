/**
 * task-667-mutation-web. `useApproveSeniorShareChange`/`useRejectSeniorShareChange`
 * were generalized by a `scope: 'user' | 'project'` parameter (task-pending-screen
 * addendum item 2, 2026-09-07) — `scope: 'user'` is exercised end-to-end by
 * `OverviewTab.pending-share.test.tsx` (the real base-share banner), but
 * `scope: 'project'` has exactly one caller in the whole app
 * (`SeniorShareApprovalActions`, the /pending screen's row action), and THAT
 * component's own test file mocks both hooks away entirely
 * (`vi.mock('@/hooks/use-user-profile', ...)`). Every `scope === 'user'`
 * branch inside these two hooks was therefore never actually exercised on
 * its `false` side — this file closes that gap directly against the real
 * hooks (no mocking of use-user-profile itself).
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { useApproveSeniorShareChange, useRejectSeniorShareChange } from '../use-user-profile'

const mockPost = api.post as ReturnType<typeof vi.fn>

/** Same probe shape as use-user-profile.change-personal-email.test.tsx —
 * both hooks under test are pure side-effect (toast + cache invalidation)
 * machines once `.mutate()` fires, so a tiny button is enough. */
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
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <MutationProbe hook={hook} arg={arg} />
    </QueryClientProvider>,
  )
  return { qc, invalidateSpy }
}

const PROJECT_ID = 'a0000000-0000-4000-8000-00000000c001'
const USER_ID = 'a0000000-0000-4000-8000-00000000c002'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useApproveSeniorShareChange — scope: "project" (never exercised via a real call before)', () => {
  it('POSTs to the PROJECT endpoint, not the user one', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 41 } })
    renderProbe(() => useApproveSeniorShareChange('project', PROJECT_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/senior-share/approve`),
    )
  })

  it('reads the confirmed percent from `effectiveSeniorSharePercent` (ProjectDetailDto), not `user.seniorSharePercent`', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 41 } })
    renderProbe(() => useApproveSeniorShareChange('project', PROJECT_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Доля по проекту теперь 41%'),
    )
  })

  it('invalidates the PROJECT + pending queries, never the user-profile ones', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 41 } })
    const { invalidateSpy } = renderProbe(
      () => useApproveSeniorShareChange('project', PROJECT_ID),
      undefined,
    )
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects', PROJECT_ID] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pending'] })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['user-profile', PROJECT_ID] })
  })
})

describe('useApproveSeniorShareChange — scope: "user" (a response with no `user` field at all must not crash)', () => {
  it('a success payload missing `user` resolves the percent to null instead of throwing', async () => {
    mockPost.mockResolvedValue({ data: {} })
    renderProbe(() => useApproveSeniorShareChange('user', USER_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ваша доля теперь null%'))
  })

  it('invalidates the user-profile + pending queries, never the project ones', async () => {
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 30 } } })
    const { invalidateSpy } = renderProbe(
      () => useApproveSeniorShareChange('user', USER_ID),
      undefined,
    )
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', USER_ID] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'me'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pending'] })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['projects', USER_ID] })
  })
})

describe('useRejectSeniorShareChange — scope: "project" (never exercised via a real call before)', () => {
  it('POSTs the reason to the PROJECT endpoint, not the user one', async () => {
    mockPost.mockResolvedValue({ data: {} })
    renderProbe(() => useRejectSeniorShareChange('project', PROJECT_ID), 'слишком поздно')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/senior-share/reject`, {
        reason: 'слишком поздно',
      }),
    )
  })

  it('invalidates the PROJECT + pending queries, never the user-profile ones', async () => {
    mockPost.mockResolvedValue({ data: {} })
    const { invalidateSpy } = renderProbe(
      () => useRejectSeniorShareChange('project', PROJECT_ID),
      'слишком поздно',
    )
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(mockPost).toHaveBeenCalled())
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects', PROJECT_ID] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pending'] })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['user-profile', PROJECT_ID] })
  })
})

describe('useRejectSeniorShareChange — scope: "user"', () => {
  it('POSTs the reason to the USER endpoint and invalidates the user-profile + pending queries', async () => {
    mockPost.mockResolvedValue({ data: {} })
    const { invalidateSpy } = renderProbe(
      () => useRejectSeniorShareChange('user', USER_ID),
      'ошиблись',
    )
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`/users/${USER_ID}/senior-share/reject`, {
        reason: 'ошиблись',
      }),
    )
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', USER_ID] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['user-profile', 'me'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pending'] })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['projects', USER_ID] })
  })
})
