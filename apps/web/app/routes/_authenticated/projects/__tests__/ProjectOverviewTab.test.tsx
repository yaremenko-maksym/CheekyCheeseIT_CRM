/**
 * Mikado leaf 12 — characterization of the overview tab extracted from `$projectId.tsx` into
 * `ProjectOverviewTab.tsx`. Expected values are hand-written literals (uk labels, dash counts,
 * testids), not derived from the component. Every gate (viewer role, RBAC flag, member list,
 * archived state) is asserted on BOTH branches.
 */
/* Node access: the InfoRow wrapper (no role/label of its own) is reached from its label text. */
/* eslint-disable testing-library/no-node-access */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDetailDto, ProjectMemberDto, Role } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectOverviewTab, type ProjectOverviewTabProps } from '../ProjectOverviewTab'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    children,
    className,
  }: {
    params: { userId: string }
    children: ReactNode
    className?: string
  }) => (
    <a href={`/profile/${params.userId}`} className={className} data-testid="profile-link">
      {children}
    </a>
  ),
}))
// Radix <AvatarImage> only mounts its <img> after a successful load, which jsdom never performs.
vi.mock('@/components/ui/avatar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/avatar')>()),
  AvatarImage: ({ src, alt }: { src: string; alt: string }) => (
    <img data-testid="avatar-img" src={src} alt={alt} />
  ),
}))
vi.mock('@/components/projects/ProjectLegendSection', () => ({
  ProjectLegendSection: ({ projectId, canAccess }: { projectId: string; canAccess: boolean }) => (
    <div
      data-testid="legend-section"
      data-project-id={projectId}
      data-can-access={`${canAccess}`}
    />
  ),
}))
vi.mock('@/components/projects/ProjectCredentialsSection', () => ({
  ProjectCredentialsSection: ({ projectId, canEdit }: { projectId: string; canEdit: boolean }) => (
    <div
      data-testid="credentials-section"
      data-project-id={projectId}
      data-can-edit={`${canEdit}`}
    />
  ),
}))
// The share widgets have their own suites; here only the tab's wiring of them is under test.
vi.mock('../ProjectInfoRows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ProjectInfoRows')>()),
  ProjectShareInfo: ({
    canCancelPendingShare,
    viewerId,
  }: {
    canCancelPendingShare: boolean
    viewerId: string | undefined
  }) => (
    <div
      data-testid="share-info"
      data-can-cancel={`${canCancelPendingShare}`}
      data-viewer-id={viewerId ?? ''}
    />
  ),
  ProjectDropShareInfo: () => <div data-testid="drop-share-info" />,
}))
vi.mock('../ProjectTeamCards', () => ({
  MemberRow: ({
    member,
    canManage,
    onRemove,
  }: {
    member: ProjectMemberDto
    canManage: boolean
    onRemove: () => void
  }) => (
    <div data-testid="member-row" data-can-manage={`${canManage}`}>
      <span>{member.displayName}</span>
      <button onClick={onRemove}>remove-{member.id}</button>
    </div>
  ),
}))

beforeEach(async () => {
  await loadCatalog('uk')
})

function makeMember(id: string, role: Role, over: Partial<ProjectMemberDto> = {}) {
  return {
    id,
    userId: `u-${id}`,
    displayName: `Name ${id}`,
    role,
    leftAt: null,
    avatarUrl: null,
    ...over,
  } as unknown as ProjectMemberDto
}

function makeProject(over: Partial<Record<string, unknown>> = {}): ProjectDetailDto {
  return {
    id: 'proj-1',
    name: 'Platform Rewrite',
    companyName: 'Acme Corp',
    archivedAt: null,
    dropId: null,
    seniorId: null,
    seniorName: null,
    techStack: null,
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    pendingSeniorShare: null,
    members: [],
    effectiveTeam: undefined,
    ...over,
  } as unknown as ProjectDetailDto
}

function setup(
  props: Partial<ProjectOverviewTabProps> = {},
  projectOver: Partial<Record<string, unknown>> = {},
) {
  const handlers = { onAddMember: vi.fn<() => void>(), onRemoveMember: vi.fn() }
  render(
    <TooltipProvider>
      <ProjectOverviewTab
        project={makeProject(projectOver)}
        projectId="proj-1"
        viewerId="viewer-1"
        viewerRole="ADMIN"
        canManage={false}
        canRemoveMembers={false}
        canSeeProjectFinance={false}
        canEditOverride={false}
        canAccessLegend={false}
        canManageCredentials={false}
        availableToAddCount={1}
        {...handlers}
        {...props}
      />
    </TooltipProvider>,
    { wrapper: I18nTestProvider },
  )
  return handlers
}

function row(label: string): HTMLElement {
  const el = screen.getByText(`${label}:`).closest('[data-testid="project-info-row"]')
  if (!(el instanceof HTMLElement)) throw new Error(`no info row for ${label}`)
  return el
}

describe('ProjectOverviewTab — details card', () => {
  it('shows a dash for every empty field (7 for ADMIN) and the section title', () => {
    setup()
    expect(screen.getByText('Деталі проєкту')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(7)
    expect(screen.getByText('Загальні нотатки')).toBeInTheDocument()
  })

  it('renders each filled value with its row label', () => {
    setup(
      {},
      {
        techStack: 'React, Nest',
        teamSize: '5 людей',
        benefits: 'Страхування',
        paymentType: 'FOP',
        salaryReview: 'Раз на пів року',
        corpTech: 'MacBook',
        notesGeneral: 'Важливі\nнотатки',
      },
    )
    expect(screen.queryByText('—')).toBeNull()
    expect(within(row('Технологічний стек')).getByText('React, Nest')).toBeInTheDocument()
    expect(within(row('Склад команди')).getByText('5 людей')).toBeInTheDocument()
    expect(within(row('Бенефіти')).getByText('Страхування')).toBeInTheDocument()
    expect(within(row('Тип оплати')).getByText('ФОП')).toBeInTheDocument()
    expect(within(row('Перегляд зарплати')).getByText('Раз на пів року')).toBeInTheDocument()
    expect(within(row('Корпоративна техніка')).getByText('MacBook')).toBeInTheDocument()
    expect(screen.getByText(/Важливі/)).toHaveTextContent('Важливі нотатки')
  })

  it.each([
    ['FOP', 'ФОП'],
    ['GIG_CONTRACT', 'гіг-контракт'],
    ['USDT', 'USDT'],
  ])('payment type %s reads «%s»', (type, label) => {
    setup({}, { paymentType: type })
    expect(within(row('Тип оплати')).getByText(label)).toBeInTheDocument()
  })

  it.each(['ADMIN', 'HR', 'ACCOUNTANT', 'SENIOR'] as const)(
    'shows the payment-type row to %s',
    (role) => {
      setup({ viewerRole: role })
      expect(screen.getByText('Тип оплати:')).toBeInTheDocument()
    },
  )

  it('shows the payment-type row when the viewer role is unknown', () => {
    setup({ viewerRole: undefined })
    expect(screen.getByText('Тип оплати:')).toBeInTheDocument()
  })

  it('hides the payment-type row from JUNIOR (one fewer dash)', () => {
    setup({ viewerRole: 'JUNIOR' })
    expect(screen.queryByText('Тип оплати:')).toBeNull()
    expect(screen.getAllByText('—')).toHaveLength(6)
  })

  it('hides the senior-share and drop-share rows without finance access', () => {
    setup({ canSeeProjectFinance: false }, { dropId: 'd1' })
    expect(screen.queryByText('Частка сеньйора:')).toBeNull()
    expect(screen.queryByTestId('share-info')).toBeNull()
    expect(screen.queryByText('Частка дропа:')).toBeNull()
    expect(screen.queryByTestId('drop-share-info')).toBeNull()
  })

  it('with finance access shows the senior-share row wired to canEditOverride and the viewer id', () => {
    setup({ canSeeProjectFinance: true, canEditOverride: true })
    expect(screen.getByText('Частка сеньйора:')).toBeInTheDocument()
    expect(screen.getByTestId('share-info')).toHaveAttribute('data-can-cancel', 'true')
    expect(screen.getByTestId('share-info')).toHaveAttribute('data-viewer-id', 'viewer-1')
  })

  it('passes canCancelPendingShare=false through when the viewer cannot edit overrides', () => {
    setup({ canSeeProjectFinance: true, canEditOverride: false })
    expect(screen.getByTestId('share-info')).toHaveAttribute('data-can-cancel', 'false')
  })

  it('shows the drop-share row only for drop projects (finance access)', () => {
    setup({ canSeeProjectFinance: true }, { dropId: 'd1' })
    expect(screen.getByText('Частка дропа:')).toBeInTheDocument()
    expect(screen.getByTestId('drop-share-info')).toBeInTheDocument()
  })

  it('omits the drop-share row for a project without a drop', () => {
    setup({ canSeeProjectFinance: true }, { dropId: null })
    expect(screen.queryByText('Частка дропа:')).toBeNull()
  })

  it('stacks the senior-share row on mobile only while a share proposal is pending', () => {
    setup({ canSeeProjectFinance: true }, { pendingSeniorShare: { proposedPercent: 30 } })
    expect(row('Частка сеньйора')).toHaveClass('flex-col')
  })

  it('keeps the senior-share row unstacked without a pending proposal', () => {
    setup({ canSeeProjectFinance: true }, { pendingSeniorShare: null })
    expect(row('Частка сеньйора')).not.toHaveClass('flex-col')
  })
})

describe('ProjectOverviewTab — team card: senior row', () => {
  it('renders the senior with a profile link, initials, name and role badge', () => {
    setup({}, { seniorId: 'sen-1', seniorName: 'Ivan Petrenko' })
    const link = screen.getByText('Ivan Petrenko').closest('a')
    expect(link).toHaveAttribute('href', '/profile/sen-1')
    expect(screen.getByText('IP')).toBeInTheDocument()
    expect(screen.getByText('Сеньйор')).toBeInTheDocument()
  })

  it('renders the masked senior (name only) as plain text, not a link', () => {
    setup({}, { seniorId: null, seniorName: 'Admin Boss' })
    expect(screen.getByText('Admin Boss')).toBeInTheDocument()
    expect(screen.queryByTestId('profile-link')).toBeNull()
  })

  it('renders a seniorId-only project with an empty display name', () => {
    setup({}, { seniorId: 'sen-1', seniorName: null })
    expect(screen.getByTestId('profile-link')).toHaveAttribute('href', '/profile/sen-1')
    expect(screen.getByText('Сеньйор')).toBeInTheDocument()
  })

  it('renders no senior row when neither id nor name is present', () => {
    setup()
    expect(screen.queryByText('Сеньйор')).toBeNull()
  })

  it('treats an unknown viewer as JUNIOR for linking (link stays navigable)', () => {
    setup({ viewerRole: undefined }, { seniorId: 'sen-1', seniorName: 'Ivan Petrenko' })
    expect(screen.getByTestId('profile-link')).toBeInTheDocument()
  })

  it('SENIOR viewer gets the senior name as plain text', () => {
    setup({ viewerRole: 'SENIOR' }, { seniorId: 'sen-1', seniorName: 'Ivan Petrenko' })
    expect(screen.queryByTestId('profile-link')).toBeNull()
  })
})

describe('ProjectOverviewTab — team card: drop row', () => {
  const drop = {
    id: 'drop-1',
    displayName: 'Dmytro Drop',
    avatarUrl: 'https://img.example/d.png',
  }

  it.each(['ADMIN', 'HR', 'ACCOUNTANT'] as const)('shows the drop row to %s', (role) => {
    setup({ viewerRole: role }, { effectiveTeam: { drop } })
    const dropRow = screen.getByTestId('team-card-drop-row')
    expect(within(dropRow).getByText('Dmytro Drop')).toBeInTheDocument()
    expect(within(dropRow).getByText('Дроп')).toBeInTheDocument()
    expect(within(dropRow).getByTestId('avatar-img')).toHaveAttribute(
      'src',
      'https://img.example/d.png',
    )
    expect(within(dropRow).getByTestId('profile-link')).toHaveAttribute('href', '/profile/drop-1')
  })

  it.each(['SENIOR', 'JUNIOR', undefined] as const)('hides the drop row from %s', (role) => {
    setup({ viewerRole: role }, { effectiveTeam: { drop } })
    expect(screen.queryByTestId('team-card-drop-row')).toBeNull()
  })

  it('hides the drop row when the project has no drop', () => {
    setup({ viewerRole: 'ADMIN' }, { effectiveTeam: { drop: null } })
    expect(screen.queryByTestId('team-card-drop-row')).toBeNull()
  })

  it('renders initials and no image when the drop has no avatar', () => {
    setup({ viewerRole: 'ADMIN' }, { effectiveTeam: { drop: { ...drop, avatarUrl: null } } })
    expect(screen.queryByTestId('avatar-img')).toBeNull()
    expect(screen.getByText('DD')).toBeInTheDocument()
  })
})

describe('ProjectOverviewTab — team card: members', () => {
  it('shows placeholders when no HR / accountants / junior are assigned', () => {
    setup()
    expect(screen.getAllByText('Не призначено')).toHaveLength(2)
    expect(screen.getByText('Джуніор не призначений')).toBeInTheDocument()
    expect(screen.queryByText('Залишили проєкт')).toBeNull()
    expect(screen.queryAllByTestId('member-row')).toHaveLength(0)
  })

  it('lists active members per role and drops the matching placeholders', () => {
    setup(
      {},
      {
        members: [
          makeMember('hr1', 'HR'),
          makeMember('acc1', 'ACCOUNTANT'),
          makeMember('jun1', 'JUNIOR'),
        ],
      },
    )
    expect(screen.queryByText('Не призначено')).toBeNull()
    expect(screen.queryByText('Джуніор не призначений')).toBeNull()
    expect(screen.getAllByTestId('member-row')).toHaveLength(3)
    expect(screen.getByText('Name hr1')).toBeInTheDocument()
    expect(screen.getByText('Name acc1')).toBeInTheDocument()
    expect(screen.getByText('Name jun1')).toBeInTheDocument()
  })

  it('placeholder disappears per role independently (only HR present)', () => {
    setup({}, { members: [makeMember('hr1', 'HR')] })
    expect(screen.getAllByText('Не призначено')).toHaveLength(1)
    expect(screen.getByText('Джуніор не призначений')).toBeInTheDocument()
  })

  it('placeholder disappears per role independently (only accountant present)', () => {
    setup({}, { members: [makeMember('acc1', 'ACCOUNTANT')] })
    expect(screen.getAllByText('Не призначено')).toHaveLength(1)
  })

  it('passes canRemoveMembers through to active rows and removes the clicked member', async () => {
    const hr = makeMember('hr1', 'HR')
    const { onRemoveMember } = setup(
      { canRemoveMembers: true },
      { members: [hr, makeMember('jun1', 'JUNIOR')] },
    )
    for (const r of screen.getAllByTestId('member-row')) {
      expect(r).toHaveAttribute('data-can-manage', 'true')
    }
    await userEvent.click(screen.getByText('remove-hr1'))
    expect(onRemoveMember).toHaveBeenCalledTimes(1)
    expect(onRemoveMember).toHaveBeenCalledWith(hr)
  })

  it('passes canRemoveMembers=false through to active rows', () => {
    setup({ canRemoveMembers: false }, { members: [makeMember('hr1', 'HR')] })
    expect(screen.getByTestId('member-row')).toHaveAttribute('data-can-manage', 'false')
  })

  it('removes accountants and juniors via the same callback', async () => {
    const acc = makeMember('acc1', 'ACCOUNTANT')
    const jun = makeMember('jun1', 'JUNIOR')
    const { onRemoveMember } = setup({ canRemoveMembers: true }, { members: [acc, jun] })
    await userEvent.click(screen.getByText('remove-acc1'))
    await userEvent.click(screen.getByText('remove-jun1'))
    expect(onRemoveMember).toHaveBeenNthCalledWith(1, acc)
    expect(onRemoveMember).toHaveBeenNthCalledWith(2, jun)
  })

  it('lists past members under «Залишили проєкт» as non-manageable, not in the active lists', async () => {
    const past = makeMember('old1', 'HR', { leftAt: '2024-05-01T00:00:00.000Z' })
    const { onRemoveMember } = setup({ canRemoveMembers: true }, { members: [past] })
    expect(screen.getByText('Залишили проєкт')).toBeInTheDocument()
    // the only HR is past, so the HR slot still shows its placeholder
    expect(screen.getAllByText('Не призначено')).toHaveLength(2)
    expect(screen.getByTestId('member-row')).toHaveAttribute('data-can-manage', 'false')
    await userEvent.click(screen.getByText('remove-old1'))
    expect(onRemoveMember).not.toHaveBeenCalled()
  })
})

describe('ProjectOverviewTab — add-member button', () => {
  it('is hidden without canManage', () => {
    setup({ canManage: false })
    expect(screen.queryByRole('button', { name: 'Додати до складу' })).toBeNull()
  })

  it('is hidden for an archived project even with canManage', () => {
    setup({ canManage: true }, { archivedAt: '2024-05-01T00:00:00.000Z' })
    expect(screen.queryByRole('button', { name: 'Додати до складу' })).toBeNull()
  })

  it('is enabled and calls onAddMember when someone can be added', async () => {
    const { onAddMember } = setup({ canManage: true, availableToAddCount: 2 })
    const btn = screen.getByRole('button', { name: 'Додати до складу' })
    expect(btn).toBeEnabled()
    await userEvent.click(btn)
    expect(onAddMember).toHaveBeenCalledTimes(1)
  })

  it('is disabled and explains why when nobody can be added', async () => {
    const { onAddMember } = setup({ canManage: true, availableToAddCount: 0 })
    const btn = screen.getByRole('button', { name: 'Додати до складу' })
    expect(btn).toBeDisabled()
    await userEvent.hover(btn.parentElement as HTMLElement)
    expect((await screen.findAllByText('Немає кого додати')).length).toBeGreaterThan(0)
    expect(onAddMember).not.toHaveBeenCalled()
  })

  it('does not render the empty-hint tooltip content while someone can be added', async () => {
    setup({ canManage: true, availableToAddCount: 1 })
    const btn = screen.getByRole('button', { name: 'Додати до складу' })
    await userEvent.hover(btn.parentElement as HTMLElement)
    expect(screen.queryByText('Немає кого додати')).toBeNull()
  })
})

describe('ProjectOverviewTab — legend and credentials sections', () => {
  it('always renders the legend section with the project id and the canAccessLegend flag (true)', () => {
    setup({ canAccessLegend: true })
    const legend = screen.getByTestId('legend-section')
    expect(legend).toHaveAttribute('data-project-id', 'proj-1')
    expect(legend).toHaveAttribute('data-can-access', 'true')
  })

  it('passes canAccessLegend=false through unchanged', () => {
    setup({ canAccessLegend: false })
    expect(screen.getByTestId('legend-section')).toHaveAttribute('data-can-access', 'false')
  })

  it('renders the credentials section (editable) ONLY when canManageCredentials is true', () => {
    setup({ canManageCredentials: true })
    const creds = screen.getByTestId('credentials-section')
    expect(creds).toHaveAttribute('data-project-id', 'proj-1')
    expect(creds).toHaveAttribute('data-can-edit', 'true')
  })

  it('hides the credentials section when canManageCredentials is false', () => {
    setup({ canManageCredentials: false })
    expect(screen.queryByTestId('credentials-section')).toBeNull()
  })
})
