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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import type { ProjectDto, ProjectMemberDto } from '@crm/shared'
import type { Role } from '@/lib/route-access'

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
    // task-project-draft-status: required field on ProjectDto. This fixture
    // exists to test link/interaction behavior, not status — always active.
    status: 'ACTIVE',
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
 *
 * task-project-status-filter-ui: also wraps a `QueryClientProvider` —
 * unconditionally, not just when a test expects the Confirm/Reject actions
 * to render — because `ProjectApprovalActions` calls `useMutation()`
 * INTERNALLY the moment it mounts (even before any click), and React throws
 * synchronously without a QueryClient in the tree. Harmless when `canAct`
 * is false (the actions component never mounts at all in that case).
 */
function renderProjectRow(
  project: ProjectDto,
  opts: { viewerRole?: Role; viewerId?: string } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <ProjectRow project={project} viewerRole={opts.viewerRole} viewerId={opts.viewerId} />
    ),
  })

  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
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

/**
 * task-project-status-filter-ui — the 4-branch status badge (§7/§8) and the
 * Confirm/Reject action gate. Each test targets ONE mutant class the
 * mutation gate reported on `ProjectRow.tsx`'s `isPending`/`isRejected`/
 * `canAct` computation and the row's opacity/ring classes — see the coder's
 * final report for the exact survivor list this suite closes.
 */
const DROP_ID = '00000000-0000-0000-0000-0000000000e1'

describe('ProjectRow — status badge (design spec §7/§8)', () => {
  it('ACTIVE, non-archived: renders the domain badge, amber/destructive branches absent', async () => {
    const project = makeProject({ status: 'ACTIVE', domain: 'FinTech' })
    renderProjectRow(project)

    await screen.findByTestId(`project-row-${project.id}`)
    expect(screen.getByText('FinTech')).toBeInTheDocument()
    expect(screen.queryByTestId(`project-row-${project.id}-status-pending`)).not.toBeInTheDocument()
    expect(
      screen.queryByTestId(`project-row-${project.id}-status-rejected`),
    ).not.toBeInTheDocument()
    const dot = screen.getByTestId(`project-row-${project.id}-status-dot`)
    expect(dot.className).toContain('bg-emerald-500')
    const row = screen.getByTestId(`project-row-${project.id}`)
    expect(row.className).not.toContain('opacity-60')
    expect(row.className).not.toContain('ring-amber-500/20')
  })

  it('DRAFT: renders the "Ждёт подтверждения" badge, amber dot, ring — no opacity dimming', async () => {
    const project = makeProject({ status: 'DRAFT', dropId: null })
    renderProjectRow(project)

    const badge = await screen.findByTestId(`project-row-${project.id}-status-pending`)
    expect(badge).toHaveTextContent('Ждёт подтверждения')
    // .tagName check (not just getByText) — kills the `pendingCaption && <p>`
    // -> `pendingCaption || <p>` mutant, which getByText alone cannot see
    // (both render the same visible text, just not wrapped in a <p>).
    const caption = screen.getByText(`от ${project.seniorName}`)
    expect(caption.tagName).toBe('P')
    expect(caption).toHaveAttribute('title', `от ${project.seniorName}`)
    const dot = screen.getByTestId(`project-row-${project.id}-status-dot`)
    expect(dot.className).toContain('bg-amber-500')
    const row = screen.getByTestId(`project-row-${project.id}`)
    expect(row.className).not.toContain('opacity-60')
    expect(row.className).toContain('ring-1')
    expect(row.className).toContain('ring-amber-500/20')
  })

  it('DRAFT drop-project: caption names both the senior and "дропа"', async () => {
    const project = makeProject({ status: 'DRAFT', dropId: DROP_ID, dropName: 'Drop One' })
    renderProjectRow(project)

    await screen.findByTestId(`project-row-${project.id}-status-pending`)
    expect(screen.getByText(`от ${project.seniorName} и дропа`)).toBeInTheDocument()
  })

  it('REJECTED: renders the "Отклонено" badge + reason text, destructive dot, opacity dimming (same treatment as archived)', async () => {
    const project = makeProject({ status: 'REJECTED', rejectionReason: 'нет бюджета на Q3' })
    renderProjectRow(project)

    const badge = await screen.findByTestId(`project-row-${project.id}-status-rejected`)
    expect(badge).toHaveTextContent('Отклонено')
    const reason = screen.getByText('«нет бюджета на Q3»')
    expect(reason).toHaveAttribute('title', 'нет бюджета на Q3')
    const dot = screen.getByTestId(`project-row-${project.id}-status-dot`)
    expect(dot.className).toContain('bg-destructive/60')
    const row = screen.getByTestId(`project-row-${project.id}`)
    expect(row.className).toContain('opacity-60')
    expect(row.className).not.toContain('ring-amber-500/20')
  })

  it('REJECTED with no reason on the DTO: the badge still renders, no reason paragraph', async () => {
    const project = makeProject({ status: 'REJECTED', rejectionReason: null })
    renderProjectRow(project)

    await screen.findByTestId(`project-row-${project.id}-status-rejected`)
    expect(screen.queryByText(/«.*»/)).not.toBeInTheDocument()
  })

  it('ARCHIVED still wins over the other branches (mutually exclusive in practice, but the priority order is defensive)', async () => {
    const project = makeProject({ status: 'ACTIVE', archivedAt: '2026-02-01T00:00:00.000Z' })
    renderProjectRow(project)

    await screen.findByText('В архиве')
    expect(screen.queryByTestId(`project-row-${project.id}-status-pending`)).not.toBeInTheDocument()
    const row = screen.getByTestId(`project-row-${project.id}`)
    expect(row.className).toContain('opacity-60')
    const dot = screen.getByTestId(`project-row-${project.id}-status-dot`)
    expect(dot.className).toContain('bg-muted-foreground/40')
  })
})

describe('ProjectRow — Confirm/Reject actions gate (canAct, §Что сделать item 3)', () => {
  it('DRAFT + viewer IS the senior: actions render', async () => {
    const project = makeProject({ status: 'DRAFT' })
    renderProjectRow(project, { viewerRole: 'SENIOR', viewerId: SENIOR_ID })

    expect(await screen.findByTestId(`project-approval-approve-${project.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`project-approval-reject-${project.id}`)).toBeInTheDocument()
  })

  it('DRAFT + viewer IS the drop: actions render (identity check, not a SENIOR-only gate)', async () => {
    const project = makeProject({ status: 'DRAFT', dropId: DROP_ID, dropName: 'Drop One' })
    renderProjectRow(project, { viewerRole: 'DROP', viewerId: DROP_ID })

    expect(await screen.findByTestId(`project-approval-approve-${project.id}`)).toBeInTheDocument()
  })

  it('DRAFT drop-project + viewer IS the senior (not the drop): actions still render — matching EITHER id is enough, not both', async () => {
    // dropId set + viewerId matches ONLY seniorId (not dropId) — the one
    // combination that distinguishes `a === x || a === y` from a wrongly
    // AND-ed version of the same check.
    const project = makeProject({ status: 'DRAFT', dropId: DROP_ID, dropName: 'Drop One' })
    renderProjectRow(project, { viewerRole: 'SENIOR', viewerId: SENIOR_ID })

    expect(await screen.findByTestId(`project-approval-approve-${project.id}`)).toBeInTheDocument()
  })

  it("DRAFT + viewer is neither senior nor drop (e.g. ADMIN viewing someone else's draft): no actions", async () => {
    const project = makeProject({ status: 'DRAFT' })
    renderProjectRow(project, {
      viewerRole: 'ADMIN',
      viewerId: '00000000-0000-0000-0000-0000000000ff',
    })

    await screen.findByTestId(`project-row-${project.id}-status-pending`)
    expect(screen.queryByTestId(`project-approval-approve-${project.id}`)).not.toBeInTheDocument()
  })

  it('DRAFT + no viewerId supplied: no actions (defensive default)', async () => {
    const project = makeProject({ status: 'DRAFT' })
    renderProjectRow(project)

    await screen.findByTestId(`project-row-${project.id}-status-pending`)
    expect(screen.queryByTestId(`project-approval-approve-${project.id}`)).not.toBeInTheDocument()
  })

  it('ACTIVE project, viewer IS the senior: still no actions — isPending gates canAct regardless of identity', async () => {
    const project = makeProject({ status: 'ACTIVE' })
    renderProjectRow(project, { viewerRole: 'SENIOR', viewerId: SENIOR_ID })

    await screen.findByTestId(`project-row-${project.id}`)
    expect(screen.queryByTestId(`project-approval-approve-${project.id}`)).not.toBeInTheDocument()
  })
})
