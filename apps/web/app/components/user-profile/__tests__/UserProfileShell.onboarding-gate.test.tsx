/**
 * QA-1343-A: a not-onboarded account opening /profile is the layout's to send to /onboarding. The
 * self profile waits for the onboarding status and never asks for `/users/me` before it (the API
 * refuses that with a 403 until onboarding is done), as the JUNIOR hub does (PR #1334 QA-LOW-2).
 * The seam is the HTTP client: the real gate and the real `useMe` run, only `api.get` is faked.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'junior-1', role: 'JUNIOR' } }),
}))
vi.mock('@/hooks/use-active-team', () => ({ useActiveTeam: () => ({ isTeamless: false }) }))
vi.mock('@/lib/axios', () => ({
  api: {
    get: apiGet,
    post: () => Promise.reject(new Error('not mocked')),
    patch: () => Promise.reject(new Error('not mocked')),
    put: () => Promise.reject(new Error('not mocked')),
    delete: () => Promise.reject(new Error('not mocked')),
  },
}))
vi.mock('../UserProfileHeader', () => ({ UserProfileHeader: () => null }))
vi.mock('../AvatarUploadDialog', () => ({ AvatarUploadDialog: () => null }))
vi.mock('../tabs/OverviewTab', () => ({ OverviewTab: () => null }))

import { UserProfileShell } from '../UserProfileShell'

const answer = (data: unknown) => Promise.resolve({ status: 200, data })

function renderShell(mode: 'self' | 'view') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <UserProfileShell mode={mode} userId="target-1" tab="overview" onTabChange={() => {}} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

const asked = (url: string) => apiGet.mock.calls.some(([u]) => u === url)

beforeEach(async () => {
  await loadCatalog('uk')
  apiGet.mockReset()
})

describe('UserProfileShell — the self profile waits for onboarding (QA-1343-A)', () => {
  it('not onboarded: never asks for /users/me, and shows no «not found» while the redirect runs', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/onboarding/status'
        ? answer({ requiresContract: true, requiresTos: true })
        : answer(null),
    )
    renderShell('self')
    await act(() => new Promise((settle) => setTimeout(settle, 100))) // both answers are in
    expect(asked('/users/me')).toBe(false)
    expect(screen.queryByText('Профіль не знайдено')).not.toBeInTheDocument()
  })

  it('onboarded: asks for /users/me once the status is in', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/onboarding/status'
        ? answer({ requiresContract: false, requiresTos: false })
        : answer(null),
    )
    renderShell('self')
    await waitFor(() => expect(asked('/users/me')).toBe(true))
  })

  it('another profile does not wait for the gate: its own answer shows at once', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/onboarding/status'
        ? answer({ requiresContract: true, requiresTos: true })
        : answer(null),
    )
    renderShell('view')
    // the viewed profile's own answer (none here) shows, not a skeleton held by the gate
    expect(await screen.findByText('Профіль не знайдено')).toBeInTheDocument()
  })

  it('another profile never asks for /users/me, onboarded or not', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/onboarding/status'
        ? answer({ requiresContract: false, requiresTos: false })
        : answer(null),
    )
    renderShell('view')
    await waitFor(() => expect(asked('/users/target-1')).toBe(true))
    await act(() => new Promise((settle) => setTimeout(settle, 50)))
    expect(asked('/users/me')).toBe(false)
  })

  it('the status failed: still asks for /users/me (a broken status never locks the profile)', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/onboarding/status' ? Promise.reject(new Error('down')) : answer(null),
    )
    renderShell('self')
    await waitFor(() => expect(asked('/users/me')).toBe(true))
  })
})
