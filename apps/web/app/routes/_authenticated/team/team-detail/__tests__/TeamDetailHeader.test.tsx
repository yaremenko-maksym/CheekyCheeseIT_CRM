import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role, TeamDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...rest
    }: { children?: ReactNode; to?: string } & Record<string, unknown>) => (
      <a href={to ?? '#'} {...rest}>
        {children}
      </a>
    ),
  }
})

vi.mock('@/components/users/ProfileNameLink', () => ({
  ProfileNameLink: ({
    userId,
    viewerRole,
    children,
  }: {
    userId: string
    viewerRole: string
    children?: ReactNode
  }) => (
    <span data-testid="profile-link" data-user={userId} data-viewer={viewerRole}>
      {children}
    </span>
  ),
}))

vi.mock('../components/TeamUnarchiveHeaderButton', () => ({
  TeamUnarchiveHeaderButton: ({ teamId }: { teamId: string }) => (
    <button data-testid="unarchive-stub" data-team={teamId} />
  ),
}))

const formatDateSpy = vi.hoisted(() => vi.fn())
vi.mock('@crm/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@crm/shared')>()
  return {
    ...actual,
    formatDate: (...args: Parameters<typeof actual.formatDate>) => {
      formatDateSpy(...args)
      return actual.formatDate(...args)
    },
  }
})

import { TeamDetailHeader } from '../components/TeamDetailHeader'

type Member = TeamDto['members'][number]

function member(userId: string, role: string, displayName: string): Member {
  return { id: `m-${userId}`, userId, role, displayName } as unknown as Member
}

function makeTeam(extra: Record<string, unknown> = {}): TeamDto {
  return {
    id: 't1',
    name: 'Alpha Team',
    createdAt: '2026-03-05T10:00:00.000Z',
    archivedAt: null,
    telegram: null,
    ...extra,
  } as unknown as TeamDto
}

interface Opts {
  team?: TeamDto
  viewerRole?: Role | undefined
  isDropTeam?: boolean
  dropOwner?: Member | null
  activeSenior?: Member | null
  canManage?: boolean | undefined
  canRotateSenior?: boolean
}

function renderHeader(opts: Opts = {}) {
  const cb = {
    onRotateSenior: vi.fn(),
    onAddMember: vi.fn(),
    onEdit: vi.fn(),
    onArchive: vi.fn(),
  }
  render(
    <I18nTestProvider>
      <TeamDetailHeader
        team={opts.team ?? makeTeam()}
        viewerRole={'viewerRole' in opts ? opts.viewerRole : 'ADMIN'}
        isDropTeam={opts.isDropTeam ?? false}
        dropOwner={opts.dropOwner ?? null}
        activeSenior={opts.activeSenior ?? null}
        canManage={'canManage' in opts ? opts.canManage : true}
        canRotateSenior={opts.canRotateSenior ?? false}
        {...cb}
      />
    </I18nTestProvider>,
  )
  return cb
}

const q = (id: string) => screen.queryByTestId(id)

beforeEach(async () => {
  await loadCatalog('uk')
  formatDateSpy.mockClear()
})

describe('TeamDetailHeader action gates', () => {
  it('canManage on an active team shows add-member + edit and fires their callbacks', () => {
    const cb = renderHeader({ canManage: true, viewerRole: 'HR' })
    expect(screen.getByTestId('team-add-member-button').textContent).toBe('Додати учасника')
    expect(screen.getByTestId('team-edit-button').textContent).toBe('Редагувати')
    fireEvent.click(screen.getByTestId('team-add-member-button'))
    expect(cb.onAddMember).toHaveBeenCalledTimes(1)
    expect(cb.onEdit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('team-edit-button'))
    expect(cb.onEdit).toHaveBeenCalledTimes(1)
    expect(cb.onAddMember).toHaveBeenCalledTimes(1)
  })

  it('canManage false hides add-member and edit', () => {
    renderHeader({ canManage: false, viewerRole: 'HR' })
    expect(q('team-add-member-button')).toBeNull()
    expect(q('team-edit-button')).toBeNull()
  })

  it('canManage undefined hides add-member and edit', () => {
    renderHeader({ canManage: undefined, viewerRole: 'HR' })
    expect(q('team-add-member-button')).toBeNull()
    expect(q('team-edit-button')).toBeNull()
  })

  it('canManage on an archived team hides add-member and edit', () => {
    renderHeader({
      canManage: true,
      viewerRole: 'HR',
      team: makeTeam({ archivedAt: '2026-04-01T00:00:00.000Z' }),
    })
    expect(q('team-add-member-button')).toBeNull()
    expect(q('team-edit-button')).toBeNull()
  })

  it('canRotateSenior shows the rotate button and fires onRotateSenior', () => {
    const cb = renderHeader({ canRotateSenior: true, isDropTeam: true })
    fireEvent.click(screen.getByTestId('team-rotate-senior-button'))
    expect(cb.onRotateSenior).toHaveBeenCalledTimes(1)
  })

  it('canRotateSenior false hides the rotate button even for ADMIN canManage drop team', () => {
    renderHeader({ canRotateSenior: false, isDropTeam: true, canManage: true })
    expect(q('team-rotate-senior-button')).toBeNull()
  })

  it('rotate button label: "Призначити сеньйора" without a senior, "Змінити сеньйора" with one', () => {
    renderHeader({ canRotateSenior: true, isDropTeam: true, activeSenior: null })
    expect(screen.getByTestId('team-rotate-senior-button').textContent).toBe('Призначити сеньйора')
  })

  it('rotate button label switches to "Змінити сеньйора" when a senior is active', () => {
    renderHeader({
      canRotateSenior: true,
      isDropTeam: true,
      activeSenior: member('s1', 'SENIOR', 'Sen One'),
    })
    expect(screen.getByTestId('team-rotate-senior-button').textContent).toBe('Змінити сеньйора')
  })

  it('ADMIN on an active team sees archive and it fires onArchive; no unarchive', () => {
    const cb = renderHeader({ viewerRole: 'ADMIN' })
    fireEvent.click(screen.getByTestId('team-archive-button'))
    expect(cb.onArchive).toHaveBeenCalledTimes(1)
    expect(q('unarchive-stub')).toBeNull()
  })

  it.each<Role | undefined>(['HR', 'SENIOR', 'JUNIOR', 'ACCOUNTANT', 'DROP', undefined])(
    'viewer %s never sees archive or unarchive, even with canManage',
    (viewerRole) => {
      renderHeader({ viewerRole, canManage: true })
      expect(q('team-archive-button')).toBeNull()
      expect(q('unarchive-stub')).toBeNull()
    },
  )

  it.each<Role | undefined>(['HR', 'SENIOR', undefined])(
    'viewer %s never sees unarchive on an archived team',
    (viewerRole) => {
      renderHeader({
        viewerRole,
        team: makeTeam({ archivedAt: '2026-04-01T00:00:00.000Z' }),
      })
      expect(q('unarchive-stub')).toBeNull()
      expect(q('team-archive-button')).toBeNull()
    },
  )

  it('ADMIN on an archived team sees unarchive bound to the team, not archive', () => {
    renderHeader({
      viewerRole: 'ADMIN',
      team: makeTeam({ archivedAt: '2026-04-01T00:00:00.000Z' }),
    })
    expect(screen.getByTestId('unarchive-stub').getAttribute('data-team')).toBe('t1')
    expect(q('team-archive-button')).toBeNull()
  })
})

describe('TeamDetailHeader back button', () => {
  it.each<Role>(['ADMIN', 'HR', 'ACCOUNTANT'])('is shown for %s and links to /team', (role) => {
    renderHeader({ viewerRole: role })
    expect(screen.getByTestId('back-button').getAttribute('href')).toBe('/team')
  })

  it.each<Role>(['SENIOR', 'JUNIOR', 'DROP'])('is hidden for %s', (role) => {
    renderHeader({ viewerRole: role })
    expect(q('back-button')).toBeNull()
  })

  it('is shown when the viewer role is unknown', () => {
    renderHeader({ viewerRole: undefined })
    expect(q('back-button')).not.toBeNull()
  })
})

describe('TeamDetailHeader title, badges, meta', () => {
  it('renders the team name, active badge and no drop/archived badge for a regular team', () => {
    renderHeader()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Alpha Team')
    expect(screen.getByText('Активна')).toBeTruthy()
    expect(q('team-drop-badge')).toBeNull()
    expect(q('team-archived-badge')).toBeNull()
  })

  it('shows the archived badge instead of the active badge for an archived team', () => {
    renderHeader({ team: makeTeam({ archivedAt: '2026-04-01T00:00:00.000Z' }) })
    expect(q('team-archived-badge')!.textContent).toBe('В архіві')
    expect(screen.queryByText('Активна')).toBeNull()
  })

  it('shows the drop badge only for a drop team', () => {
    renderHeader({ isDropTeam: true })
    expect(q('team-drop-badge')!.textContent).toBe('Команда дропа')
  })

  it('formats the creation date with the page locale in long form', () => {
    renderHeader()
    expect(formatDateSpy).toHaveBeenCalledWith('2026-03-05T10:00:00.000Z', 'uk', 'long')
    expect(screen.getByText(/^Створено /)).toBeTruthy()
  })
})

describe('TeamDetailHeader drop owner / senior line', () => {
  const owner = member('d1', 'DROP', 'Drop Owner')
  const senior = member('s1', 'SENIOR', 'Sen One')

  it('renders nothing for a non-drop team even if a drop owner is passed', () => {
    renderHeader({ isDropTeam: false, dropOwner: owner })
    expect(screen.queryByText('Drop Owner')).toBeNull()
    expect(screen.queryByText(/^Дроп:/)).toBeNull()
  })

  it('renders nothing for a drop team without a drop owner', () => {
    renderHeader({ isDropTeam: true, dropOwner: null, activeSenior: senior })
    expect(screen.queryByText(/^Дроп:/)).toBeNull()
    expect(screen.queryByText('Sen One')).toBeNull()
  })

  it('shows the drop owner and active senior links with the viewer role', () => {
    renderHeader({ isDropTeam: true, dropOwner: owner, activeSenior: senior, viewerRole: 'HR' })
    expect(screen.getByText(/^Дроп:/).textContent).toBe('Дроп: Drop Owner · Сеньйор: Sen One')
    const links = screen.getAllByTestId('profile-link')
    expect(links.map((l) => l.getAttribute('data-user'))).toEqual(['d1', 's1'])
    expect(links.map((l) => l.getAttribute('data-viewer'))).toEqual(['HR', 'HR'])
    expect(links.map((l) => l.textContent)).toEqual(['Drop Owner', 'Sen One'])
    expect(screen.queryByText('· Сеньйора не призначено')).toBeNull()
  })

  it('shows the "no senior" caption when the drop team has no active senior', () => {
    renderHeader({ isDropTeam: true, dropOwner: owner, activeSenior: null })
    expect(screen.getAllByTestId('profile-link')).toHaveLength(1)
    expect(screen.getByText('· Сеньйора не призначено')).toBeTruthy()
  })

  it('falls back to JUNIOR as the link viewer role when the viewer is unknown', () => {
    renderHeader({
      isDropTeam: true,
      dropOwner: owner,
      activeSenior: senior,
      viewerRole: undefined,
    })
    const links = screen.getAllByTestId('profile-link')
    expect(links.map((l) => l.getAttribute('data-viewer'))).toEqual(['JUNIOR', 'JUNIOR'])
  })
})

describe('TeamDetailHeader telegram link', () => {
  it('shows a safe external link for non-JUNIOR viewers', () => {
    renderHeader({ team: makeTeam({ telegram: '@alpha' }), viewerRole: 'HR' })
    const a = q('team-telegram-link') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('https://t.me/alpha')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.textContent).toBe('Telegram-чат')
  })

  it('is hidden from a JUNIOR viewer', () => {
    renderHeader({ team: makeTeam({ telegram: '@alpha' }), viewerRole: 'JUNIOR' })
    expect(q('team-telegram-link')).toBeNull()
  })

  it('is hidden when the team has no telegram', () => {
    renderHeader({ team: makeTeam({ telegram: null }), viewerRole: 'HR' })
    expect(q('team-telegram-link')).toBeNull()
  })
})
