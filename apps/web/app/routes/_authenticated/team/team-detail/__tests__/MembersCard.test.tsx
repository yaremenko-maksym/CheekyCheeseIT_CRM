/* Node access: member rows and anchors have no role/label of their own; reached from their text. */
/* eslint-disable testing-library/no-node-access */
import type { ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role, TeamDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

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

// Radix AvatarImage renders nothing until the image loads (never in jsdom).
vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AvatarImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="avatar-image" src={src} alt={alt} />
  ),
  AvatarFallback: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

import { MembersCard } from '../components/MembersCard'

type Member = TeamDto['members'][number]

function member(userId: string, role: string, extra: Record<string, unknown> = {}): Member {
  return {
    id: `m-${userId}`,
    userId,
    role,
    displayName: `Name ${userId}`,
    email: `${userId}@test.dev`,
    avatarUrl: null,
    telegram: null,
    phone: null,
    techStack: null,
    ...extra,
  } as unknown as Member
}

function renderCard(
  members: Member[],
  opts: {
    viewerRole?: Role | undefined
    viewerId?: string | undefined
    canManage?: boolean | undefined
    onRemove?: () => void
  } = {},
) {
  const onRemove = opts.onRemove ?? vi.fn()
  render(
    <I18nTestProvider>
      <MembersCard
        members={members}
        viewerRole={'viewerRole' in opts ? opts.viewerRole : 'ADMIN'}
        viewerId={'viewerId' in opts ? opts.viewerId : 'admin1'}
        canManage={'canManage' in opts ? opts.canManage : true}
        onRemove={onRemove}
      />
    </I18nTestProvider>,
  )
  return onRemove
}

/** Whether the row of `userId` shows a remove button. */
function hasRemove(userId: string): boolean {
  const row = screen.getByText(`Name ${userId}`).closest('div.rounded-lg') as HTMLElement
  return within(row).queryByTitle('Виключити') !== null
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('MembersCard rendering', () => {
  it('renders title, total count and one row per visible member with contacts', () => {
    renderCard([
      member('s1', 'SENIOR', {
        telegram: '@senior_tg',
        phone: '+380501112233',
        techStack: ['React', 'Node'],
        avatarUrl: 'https://img.test/s1.png',
      }),
      member('h1', 'HR'),
    ])
    expect(screen.getByText('Учасники команди')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('Name s1')).toBeTruthy()
    expect(screen.getByText('Name h1')).toBeTruthy()
    expect(screen.getByText('s1@test.dev').closest('a')!.getAttribute('href')).toBe(
      'mailto:s1@test.dev',
    )
    const tg = screen.getByText('@senior_tg').closest('a')!
    expect(tg.getAttribute('href')).toBe('https://t.me/senior_tg')
    expect(tg.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('+380501112233').closest('a')!.getAttribute('href')).toBe(
      'tel:+380501112233',
    )
    expect(screen.getByText('React')).toBeTruthy()
    expect(screen.getByText('Node')).toBeTruthy()
    expect(screen.getByTestId('avatar-image').getAttribute('src')).toBe('https://img.test/s1.png')
    expect(screen.queryByText('Немає учасників')).toBeNull()
  })

  it('omits optional contacts, tech stack and avatar when absent', () => {
    renderCard([member('h1', 'HR', { phone: '+380' })])
    expect(screen.queryByTestId('avatar-image')).toBeNull()
    expect(document.querySelector('a[href^="tel:"]')).toBeNull()
    expect(document.querySelector('a[href^="https://t.me"]')).toBeNull()
    expect(document.querySelectorAll('a')).toHaveLength(1)
  })

  it('omits the tech stack block for an empty array', () => {
    renderCard([member('h1', 'HR', { techStack: [] })])
    expect(document.querySelector('.font-mono')).toBeNull()
  })

  it('passes the viewer role to profile links', () => {
    renderCard([member('h1', 'HR')], { viewerRole: 'ACCOUNTANT' })
    for (const link of screen.getAllByTestId('profile-link')) {
      expect(link.getAttribute('data-viewer')).toBe('ACCOUNTANT')
    }
  })

  it('falls back to JUNIOR viewer for profile links when the viewer role is undefined', () => {
    renderCard([member('h1', 'HR')], { viewerRole: undefined })
    for (const link of screen.getAllByTestId('profile-link')) {
      expect(link.getAttribute('data-viewer')).toBe('JUNIOR')
    }
  })
})

describe('MembersCard visibleMembers filter (RBAC)', () => {
  const roster = () => [member('s1', 'SENIOR'), member('j1', 'JUNIOR'), member('h1', 'HR')]

  it.each(['JUNIOR', 'SENIOR'] as const)('%s viewer does not see JUNIOR members', (role) => {
    renderCard(roster(), { viewerRole: role, canManage: false })
    expect(screen.queryByText('Name j1')).toBeNull()
    expect(screen.getByText('Name s1')).toBeTruthy()
    expect(screen.getByText('Name h1')).toBeTruthy()
    // header count stays the total (filter is display-only)
    expect(screen.getByText('3')).toBeTruthy()
  })

  it.each(['ADMIN', 'HR', 'ACCOUNTANT', 'DROP', undefined] as const)(
    '%s viewer sees every member including JUNIORs',
    (role) => {
      renderCard(roster(), { viewerRole: role, canManage: false })
      expect(screen.getByText('Name j1')).toBeTruthy()
      expect(screen.getByText('Name s1')).toBeTruthy()
      expect(screen.getByText('Name h1')).toBeTruthy()
    },
  )

  it('shows the empty state when nothing is visible', () => {
    renderCard([member('j1', 'JUNIOR')], { viewerRole: 'SENIOR', canManage: false })
    expect(screen.getByText('Немає учасників')).toBeTruthy()
    expect(screen.queryByText('Name j1')).toBeNull()
  })

  it('shows the empty state for an empty roster', () => {
    renderCard([], { viewerRole: 'ADMIN' })
    expect(screen.getByText('Немає учасників')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
  })
})

describe('MembersCard removal matrix (canRemove)', () => {
  it('shows no remove button at all when canManage is false', () => {
    renderCard([member('h1', 'HR'), member('h2', 'HR')], { canManage: false })
    expect(screen.queryByTitle('Виключити')).toBeNull()
  })

  it('shows no remove button when canManage is undefined', () => {
    renderCard([member('h1', 'HR'), member('h2', 'HR')], { canManage: undefined })
    expect(screen.queryByTitle('Виключити')).toBeNull()
  })

  describe('ADMIN viewer', () => {
    it('can remove ADMIN/DROP/ACCOUNTANT/HR members when not last', () => {
      renderCard([
        member('a2', 'ADMIN'),
        member('d1', 'DROP'),
        member('h1', 'HR'),
        member('h2', 'HR'),
        member('c1', 'ACCOUNTANT'),
        member('c2', 'ACCOUNTANT'),
      ])
      for (const id of ['a2', 'd1', 'h1', 'h2', 'c1', 'c2']) expect(hasRemove(id)).toBe(true)
    })

    it('can never remove SENIOR or JUNIOR members', () => {
      renderCard([member('s1', 'SENIOR'), member('j1', 'JUNIOR'), member('d1', 'DROP')])
      expect(hasRemove('s1')).toBe(false)
      expect(hasRemove('j1')).toBe(false)
      expect(hasRemove('d1')).toBe(true)
    })

    it('cannot remove the last HR (exactly one)', () => {
      renderCard([member('h1', 'HR'), member('d1', 'DROP')])
      expect(hasRemove('h1')).toBe(false)
      expect(hasRemove('d1')).toBe(true)
    })

    it('cannot remove the last ACCOUNTANT (exactly one)', () => {
      renderCard([member('c1', 'ACCOUNTANT'), member('d1', 'DROP')])
      expect(hasRemove('c1')).toBe(false)
      expect(hasRemove('d1')).toBe(true)
    })

    it('last-HR and last-ACCOUNTANT checks are independent of each other', () => {
      renderCard([member('h1', 'HR'), member('c1', 'ACCOUNTANT'), member('c2', 'ACCOUNTANT')])
      expect(hasRemove('h1')).toBe(false)
      expect(hasRemove('c1')).toBe(true)
      expect(hasRemove('c2')).toBe(true)
    })

    it('last-ACCOUNTANT does not block HR removal when HRs are plural', () => {
      renderCard([member('h1', 'HR'), member('h2', 'HR'), member('c1', 'ACCOUNTANT')])
      expect(hasRemove('h1')).toBe(true)
      expect(hasRemove('h2')).toBe(true)
      expect(hasRemove('c1')).toBe(false)
    })
  })

  describe('non-ADMIN manager viewer', () => {
    it('can remove only themselves, not other members', () => {
      renderCard([member('h1', 'HR'), member('h2', 'HR'), member('d1', 'DROP')], {
        viewerRole: 'HR',
        viewerId: 'h1',
      })
      expect(hasRemove('h1')).toBe(true)
      expect(hasRemove('h2')).toBe(false)
      expect(hasRemove('d1')).toBe(false)
    })

    it('cannot remove themselves as the last HR', () => {
      renderCard([member('h1', 'HR'), member('d1', 'DROP')], {
        viewerRole: 'HR',
        viewerId: 'h1',
      })
      expect(hasRemove('h1')).toBe(false)
      expect(hasRemove('d1')).toBe(false)
    })

    it('cannot remove a SENIOR even when it is themselves', () => {
      renderCard([member('s1', 'SENIOR'), member('h1', 'HR')], {
        viewerRole: 'HR',
        viewerId: 's1',
      })
      expect(hasRemove('s1')).toBe(false)
    })

    it('cannot remove a JUNIOR even when it is themselves', () => {
      renderCard([member('x1', 'JUNIOR'), member('x2', 'HR')], {
        viewerRole: 'HR',
        viewerId: 'x1',
      })
      expect(hasRemove('x1')).toBe(false)
    })

    it('an ACCOUNTANT can leave only when not the last accountant', () => {
      renderCard([member('c1', 'ACCOUNTANT'), member('c2', 'ACCOUNTANT')], {
        viewerRole: 'ACCOUNTANT',
        viewerId: 'c1',
      })
      expect(hasRemove('c1')).toBe(true)
      expect(hasRemove('c2')).toBe(false)
    })

    it('the last ACCOUNTANT cannot remove themselves', () => {
      renderCard([member('c1', 'ACCOUNTANT'), member('h1', 'HR')], {
        viewerRole: 'ACCOUNTANT',
        viewerId: 'c1',
      })
      expect(hasRemove('c1')).toBe(false)
    })

    it('an undefined viewer id never matches a member as self', () => {
      renderCard([member('h1', 'HR'), member('h2', 'HR')], {
        viewerRole: 'HR',
        viewerId: undefined,
      })
      expect(screen.queryByTitle('Виключити')).toBeNull()
    })
  })

  it('forwards only the member userId to onRemove on click', () => {
    const onRemove = vi.fn()
    renderCard([member('d1', 'DROP'), member('d2', 'DROP')], { onRemove })
    const row = screen.getByText('Name d2').closest('div.rounded-lg') as HTMLElement
    fireEvent.click(within(row).getByTitle('Виключити'))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('d2')
  })
})
