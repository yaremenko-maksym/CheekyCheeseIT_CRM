/**
 * task-pending-screen design spec §5.2 п.2. `PendingKindSection` is a thin
 * presentational wrapper (icon + uppercase header + list) — deletion-test
 * per codebase-design skill: the interesting behaviour is "renders nothing
 * when empty" (§3 "рендерится только если непуста") and the motion/list
 * plumbing, not the row content itself (PendingItemRow has its own tests).
 */
import { render, screen } from '@testing-library/react'
import { Briefcase } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import type { PendingItem } from '@/hooks/use-pending-items'
import { PendingKindSection } from '../PendingKindSection'

vi.mock('@/components/projects/ProjectApprovalActions', () => ({
  ProjectApprovalActions: () => <div data-testid="stub-actions" />,
}))

function item(overrides: Partial<PendingItem>): PendingItem {
  return {
    kind: 'PROJECT_APPROVAL',
    subjectId: 'subj-1',
    title: 'Acme Corp',
    createdAt: new Date().toISOString(),
    actions: ['approve', 'reject'],
    link: '/projects/subj-1',
    ...overrides,
  }
}

describe('PendingKindSection', () => {
  it('renders nothing at all when items is empty — no empty card, no heading', () => {
    const { container } = render(
      <PendingKindSection
        title="Проекты"
        icon={Briefcase}
        items={[]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the uppercase title as an h3 and one row per item', () => {
    render(
      <PendingKindSection
        title="Проекты"
        icon={Briefcase}
        items={[item({ subjectId: 'p1' }), item({ subjectId: 'p2', title: 'Other Co' })]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Проекты' })).toBeInTheDocument()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Other Co')).toBeInTheDocument()
  })

  it('proposedByMe zone renders the observer row styling (border-amber), mine does not (§4 token map)', () => {
    const { unmount } = render(
      <PendingKindSection
        title="Проекты"
        icon={Briefcase}
        items={[item({ subjectId: 'p1' })]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('pending-item-row-PROJECT_APPROVAL-p1')).not.toHaveClass(
      'border-amber-500/30',
    )
    unmount()

    render(
      <PendingKindSection
        title="Проекты"
        icon={Briefcase}
        items={[item({ subjectId: 'p1', actions: ['open'] })]}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('pending-item-row-PROJECT_APPROVAL-p1')).toHaveClass(
      'border-amber-500/30',
    )
  })
})
