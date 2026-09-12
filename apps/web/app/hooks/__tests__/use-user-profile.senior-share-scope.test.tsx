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
// CR-M-2 (fix-round 3): assert against the REAL key, not a second copy of
// its literal — a rename of the constant must turn this test red, which is
// exactly what a hardcoded ['pending'] on both sides could never do.
import { PENDING_QUERY_KEY } from '../use-pending-items'

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

  it('COPY-L-1: names the project when the response carries it — on /pending the row disappears as the toast appears', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 41, name: 'TechFlow' } })
    renderProbe(() => useApproveSeniorShareChange('project', PROJECT_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Доля по проекту «TechFlow» теперь 41%'),
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: PENDING_QUERY_KEY })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['user-profile', PROJECT_ID] })
  })

  it('a response body of `undefined` (e.g. a 204) resolves the percent to null instead of throwing', async () => {
    // Distinct from the `{}` case above: `undefined?.effectiveSeniorSharePercent`
    // is the ONLY thing standing between this and `Cannot read properties of
    // undefined` — `{}` alone would not reach that branch (a missing key on a
    // real object is `undefined` already, without needing the `?.` at all).
    mockPost.mockResolvedValue({ data: undefined })
    renderProbe(() => useApproveSeniorShareChange('project', PROJECT_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Доля по проекту теперь null%'),
    )
  })
})

describe('useApproveSeniorShareChange — scope: "user" (a response with no `user` field at all must not crash)', () => {
  it('a success payload missing `user` resolves the percent to null instead of throwing', async () => {
    mockPost.mockResolvedValue({ data: {} })
    renderProbe(() => useApproveSeniorShareChange('user', USER_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Доля по умолчанию теперь null%'),
    )
  })

  it('a response body of `undefined` ALSO resolves to null instead of throwing (distinct from a merely-missing `user` key)', async () => {
    // `({}).user?.x` never touches the outer `?.` at all (a real object's
    // missing key is `undefined` already) — only `data` itself being
    // `undefined`/`null` exercises THAT optional-chaining link.
    mockPost.mockResolvedValue({ data: undefined })
    renderProbe(() => useApproveSeniorShareChange('user', USER_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Доля по умолчанию теперь null%'),
    )
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: PENDING_QUERY_KEY })
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: PENDING_QUERY_KEY })
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: PENDING_QUERY_KEY })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['projects', USER_ID] })
  })
})

describe('COPY-L-1 — the toast names the object of the decision, not just the number', () => {
  it('user scope, approve: «Доля по умолчанию теперь X%» — the same object the /pending row is titled with', async () => {
    mockPost.mockResolvedValue({ data: { user: { seniorSharePercent: 30 } } })
    renderProbe(() => useApproveSeniorShareChange('user', USER_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Доля по умолчанию теперь 30%'))
  })

  it('project scope, reject: names the project — the row it referred to is gone by the time it is read', async () => {
    mockPost.mockResolvedValue({ data: { name: 'TechFlow' } })
    renderProbe(() => useRejectSeniorShareChange('project', PROJECT_ID), 'слишком поздно')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Предложение по проекту «TechFlow» отклонено — действует прежний процент. Админ увидит причину',
      ),
    )
  })

  it('project scope, reject with no name in the response: falls back to the unnamed sentence rather than ««undefined»»', async () => {
    mockPost.mockResolvedValue({ data: {} })
    renderProbe(() => useRejectSeniorShareChange('project', PROJECT_ID), 'слишком поздно')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Предложение отклонено — действует прежний процент. Админ увидит причину',
      ),
    )
  })

  it('a project name that is not a string is ignored — «Доля по проекту «123»» would be a defect, not a degradation', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 41, name: 123 } })
    renderProbe(() => useApproveSeniorShareChange('project', PROJECT_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Доля по проекту теперь 41%'))
  })

  it('an EMPTY project name is ignored as well — «Доля по проекту «» теперь 41%» is worse than saying nothing', async () => {
    mockPost.mockResolvedValue({ data: { effectiveSeniorSharePercent: 41, name: '' } })
    renderProbe(() => useApproveSeniorShareChange('project', PROJECT_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Доля по проекту теперь 41%'))
  })

  it('a user-scope response carrying a stray `name` never leaks it into the base-share sentence', async () => {
    mockPost.mockResolvedValue({
      data: { user: { seniorSharePercent: 30 }, name: 'TechFlow' },
    })
    renderProbe(() => useApproveSeniorShareChange('user', USER_ID), undefined)
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Доля по умолчанию теперь 30%'))
  })

  it('user scope, reject: «по доле по умолчанию» — there is no project to name', async () => {
    mockPost.mockResolvedValue({ data: {} })
    renderProbe(() => useRejectSeniorShareChange('user', USER_ID), 'ошиблись')
    await userEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Предложение по доле по умолчанию отклонено — действует прежний процент. Админ увидит причину',
      ),
    )
  })
})
