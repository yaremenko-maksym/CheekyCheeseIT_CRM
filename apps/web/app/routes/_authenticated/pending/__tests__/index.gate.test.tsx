/**
 * SR-M-2 / COPY-H-2 (PR #667, fix-round 4). The screen must never claim
 * «Ничего не ждёт вашего решения» before it has ASKED.
 *
 * Why this file exists next to `index.test.tsx` instead of inside it: that
 * file mocks `usePendingItems` wholesale (`mockState`), so the branch these
 * two findings are about — the onboarding gate closing the query — is never
 * executed there at all. Here the hook is REAL and only `api.get` is faked,
 * which is the only way the chain `useAuth → useOnboardingGate →
 * enabled: isComplete → screen state` can be observed end to end.
 *
 * The regression both reviewers traced: `enabled: false` in TanStack Query
 * v5 means `isLoading === false` (it is `isPending && isFetching`) with
 * `data === undefined` — so both early branches of the page fell through to
 * the empty state while `GET /onboarding/status` was still in flight, and
 * stayed there for the whole session if that request FAILED (the
 * `_authenticated` shell only redirects to `/onboarding` when the status
 * actually arrives and says so).
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

let mockRole = 'SENIOR'
vi.mock('@/context/auth', async (orig) => {
  const real = await orig<typeof import('@/context/auth')>()
  return { ...real, useAuth: () => ({ user: { id: 'u1', role: mockRole } }) }
})

import { api } from '@/lib/axios'
import { PendingPage } from '../index'

const mockGet = api.get as ReturnType<typeof vi.fn>

const COMPLETE_STATUS = {
  requiresContract: false,
  requiresTos: false,
  contractReady: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

/** `api.get` for both endpoints the chain touches, routed by url. */
function routeGet(handlers: {
  onboarding?: () => Promise<unknown>
  pending?: () => Promise<unknown>
}) {
  mockGet.mockImplementation((url: string) => {
    if (url === '/onboarding/status') {
      return (handlers.onboarding ?? (() => new Promise(() => {})))()
    }
    if (url === '/pending') {
      return (
        handlers.pending ?? (() => Promise.resolve({ data: { mine: [], proposedByMe: [] } }))
      )()
    }
    throw new Error(`unexpected GET ${url}`)
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(PendingPage)),
  )
}

beforeEach(() => {
  mockGet.mockReset()
  mockRole = 'SENIOR'
})

describe('/pending — the screen does not answer before it has asked', () => {
  it('SR-M-2/COPY-H-2: while GET /onboarding/status is in flight, shows the skeleton — not «Ничего не ждёт вашего решения»', async () => {
    routeGet({}) // status never resolves; /pending must not even be called
    renderPage()

    expect(await screen.findByTestId('pending-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-empty')).not.toBeInTheDocument()
    expect(screen.queryByText('Ничего не ждёт вашего решения')).not.toBeInTheDocument()
    expect(mockGet).not.toHaveBeenCalledWith('/pending')
  })

  it('SR-M-2: a FAILED GET /onboarding/status leaves the screen in its error state with «Повторить» — never a false all-clear', async () => {
    routeGet({ onboarding: () => Promise.reject(new Error('500')) })
    renderPage()

    expect(await screen.findByTestId('pending-error')).toBeInTheDocument()
    expect(screen.getByText('Не удалось загрузить, что ждёт решения.')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-empty')).not.toBeInTheDocument()
  })

  it('«Повторить» after a failed gate re-asks for the onboarding status, not just for /pending', async () => {
    const onboarding = vi
      .fn()
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValue({ data: COMPLETE_STATUS })
    routeGet({ onboarding })
    renderPage()

    const retry = await screen.findByRole('button', { name: 'Повторить загрузку' })
    retry.click()

    await waitFor(() => expect(onboarding).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('pending-empty')).toBeInTheDocument()
  })

  it('once onboarding is complete and /pending answers empty, the honest empty state is still shown', async () => {
    routeGet({ onboarding: () => Promise.resolve({ data: COMPLETE_STATUS }) })
    renderPage()

    expect(await screen.findByTestId('pending-empty')).toBeInTheDocument()
    expect(screen.getByText('Ничего не ждёт вашего решения')).toBeInTheDocument()
  })

  it('COPY-L-6: a row of an unknown kind degrades to «Запрос на действие» without taking the working rows down', async () => {
    routeGet({
      onboarding: () => Promise.resolve({ data: COMPLETE_STATUS }),
      pending: () =>
        Promise.resolve({
          data: {
            mine: [
              {
                kind: 'PROJECT_APPROVAL',
                approvalId: '00000000-0000-4000-8000-0000000000a1',
                subjectType: 'PROJECT',
                subjectId: '00000000-0000-4000-8000-0000000000b1',
                title: 'TechCorp AI',
                viewerSharePercent: null,
                seniorName: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                actions: ['open'],
                link: '/projects/00000000-0000-4000-8000-0000000000b1',
              },
              {
                kind: 'PAYOUT_TO_CONFIRM',
                subjectId: '00000000-0000-4000-8000-0000000000c1',
                title: 'Выплата 1200$ на подтверждение',
                createdAt: '2026-01-02T00:00:00.000Z',
                actions: ['approve', 'open'],
                link: '/finance/x',
              },
            ],
            proposedByMe: [],
          },
        }),
    })
    renderPage()

    // The working row is untouched…
    expect(await screen.findByText('TechCorp AI')).toBeInTheDocument()
    // …and the unknown one is a single honest row under «Другое», with no
    // buttons and none of its own payload showing through.
    expect(screen.getByText('Запрос на действие')).toBeInTheDocument()
    expect(screen.queryByText(/1200/)).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('pending-item-open-00000000-0000-4000-8000-0000000000c1'),
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('pending-error')).not.toBeInTheDocument()
  })

  it('ADMIN skips the gate entirely (no status round-trip) and still reaches the empty state', async () => {
    mockRole = 'ADMIN'
    routeGet({ onboarding: () => Promise.reject(new Error('never asked')) })
    renderPage()

    expect(await screen.findByTestId('pending-empty')).toBeInTheDocument()
    expect(mockGet).not.toHaveBeenCalledWith('/onboarding/status')
  })
})
