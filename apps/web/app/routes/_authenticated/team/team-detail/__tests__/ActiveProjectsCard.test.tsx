import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto, Role, TeamDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
    }: {
      children?: ReactNode
      to?: string
      params?: { projectId: string }
    }) => <a href={(to ?? '#').replace('$projectId', params?.projectId ?? '')}>{children}</a>,
  }
})

vi.mock('@/components/projects/ProjectLogo', () => ({
  ProjectLogo: ({ companyName, fallback }: { companyName: string; fallback?: string }) => (
    <span data-testid="project-logo" data-company={companyName}>
      {fallback}
    </span>
  ),
}))

import { ActiveProjectsCard } from '../components/ActiveProjectsCard'

function project(
  id: string,
  name: string,
  companyName: string,
  members: { userId: string; role: string; leftAt: string | null }[] | undefined,
): ProjectDto {
  return {
    id,
    name,
    companyName,
    logoDocumentId: null,
    logoExternalUrl: null,
    members,
  } as unknown as ProjectDto
}

const teamMembers = [
  { userId: 'j1', displayName: 'Ivan Petrenko', avatarUrl: null },
  { userId: 'j2', displayName: 'Olga Koval', avatarUrl: 'https://img.test/olga.png' },
] as unknown as TeamDto['members']

function renderCard(projects: ProjectDto[], viewerRole: Role | undefined) {
  return render(
    <I18nTestProvider>
      <ActiveProjectsCard
        visibleProjects={projects}
        viewerRole={viewerRole}
        members={teamMembers}
      />
    </I18nTestProvider>,
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('ActiveProjectsCard', () => {
  it('shows the empty state and no count badge when there are no projects', () => {
    renderCard([], 'ADMIN')
    expect(screen.getByText('Активні проєкти')).toBeTruthy()
    expect(screen.getByText('Немає активних проєктів')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('renders each project as a link with name, company, logo fallback, status and the count', () => {
    renderCard(
      [
        project('p1', 'Alpha', 'Acme Corp', [{ userId: 'j1', role: 'JUNIOR', leftAt: null }]),
        project('p2', 'Beta', 'Zeta Inc', []),
      ],
      'ADMIN',
    )
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0]!.getAttribute('href')).toBe('/projects/p1')
    expect(links[1]!.getAttribute('href')).toBe('/projects/p2')
    expect(links[0]!.textContent).toContain('Alpha')
    expect(links[0]!.textContent).toContain('Acme Corp')
    expect(links[0]!.textContent).toContain('Активний')
    const logos = screen.getAllByTestId('project-logo')
    expect(logos[0]!.textContent).toBe('AC')
    expect(logos[1]!.textContent).toBe('ZE')
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.queryByText('Немає активних проєктів')).toBeNull()
  })

  it('ADMIN sees the junior identity in the slot', () => {
    renderCard(
      [project('p1', 'Alpha', 'Acme', [{ userId: 'j1', role: 'JUNIOR', leftAt: null }])],
      'ADMIN',
    )
    const slot = screen.getByTestId('project-junior-slot')
    expect(slot.textContent).toContain('Ivan Petrenko')
    expect(slot.textContent).toContain('IP')
    expect(screen.queryByText('Джуніора призначено')).toBeNull()
    expect(screen.queryByText('Джуніора не призначено')).toBeNull()
  })

  it('an undefined viewer role still sees the identity (only SENIOR is hidden)', () => {
    renderCard(
      [project('p1', 'Alpha', 'Acme', [{ userId: 'j1', role: 'JUNIOR', leftAt: null }])],
      undefined,
    )
    expect(screen.getByTestId('project-junior-slot').textContent).toContain('Ivan Petrenko')
  })

  it('SENIOR viewer sees the slot occupied but the identity hidden', () => {
    renderCard(
      [project('p1', 'Alpha', 'Acme', [{ userId: 'j1', role: 'JUNIOR', leftAt: null }])],
      'SENIOR',
    )
    expect(screen.getByText('Джуніора призначено')).toBeTruthy()
    expect(screen.queryByTestId('project-junior-slot')).toBeNull()
    expect(screen.queryByText('Ivan Petrenko')).toBeNull()
  })

  it('shows "not assigned" when the only junior has left, for ADMIN and SENIOR alike', () => {
    const left = project('p1', 'Alpha', 'Acme', [
      { userId: 'j1', role: 'JUNIOR', leftAt: '2026-01-01' },
    ])
    const admin = renderCard([left], 'ADMIN')
    expect(screen.getByText('Джуніора не призначено')).toBeTruthy()
    expect(screen.queryByTestId('project-junior-slot')).toBeNull()
    admin.unmount()
    renderCard([left], 'SENIOR')
    expect(screen.getByText('Джуніора не призначено')).toBeTruthy()
  })

  it('shows "not assigned" when the project has no members array or only a non-junior member', () => {
    renderCard(
      [
        project('p1', 'Alpha', 'Acme', undefined),
        project('p2', 'Beta', 'Zeta', [{ userId: 'j1', role: 'SENIOR', leftAt: null }]),
      ],
      'ADMIN',
    )
    expect(screen.getAllByText('Джуніора не призначено')).toHaveLength(2)
    expect(screen.queryByTestId('project-junior-slot')).toBeNull()
  })

  it('shows "not assigned" for ADMIN when the junior is not on the team roster', () => {
    renderCard(
      [project('p1', 'Alpha', 'Acme', [{ userId: 'ghost', role: 'JUNIOR', leftAt: null }])],
      'ADMIN',
    )
    expect(screen.getByText('Джуніора не призначено')).toBeTruthy()
  })

  it('renders the junior avatar image when the member has an avatarUrl', () => {
    renderCard(
      [project('p1', 'Alpha', 'Acme', [{ userId: 'j2', role: 'JUNIOR', leftAt: null }])],
      'ADMIN',
    )
    const slot = screen.getByTestId('project-junior-slot')
    expect(slot.textContent).toContain('Olga Koval')
    expect(slot.textContent).toContain('OK')
  })
})
