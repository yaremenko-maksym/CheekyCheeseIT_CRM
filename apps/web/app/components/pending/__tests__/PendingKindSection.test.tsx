/**
 * task-pending-screen design spec §5.2 п.2. `PendingKindSection` is a thin
 * presentational wrapper (icon + uppercase header + list) — deletion-test
 * per codebase-design skill: the interesting behaviour is "renders nothing
 * when empty" (§3 "рендерится только если непуста") and the motion/list
 * plumbing, not the row content itself (PendingItemRow has its own tests).
 */
import { render as rtlRender, screen } from '@testing-library/react'
import type { RenderOptions } from '@testing-library/react'
import { Briefcase } from 'lucide-react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingItem } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { PendingKindSection } from '../PendingKindSection'

// task-i18n-stage3e-pr4: the rows inside read `useLingui()`. The section
// itself carries NO text of its own — `title` arrives as an already-resolved
// string, and every testid is built from `zone`+`kind`, never from `title`
// (the test «heading testid does not depend on the visible title» below is
// what keeps a translation from ever breaking a selector).
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

vi.mock('@/components/projects/ProjectApprovalActions', () => ({
  ProjectApprovalActions: () => <div data-testid="stub-actions" />,
}))

// SR-L-3 (PR #667 fix-round 2): this file only ever constructs
// PROJECT_APPROVAL rows, so a plain `Partial<PendingItem>` narrowed to that
// one variant (rather than the permissive cast other pending test files use)
// is enough — the discriminated union does not fight this file at all.
type ProjectApprovalItem = Extract<PendingItem, { kind: 'PROJECT_APPROVAL' }>

function item(overrides: Partial<ProjectApprovalItem>): PendingItem {
  return {
    kind: 'PROJECT_APPROVAL',
    subjectType: 'PROJECT',
    subjectId: 'subj-1',
    title: 'Acme Corp',
    createdAt: new Date().toISOString(),
    actions: ['approve', 'reject'],
    link: '/projects/subj-1',
    approvalId: '00000000-0000-4000-8000-0000000000a1',
    viewerSharePercent: null,
    seniorName: null,
    ...overrides,
  }
}

describe('PendingKindSection', () => {
  it('renders nothing at all when items is empty — no empty card, no heading', () => {
    const { container } = render(
      <PendingKindSection
        kind="PROJECT_APPROVAL"
        title="Проєкти"
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
        kind="PROJECT_APPROVAL"
        title="Проєкти"
        icon={Briefcase}
        items={[item({ subjectId: 'p1' }), item({ subjectId: 'p2', title: 'Other Co' })]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Проєкти' })).toBeInTheDocument()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Other Co')).toBeInTheDocument()
  })

  it('proposedByMe zone renders the observer row styling (border-amber), mine does not (§4 token map)', () => {
    const { unmount } = render(
      <PendingKindSection
        kind="PROJECT_APPROVAL"
        title="Проєкти"
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
        kind="PROJECT_APPROVAL"
        title="Проєкти"
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

  it('the heading is focusable programmatically (tabIndex -1) but not in the Tab order (design spec §12)', () => {
    render(
      <PendingKindSection
        kind="PROJECT_APPROVAL"
        title="Проєкти"
        icon={Briefcase}
        items={[item({ subjectId: 'p1' })]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Проєкти' })).toHaveAttribute(
      'tabindex',
      '-1',
    )
  })

  it('the <ul> carries its own zone+kind-scoped testid, independent of the heading’s', () => {
    render(
      <PendingKindSection
        kind="PROJECT_APPROVAL"
        title="Проєкти"
        icon={Briefcase}
        items={[item({ subjectId: 'p1' })]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('pending-kind-section-mine-PROJECT_APPROVAL')).toBeInTheDocument()
  })

  // task-i18n-stage2-task8 (audit §2, COPY-M-docs): the heading/list testid
  // must be stable across locales — `title` will be a translated string once
  // extraction lands, but `kind` never changes. `items` here is `[]` on
  // purpose (this component "рендерится только если непуста" — see the
  // first test above) so this test proves the testid identity independently
  // of any row content, using a DIFFERENT kind+title pair than every other
  // test in this file to rule out a hardcoded 'PROJECT_APPROVAL'/'Проєкти'
  // match surviving the refactor by coincidence.
  it('heading testid does not depend on the visible title', () => {
    render(
      <PendingKindSection
        kind="PROJECT_APPROVAL"
        title="Будь-який текст"
        icon={Briefcase}
        items={[item({ subjectId: 'p1' })]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('pending-kind-heading-mine-PROJECT_APPROVAL')).toBeInTheDocument()
    expect(screen.getByTestId('pending-kind-heading-mine-PROJECT_APPROVAL')).toHaveTextContent(
      'Будь-який текст',
    )
  })
})

describe('PendingKindSection — locale independence of the selectors', () => {
  it('the same heading testid under uk and en titles — a translation never moves a selector', () => {
    const { unmount } = render(
      <PendingKindSection
        kind="PROJECT_APPROVAL"
        title="Проєкти"
        icon={Briefcase}
        items={[item({})]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    const ukTestId = screen
      .getByRole('heading', { level: 3, name: 'Проєкти' })
      .getAttribute('data-testid')
    unmount()
    render(
      <PendingKindSection
        kind="PROJECT_APPROVAL"
        title="Projects"
        icon={Briefcase}
        items={[item({})]}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    const enTestId = screen
      .getByRole('heading', { level: 3, name: 'Projects' })
      .getAttribute('data-testid')
    expect(ukTestId).toBe('pending-kind-heading-mine-PROJECT_APPROVAL')
    expect(enTestId).toBe(ukTestId)
  })
})
