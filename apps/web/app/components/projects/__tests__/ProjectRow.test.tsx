/**
 * ProjectRow — inner-link interaction tests.
 *
 * Covers task-fix-pr34-user-testing-round8 acceptance criteria:
 *   AC-1. Senior name renders as <a href="/profile/<seniorId>"> с hover:underline.
 *   AC-2. First active junior name renders as <a href="/profile/<juniorId>"> когда есть джун.
 *   AC-3. Клик по имени синьора/джуна НЕ переходит на детальку проекта (stopPropagation).
 *   AC-4. Когда джунов нет — junior-link отсутствует, отображается «Нет джуна».
 *
 * Setup: minimal in-memory TanStack Router (one __root__ route only) so the
 * `<Link>` component can render valid <a href="…"> tags without spinning up
 * the real generated route tree. The router resolves the initial route
 * asynchronously after first render, so all queries use `findBy*` (await) or
 * `await waitFor` to let Suspense + Transitioner settle.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import type { ProjectDto, ProjectMemberDto } from '@crm/shared'

import { ProjectRow } from '../ProjectRow'

// Stable seed values so href assertions can use literal strings.
const PROJECT_ID = '00000000-0000-0000-0000-0000000000a1'
const SENIOR_ID = '00000000-0000-0000-0000-0000000000b1'
const JUNIOR_ID = '00000000-0000-0000-0000-0000000000c1'

function makeJunior(overrides: Partial<ProjectMemberDto> = {}): ProjectMemberDto {
  return {
    id: '00000000-0000-0000-0000-0000000000d1',
    userId: JUNIOR_ID,
    displayName: 'Junior One',
    email: 'junior@example.com',
    avatarUrl: null,
    avatarDocumentId: null,
    role: 'JUNIOR',
    joinedAt: '2026-01-01T00:00:00.000Z',
    leftAt: null,
    ...overrides,
  }
}

function makeProject(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: PROJECT_ID,
    name: 'Frontend platform',
    companyName: 'Acme Corp',
    domain: 'SaaS',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: '2026-01-01T00:00:00.000Z',
    seniorId: SENIOR_ID,
    seniorName: 'Senior One',
    dropId: null,
    dropName: null,
    dropSharePercent: null,
    rate: 4500,
    currency: 'USD',
    seniorSharePercentOverride: null,
    seniorSharePercentDefault: 26,
    members: [makeJunior()],
    techStack: null,
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Render the row inside a minimal TanStack Router context so `<Link>` resolves.
 * The root route renders the `ProjectRow` directly — we never navigate; we
 * just need a valid router instance so `<Link>` can build href values.
 */
function renderProjectRow(project: ProjectDto) {
  const rootRoute = createRootRoute({
    component: () => <ProjectRow project={project} />,
  })

  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  return render(<RouterProvider router={router} />)
}

describe('ProjectRow — clickable senior/junior names', () => {
  it('AC-1: renders senior name as a link to /profile/:seniorId', async () => {
    const project = makeProject()
    renderProjectRow(project)

    const link = await screen.findByTestId(`project-row-${project.id}-senior-link`)
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', `/profile/${SENIOR_ID}`)
    expect(link).toHaveTextContent('Senior One')
    expect(link.className).toContain('hover:underline')
  })

  it('AC-2: renders first active junior name as a link to /profile/:juniorId', async () => {
    const project = makeProject()
    renderProjectRow(project)

    const link = await screen.findByTestId(`project-row-${project.id}-junior-link`)
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', `/profile/${JUNIOR_ID}`)
    expect(link).toHaveTextContent('Junior One')
  })

  it('AC-4: does not render junior link when project has no active juniors', async () => {
    const project = makeProject({ members: [] })
    renderProjectRow(project)

    // Wait for the row itself to render — then assert junior link is absent.
    await screen.findByTestId(`project-row-${project.id}`)
    expect(screen.queryByTestId(`project-row-${project.id}-junior-link`)).not.toBeInTheDocument()
    expect(screen.getByText('Нет джуна')).toBeInTheDocument()
  })

  it('AC-3: senior link onClick stops synthetic React event propagation', async () => {
    // The row's stretched-link uses a ::before overlay tied to the company-name
    // `<a>` (`/projects/$projectId`). The senior link sits at z-[2] (above
    // the overlay's z-[1]) so it captures the click. Additionally, the onClick
    // handler calls `e.stopPropagation()` as defensive protection — verified
    // by listening on a React-synthetic wrapper and asserting it never fires.
    const user = userEvent.setup()
    const project = makeProject()
    const syntheticSpy = vi.fn()

    const rootRoute = createRootRoute({
      component: () => (
        // A wrapping div with an onClick lets us listen via React's synthetic
        // event system — which is what stopPropagation() actually targets.
        <div data-testid="synthetic-wrapper" onClick={syntheticSpy}>
          <ProjectRow project={project} />
        </div>
      ),
    })

    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })

    render(<RouterProvider router={router} />)

    const link = await screen.findByTestId(`project-row-${project.id}-senior-link`)

    await user.click(link)

    // Synthetic propagation must be stopped by the onClick handler in ProjectRow.
    expect(syntheticSpy).not.toHaveBeenCalled()
  })

  it('treats left juniors as inactive — link points to the still-active junior', async () => {
    const activeJunior = makeJunior({
      id: '00000000-0000-0000-0000-0000000000d2',
      userId: '00000000-0000-0000-0000-0000000000c2',
      displayName: 'Junior Two',
      leftAt: null,
    })
    const leftJunior = makeJunior({
      id: '00000000-0000-0000-0000-0000000000d3',
      userId: '00000000-0000-0000-0000-0000000000c3',
      displayName: 'Junior Gone',
      leftAt: '2026-02-01T00:00:00.000Z',
    })

    const project = makeProject({ members: [leftJunior, activeJunior] })
    renderProjectRow(project)

    const link = await screen.findByTestId(`project-row-${project.id}-junior-link`)
    expect(link).toHaveAttribute('href', `/profile/00000000-0000-0000-0000-0000000000c2`)
    expect(link).toHaveTextContent('Junior Two')
  })
})
