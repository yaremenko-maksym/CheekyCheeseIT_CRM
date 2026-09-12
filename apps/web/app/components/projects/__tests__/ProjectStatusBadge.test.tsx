/**
 * task-project-page-status-badge (backlog 188).
 *
 * `apps/web/app/routes/_authenticated/projects/$projectId.tsx` used to
 * derive its header badge from `archivedAt` alone — `!archivedAt` always
 * rendered "Активный", even for a `DRAFT` or `REJECTED` project (the
 * approval flow `ProjectRow.tsx` already models via `project.status`,
 * task-project-status-filter-ui). This file pins the single source of
 * truth that replaces that: `projectStatusBadge()` decides the label from
 * BOTH `archivedAt` and `status`, with archive always winning (AC3 —
 * an archived DRAFT/REJECTED project still reads "В архиве").
 *
 * `ProjectStatusBadge` is the thin render wrapper around it — tested here
 * directly (no router / no full route mount) rather than through the
 * 2000+ line `$projectId.tsx` route component, the same seam choice this
 * file's neighbors (`InfoRow.structure.test.tsx`, `ProjectEditFields.test.tsx`)
 * already made for other sub-pieces of that page.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { projectStatusBadge, ProjectStatusBadge } from '../ProjectStatusBadge'

describe('projectStatusBadge (pure function)', () => {
  it('DRAFT, not archived → "Ждёт решения" / status DRAFT (AC1)', () => {
    expect(projectStatusBadge({ status: 'DRAFT', archivedAt: null })).toMatchObject({
      status: 'DRAFT',
      label: 'Ждёт решения',
    })
  })

  it('REJECTED, not archived → "Отклонён" / status REJECTED (AC2)', () => {
    expect(projectStatusBadge({ status: 'REJECTED', archivedAt: null })).toMatchObject({
      status: 'REJECTED',
      label: 'Отклонён',
    })
  })

  it('ACTIVE, not archived → "Активный" / status ACTIVE (AC3)', () => {
    expect(projectStatusBadge({ status: 'ACTIVE', archivedAt: null })).toMatchObject({
      status: 'ACTIVE',
      label: 'Активный',
    })
  })

  it('archive wins over DRAFT — archived draft reads "В архиве", not "Ждёт решения" (AC3)', () => {
    expect(
      projectStatusBadge({ status: 'DRAFT', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ).toMatchObject({
      status: 'ARCHIVED',
      label: 'В архиве',
    })
  })

  it('archive wins over REJECTED — archived rejected project reads "В архиве" (AC3)', () => {
    expect(
      projectStatusBadge({ status: 'REJECTED', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ).toMatchObject({
      status: 'ARCHIVED',
      label: 'В архиве',
    })
  })

  it('archive wins over ACTIVE — the existing archived-active behavior is unchanged (AC3)', () => {
    expect(
      projectStatusBadge({ status: 'ACTIVE', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ).toMatchObject({
      status: 'ARCHIVED',
      label: 'В архиве',
    })
  })
})

describe('<ProjectStatusBadge /> (render)', () => {
  it('DRAFT renders "Ждёт решения", not "Активный", with data-testid + data-status', () => {
    render(<ProjectStatusBadge project={{ status: 'DRAFT', archivedAt: null }} />)
    const badge = screen.getByTestId('project-status-badge')
    expect(badge).toHaveTextContent('Ждёт решения')
    expect(badge).toHaveAttribute('data-status', 'DRAFT')
    expect(screen.queryByText('Активный')).not.toBeInTheDocument()
  })

  it('REJECTED renders "Отклонён"', () => {
    render(<ProjectStatusBadge project={{ status: 'REJECTED', archivedAt: null }} />)
    const badge = screen.getByTestId('project-status-badge')
    expect(badge).toHaveTextContent('Отклонён')
    expect(badge).toHaveAttribute('data-status', 'REJECTED')
  })

  it('ACTIVE, not archived, renders "Активный"', () => {
    render(<ProjectStatusBadge project={{ status: 'ACTIVE', archivedAt: null }} />)
    const badge = screen.getByTestId('project-status-badge')
    expect(badge).toHaveTextContent('Активный')
    expect(badge).toHaveAttribute('data-status', 'ACTIVE')
  })

  it('archived project renders "В архиве" and keeps the legacy project-archived-badge testid (existing spec: projects-archive.spec.ts)', () => {
    render(
      <ProjectStatusBadge project={{ status: 'ACTIVE', archivedAt: '2026-01-01T00:00:00.000Z' }} />,
    )
    const badge = screen.getByTestId('project-archived-badge')
    expect(badge).toHaveTextContent('В архиве')
    expect(badge).toHaveAttribute('data-status', 'ARCHIVED')
    expect(screen.queryByTestId('project-status-badge')).not.toBeInTheDocument()
  })
})
