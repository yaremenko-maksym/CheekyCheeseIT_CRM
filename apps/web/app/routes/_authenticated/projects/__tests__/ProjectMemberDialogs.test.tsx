/**
 * Mikado leaf 10 — characterization of the remove-member confirm + add-member picker
 * dialogs extracted from `$projectId.tsx` into `ProjectMemberDialogs.tsx`. Expected values
 * are hand-written literals (labels, URLs, payloads), not derived from the code.
 */
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import type { ProjectMemberDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ProjectMemberDialogs, type UserForAdd } from '../ProjectMemberDialogs'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src }: { src: string }) => <img data-testid="avatar-img" src={src} alt="" />,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

import { api } from '@/lib/axios'

const TARGET = { userId: 'u9', displayName: 'Олег Джуніор' } as unknown as ProjectMemberDto

function candidate(over: Partial<UserForAdd> & { id: string }): UserForAdd {
  return {
    displayName: 'Anon',
    email: 'a@example.com',
    role: 'JUNIOR',
    avatarUrl: null,
    avatarDocumentId: null,
    hasActiveProject: false,
    ...over,
  }
}

const CANDIDATES: UserForAdd[] = [
  candidate({ id: 'c1', displayName: 'Іван Петренко', email: 'ivan@example.com', role: 'HR' }),
  candidate({
    id: 'c2',
    displayName: 'Марія Шевченко',
    email: 'maria@example.com',
    avatarUrl: 'https://img.example/m.png',
  }),
]

beforeEach(async () => {
  await loadCatalog('uk')
  vi.mocked(api.post).mockReset()
  vi.mocked(api.delete).mockReset()
})

interface Handlers {
  onCloseRemoveMember: Mock<() => void>
  onCloseAddMember: Mock<() => void>
  onMemberAdded: Mock<(id: string) => void>
  invalidate: MockInstance<QueryClient['invalidateQueries']>
}

function setup(props: Partial<React.ComponentProps<typeof ProjectMemberDialogs>> = {}): Handlers {
  const handlers: Handlers = {
    onCloseRemoveMember: vi.fn<() => void>(),
    onCloseAddMember: vi.fn<() => void>(),
    onMemberAdded: vi.fn<(id: string) => void>(),
    invalidate: undefined as unknown as Handlers['invalidate'],
  }
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  handlers.invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <ProjectMemberDialogs
        projectId="proj-1"
        removeMemberTarget={null}
        addMemberOpen={false}
        availableToAdd={CANDIDATES}
        addedMemberIds={new Set()}
        onCloseRemoveMember={handlers.onCloseRemoveMember}
        onCloseAddMember={handlers.onCloseAddMember}
        onMemberAdded={handlers.onMemberAdded}
        {...props}
      />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
  return handlers
}

describe('ProjectMemberDialogs — remove confirm', () => {
  it('renders nothing while both dialogs are closed', () => {
    setup()
    expect(screen.queryByText('Прибрати зі складу?')).toBeNull()
    expect(screen.queryByText('Додати до складу')).toBeNull()
  })

  it('opens for a target and shows its name', () => {
    setup({ removeMemberTarget: TARGET })
    expect(screen.getByText('Прибрати зі складу?')).toBeTruthy()
    expect(screen.getByText('Олег Джуніор')).toBeTruthy()
  })

  it('explains the consequence with the member name followed by a literal space', () => {
    setup({ removeMemberTarget: TARGET })
    const body = screen.getByText(
      (_, el) =>
        el?.tagName === 'P' && el.textContent === 'Олег Джуніор більше не буде у складі проєкту.',
    )
    expect(body).toBeTruthy()
  })

  it('confirm deletes the member by userId, refreshes project queries and closes on success', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    const { onCloseRemoveMember, invalidate } = setup({ removeMemberTarget: TARGET })
    await userEvent.click(screen.getByRole('button', { name: 'Прибрати' }))
    await waitFor(() => expect(onCloseRemoveMember).toHaveBeenCalledTimes(1))
    expect(api.delete).toHaveBeenCalledWith('/projects/proj-1/members/u9')
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'proj-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('dismissing the confirm dialog (Escape) calls onCloseRemoveMember once without deleting', async () => {
    const { onCloseRemoveMember, onCloseAddMember } = setup({ removeMemberTarget: TARGET })
    await userEvent.keyboard('{Escape}')
    expect(onCloseRemoveMember).toHaveBeenCalledTimes(1)
    expect(onCloseAddMember).not.toHaveBeenCalled()
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('cancel closes without calling the API', async () => {
    const { onCloseRemoveMember } = setup({ removeMemberTarget: TARGET })
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onCloseRemoveMember).toHaveBeenCalledTimes(1)
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('disables the destructive button while the delete is pending and keeps the dialog open', async () => {
    vi.mocked(api.delete).mockReturnValue(new Promise(() => {}))
    const { onCloseRemoveMember } = setup({ removeMemberTarget: TARGET })
    const confirm = screen.getByRole('button', { name: 'Прибрати' })
    await userEvent.click(confirm)
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(true))
    expect(onCloseRemoveMember).not.toHaveBeenCalled()
  })
})

describe('ProjectMemberDialogs — add picker', () => {
  it('shows the empty state when there is nobody to add', () => {
    setup({ addMemberOpen: true, availableToAdd: [] })
    expect(screen.getByText('Немає кого додати')).toBeTruthy()
  })

  it('lists every candidate with name, email and role label; avatar only when url is set', () => {
    setup({ addMemberOpen: true })
    expect(screen.queryByText('Немає кого додати')).toBeNull()
    expect(screen.getByText('Іван Петренко')).toBeTruthy()
    expect(screen.getByText('maria@example.com')).toBeTruthy()
    const imgs = screen.getAllByTestId('avatar-img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]?.getAttribute('src')).toBe('https://img.example/m.png')
    // the url itself is never rendered as text (guards `url || <img>`)
    expect(screen.queryByText('https://img.example/m.png')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Додати' })).toHaveLength(2)
  })

  it('colours the role badge by role, falling back to the junior variant for a role without one', () => {
    setup({
      addMemberOpen: true,
      availableToAdd: [
        candidate({ id: 'r1', displayName: 'Рита', role: 'HR' }),
        candidate({ id: 'r2', displayName: 'Дмитро', role: 'DROP' }),
      ],
    })
    const hr = screen.getByText('HR')
    expect(hr.className).toContain('text-purple-400')
    expect(hr.className).not.toContain('text-green-400')
    const drop = screen.getByText('Дроп')
    expect(drop.className).toContain('text-green-400')
    expect(drop.className).not.toContain('text-cyan-400')
  })

  it('styles a not-yet-added button as a primary action and an added one as an emerald outline', () => {
    setup({ addMemberOpen: true, addedMemberIds: new Set(['c1']) })
    const added = screen.getByRole('button', { name: 'Додано' })
    expect(added.className).toContain('text-emerald-500')
    expect(added.className).toContain('border-emerald-500/40')
    expect(added.className).toContain('bg-transparent')
    expect(added.className).toContain('h-7')
    const todo = screen.getByRole('button', { name: 'Додати' })
    expect(todo.className).not.toContain('text-emerald-500')
    expect(todo.className).toContain('bg-primary')
    expect(todo.className).toContain('h-7')
  })

  it('shows «Додано» and disables the button for already-added ids', () => {
    setup({ addMemberOpen: true, addedMemberIds: new Set(['c1']) })
    const added = screen.getByRole('button', { name: 'Додано' })
    expect(added.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Додати' }).hasAttribute('disabled')).toBe(false)
  })

  it('click posts the userId, shows pending, then reports the add to the page', async () => {
    let resolve: (v: unknown) => void = () => {}
    vi.mocked(api.post).mockReturnValue(new Promise((r) => (resolve = r)))
    const { onMemberAdded, invalidate } = setup({ addMemberOpen: true })
    const [first] = screen.getAllByRole('button', { name: 'Додати' })
    await userEvent.click(first!)
    const pending = await screen.findByRole('button', { name: 'Додаємо…' })
    expect(pending.hasAttribute('disabled')).toBe(true)
    expect(api.post).toHaveBeenCalledWith('/projects/proj-1/members', { userId: 'c1' })
    resolve({ data: {} })
    await waitFor(() => expect(onMemberAdded).toHaveBeenCalledWith('c1'))
    expect(invalidate).toHaveBeenCalledTimes(3)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'proj-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Додаємо…' })).toBeNull())
  })

  it('clears the pending state when the add fails and does not report an add', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('boom'))
    const { onMemberAdded } = setup({ addMemberOpen: true })
    const [first] = screen.getAllByRole('button', { name: 'Додати' })
    await userEvent.click(first!)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Додати' })).toHaveLength(2))
    expect(onMemberAdded).not.toHaveBeenCalled()
  })

  it('closing the picker via Escape calls onCloseAddMember', async () => {
    const { onCloseAddMember } = setup({ addMemberOpen: true })
    await userEvent.keyboard('{Escape}')
    expect(onCloseAddMember).toHaveBeenCalledTimes(1)
  })

  it('uses stateful parent wiring: added id flips the button to «Додано»', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    function Harness(): React.ReactElement {
      const [added, setAdded] = useState<Set<string>>(new Set())
      return (
        <ProjectMemberDialogs
          projectId="proj-1"
          removeMemberTarget={null}
          onCloseRemoveMember={() => {}}
          addMemberOpen
          onCloseAddMember={() => {}}
          availableToAdd={CANDIDATES}
          addedMemberIds={added}
          onMemberAdded={(id) => setAdded((p) => new Set(p).add(id))}
        />
      )
    }
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
      { wrapper: I18nTestProvider },
    )
    const [first] = screen.getAllByRole('button', { name: 'Додати' })
    await userEvent.click(first!)
    expect(await screen.findByRole('button', { name: 'Додано' })).toBeTruthy()
  })
})
