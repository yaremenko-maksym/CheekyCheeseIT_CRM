import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { kyivToday, type UserProfileDto } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: getMock } }))

import { useUserDialogData } from '../useUserDialogData'

type Args = Parameters<typeof useUserDialogData>[0]

const user = (over: Record<string, unknown>) =>
  ({ id: 'u', role: 'SENIOR', archivedAt: null, ...over }) as unknown as UserProfileDto

const member = (over: Record<string, unknown>) => ({
  userId: 'x',
  role: 'SENIOR',
  leftAt: null,
  ...over,
})
const team = (id: string, over: Record<string, unknown>) => ({
  id,
  type: 'DROP',
  archivedAt: null,
  members: [],
  ...over,
})
const project = (id: string, over: Record<string, unknown>) => ({
  id,
  archivedAt: null,
  members: [],
  ...over,
})

function setup(data: Record<string, unknown>) {
  getMock.mockImplementation((url: string) => {
    if (url in data) return Promise.resolve({ data: data[url] })
    return new Promise(() => {}) // never resolves: query stays pending
  })
}

function render(args: Args) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return { client, ...renderHook(() => useUserDialogData(args), { wrapper }) }
}

const base: Args = { open: true, isCreate: true, isEdit: false, editingUser: null }

describe('useUserDialogData', () => {
  beforeEach(() => {
    getMock.mockReset()
  })

  describe('vacantDropTeams (mirrors backend addSeniorToDropTeam)', () => {
    it('keeps only non-archived DROP teams without an active senior', async () => {
      setup({
        '/teams': [
          team('vacant', {}),
          team('vacant-with-hr', { members: [member({ role: 'HR' })] }),
          team('vacant-ex-senior', { members: [member({ role: 'SENIOR', leftAt: '2026-01-01' })] }),
          team('archived', { archivedAt: '2026-01-01' }),
          team('has-senior', { members: [member({ role: 'SENIOR' })] }),
          team('non-drop', { type: 'REGULAR' }),
        ],
      })
      const { result } = render(base)
      await waitFor(() =>
        expect(result.current.vacantDropTeams.map((t) => t.id)).toEqual([
          'vacant',
          'vacant-with-hr',
          'vacant-ex-senior',
        ]),
      )
    })

    it('is empty before the teams load', () => {
      setup({})
      const { result } = render(base)
      expect(result.current.vacantDropTeams).toEqual([])
    })
  })

  describe('juniors / projects', () => {
    const projects = [
      project('free', {}),
      project('has-junior', { members: [member({ userId: 'j1', role: 'JUNIOR' })] }),
      project('ex-junior', { members: [member({ userId: 'j1', role: 'JUNIOR', leftAt: 'd' })] }),
      project('archived-free', { archivedAt: '2026-01-01' }),
      project('has-senior-only', { members: [member({ userId: 's1', role: 'SENIOR' })] }),
    ]

    it('availableJuniorProjects excludes archived and projects with an active JUNIOR', async () => {
      setup({ '/projects': projects })
      const { result } = render(base)
      await waitFor(() =>
        expect(result.current.availableJuniorProjects.map((p) => p.id)).toEqual([
          'free',
          'ex-junior',
          'has-senior-only',
        ]),
      )
    })

    it('juniorActiveProjects lists projects where the editing JUNIOR is an active member', async () => {
      setup({ '/projects': projects })
      const { result } = render({
        open: true,
        isCreate: false,
        isEdit: true,
        editingUser: user({ id: 'j1', role: 'JUNIOR' }),
      })
      await waitFor(() =>
        expect(result.current.juniorActiveProjects.map((p) => p.id)).toEqual(['has-junior']),
      )
    })

    it('juniorActiveProjects is empty for a non-JUNIOR editing user or no user', async () => {
      setup({ '/projects': projects })
      const senior = render({
        open: true,
        isCreate: false,
        isEdit: true,
        editingUser: user({ id: 'j1', role: 'SENIOR' }),
      })
      const none = render(base)
      await waitFor(() => expect(senior.result.current.projects).toBeDefined())
      await waitFor(() => expect(none.result.current.projects).toBeDefined())
      expect(senior.result.current.juniorActiveProjects).toEqual([])
      expect(none.result.current.juniorActiveProjects).toEqual([])
    })
  })

  describe('hrUsers / accountantUsers', () => {
    it('keeps only non-archived HR / ACCOUNTANT users respectively', async () => {
      setup({
        '/users': [
          user({ id: 'hr', role: 'HR' }),
          user({ id: 'hr-arch', role: 'HR', archivedAt: '2026-01-01' }),
          user({ id: 'acc', role: 'ACCOUNTANT' }),
          user({ id: 'acc-arch', role: 'ACCOUNTANT', archivedAt: '2026-01-01' }),
          user({ id: 'sr', role: 'SENIOR' }),
        ],
      })
      const { result } = render(base)
      await waitFor(() => expect(result.current.hrUsers.map((u) => u.id)).toEqual(['hr']))
      expect(result.current.accountantUsers.map((u) => u.id)).toEqual(['acc'])
    })
  })

  describe('enabled gating', () => {
    const urls = () => getMock.mock.calls.map((c) => c[0] as string)

    it('fires no request while the dialog is closed', () => {
      setup({})
      render({ ...base, open: false })
      expect(getMock).not.toHaveBeenCalled()
    })

    it('create mode (open): users, projects, rates, drop teams — not the edit-senior teams query', () => {
      setup({})
      render(base)
      expect(urls().sort()).toEqual(
        ['/finance/exchange-rate', '/projects', '/teams', '/users'].sort(),
      )
      expect(urls().filter((u) => u === '/teams')).toHaveLength(1)
    })

    it('edit SENIOR: also fetches /teams (allTeams), but drop-teams query stays off', () => {
      setup({})
      render({
        open: true,
        isCreate: false,
        isEdit: true,
        editingUser: user({ role: 'SENIOR' }),
      })
      expect(urls().filter((u) => u === '/teams')).toHaveLength(1)
      expect(urls()).toEqual(
        expect.arrayContaining(['/users', '/projects', '/finance/exchange-rate']),
      )
    })

    it('edit non-SENIOR: no /teams request at all', () => {
      setup({})
      render({
        open: true,
        isCreate: false,
        isEdit: true,
        editingUser: user({ role: 'JUNIOR' }),
      })
      expect(urls()).not.toContain('/teams')
    })

    it('edit without a resolved editing user: no /teams request', () => {
      setup({})
      render({ open: true, isCreate: false, isEdit: true, editingUser: null })
      expect(urls()).not.toContain('/teams')
    })
  })

  it('exposes the exchange-rate payload unchanged', async () => {
    const rates = { usdUah: '41', usdtUah: '41.2', eurUah: '45', date: '2026-10-06' }
    setup({ '/finance/exchange-rate': rates })
    const { result } = render(base)
    await waitFor(() => expect(result.current.exchangeRates).toEqual(rates))
  })

  describe('query cache contract (keys shared with other consumers, staleness)', () => {
    const staleTimeOf = (client: QueryClient, queryKey: unknown[]) =>
      client.getQueryCache().find({ queryKey })?.observers[0]?.options.staleTime

    it('create mode: stores each payload under its documented key', async () => {
      const users = [user({ id: 'hr', role: 'HR' })]
      const projects = [project('p1', {})]
      const rates = { usdUah: '41', usdtUah: '41.2', eurUah: '45', date: '2026-10-06' }
      const teams = [team('t1', {})]
      setup({
        '/users': users,
        '/projects': projects,
        '/finance/exchange-rate': rates,
        '/teams': teams,
      })
      const { result, client } = render(base)
      await waitFor(() => expect(result.current.dropTeamsForJoin).toEqual(teams))
      await waitFor(() => expect(result.current.allUsers).toEqual(users))
      await waitFor(() => expect(result.current.projects).toEqual(projects))
      await waitFor(() => expect(result.current.exchangeRates).toEqual(rates))
      expect(client.getQueryData(['users-admin'])).toEqual(users)
      expect(client.getQueryData(['projects'])).toEqual(projects)
      expect(client.getQueryData(['exchange-rate', kyivToday()])).toEqual(rates)
      expect(client.getQueryData(['teams', { type: 'DROP', vacant: true }])).toEqual(teams)
      // the bare ['teams'] key belongs to the edit-SENIOR query and is not populated here
      expect(client.getQueryData(['teams'])).toBeUndefined()
    })

    it('staleness: rates cached for 24h, drop teams for 30s', () => {
      setup({})
      const { client } = render(base)
      expect(staleTimeOf(client, ['exchange-rate', kyivToday()])).toBe(86_400_000)
      expect(staleTimeOf(client, ['teams', { type: 'DROP', vacant: true }])).toBe(30_000)
    })

    it('edit SENIOR: allTeams is the /teams payload under the bare [teams] key', async () => {
      const teams = [team('t1', {})]
      setup({ '/teams': teams })
      const { result, client } = render({
        open: true,
        isCreate: false,
        isEdit: true,
        editingUser: user({ role: 'SENIOR' }),
      })
      await waitFor(() => expect(result.current.allTeams).toEqual(teams))
      expect(client.getQueryData(['teams'])).toEqual(teams)
      expect(result.current.dropTeamsForJoin).toBeUndefined()
    })

    it('derived collections are empty arrays (not undefined) before data loads', () => {
      setup({})
      const { result } = render(base)
      expect(result.current.hrUsers).toEqual([])
      expect(result.current.accountantUsers).toEqual([])
      expect(result.current.availableJuniorProjects).toEqual([])
      expect(result.current.juniorActiveProjects).toEqual([])
    })
  })
})
