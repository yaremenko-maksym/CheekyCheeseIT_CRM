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
 *
 * `toEqual` (not `toMatchObject`) on the pure-function results, and
 * `toHaveClass` on the rendered badge, are deliberate: the mutation gate's
 * first pass on this file (task's own AC5) survived every `variant`/
 * `className` string with a partial-match assertion — `toMatchObject` only
 * checked `status`/`label`, so blanking out `variant: 'outline'` or a whole
 * `className` string left every assertion passing. Full-object/attribute
 * assertions are what pins them.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProjectStatus } from '@crm/shared'
import { projectStatusBadge, ProjectStatusBadge } from '../ProjectStatusBadge'

describe('projectStatusBadge (pure function)', () => {
  it('DRAFT, not archived → "Ждёт решения" / status DRAFT, outline variant, amber classes (AC1)', () => {
    expect(projectStatusBadge({ status: 'DRAFT', archivedAt: null })).toEqual({
      status: 'DRAFT',
      label: 'Ждёт решения',
      variant: 'outline',
      className: 'border-amber-500/30 bg-amber-500/20 text-amber-300',
    })
  })

  it('REJECTED, not archived → "Отклонён" / status REJECTED, outline variant, destructive classes (AC2)', () => {
    expect(projectStatusBadge({ status: 'REJECTED', archivedAt: null })).toEqual({
      status: 'REJECTED',
      label: 'Отклонён',
      variant: 'outline',
      className: 'border-destructive/30 bg-destructive/10 text-destructive',
    })
  })

  it('ACTIVE, not archived → "Активный" / status ACTIVE, default variant, no extra classes (AC3)', () => {
    expect(projectStatusBadge({ status: 'ACTIVE', archivedAt: null })).toEqual({
      status: 'ACTIVE',
      label: 'Активный',
      variant: 'default',
      className: '',
    })
  })

  it('archive wins over DRAFT — archived draft reads "В архиве", not "Ждёт решения" (AC3)', () => {
    expect(projectStatusBadge({ status: 'DRAFT', archivedAt: '2026-01-01T00:00:00.000Z' })).toEqual(
      {
        status: 'ARCHIVED',
        label: 'В архиве',
        variant: 'outline',
        className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
      },
    )
  })

  it('archive wins over REJECTED — archived rejected project reads "В архиве" (AC3)', () => {
    expect(
      projectStatusBadge({ status: 'REJECTED', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ).toEqual({
      status: 'ARCHIVED',
      label: 'В архиве',
      variant: 'outline',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
    })
  })

  it('archive wins over ACTIVE — the existing archived-active behavior is unchanged (AC3)', () => {
    expect(
      projectStatusBadge({ status: 'ACTIVE', archivedAt: '2026-01-01T00:00:00.000Z' }),
    ).toEqual({
      status: 'ARCHIVED',
      label: 'В архиве',
      variant: 'outline',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
    })
  })

  it('throws for an unknown project status — the exhaustiveness guard is a real runtime fallback, not just a compile-time comment', () => {
    expect(() =>
      projectStatusBadge({ status: 'UNKNOWN' as ProjectStatus, archivedAt: null }),
    ).toThrow('projectStatusBadge: unhandled project status UNKNOWN')
  })
})

describe('<ProjectStatusBadge /> (render)', () => {
  it('DRAFT renders "Ждёт решения", not "Активный", with data-testid + data-status + the outline/amber classes', () => {
    render(<ProjectStatusBadge project={{ status: 'DRAFT', archivedAt: null }} />)
    const badge = screen.getByTestId('project-status-badge')
    expect(badge).toHaveTextContent('Ждёт решения')
    expect(badge).toHaveAttribute('data-status', 'DRAFT')
    expect(badge).toHaveClass('text-xs', 'border-amber-500/30', 'bg-amber-500/20', 'text-amber-300')
    expect(screen.queryByText('Активный')).not.toBeInTheDocument()
  })

  it('REJECTED renders "Отклонён" with the destructive classes', () => {
    render(<ProjectStatusBadge project={{ status: 'REJECTED', archivedAt: null }} />)
    const badge = screen.getByTestId('project-status-badge')
    expect(badge).toHaveTextContent('Отклонён')
    expect(badge).toHaveAttribute('data-status', 'REJECTED')
    expect(badge).toHaveClass(
      'text-xs',
      'border-destructive/30',
      'bg-destructive/10',
      'text-destructive',
    )
  })

  it('ACTIVE, not archived, renders "Активный" with only the base text-xs class', () => {
    render(<ProjectStatusBadge project={{ status: 'ACTIVE', archivedAt: null }} />)
    const badge = screen.getByTestId('project-status-badge')
    expect(badge).toHaveTextContent('Активный')
    expect(badge).toHaveAttribute('data-status', 'ACTIVE')
    expect(badge).toHaveClass('text-xs')
  })

  it('archived project renders "В архиве" and keeps the legacy project-archived-badge testid (existing spec: projects-archive.spec.ts)', () => {
    render(
      <ProjectStatusBadge project={{ status: 'ACTIVE', archivedAt: '2026-01-01T00:00:00.000Z' }} />,
    )
    const badge = screen.getByTestId('project-archived-badge')
    expect(badge).toHaveTextContent('В архиве')
    expect(badge).toHaveAttribute('data-status', 'ARCHIVED')
    expect(badge).toHaveClass('text-xs', 'border-amber-500/30', 'bg-amber-500/10', 'text-amber-500')
    expect(screen.queryByTestId('project-status-badge')).not.toBeInTheDocument()
  })
})
