/**
 * task-pending-screen design spec §6. `PendingItemRow` is the switch on
 * `item.kind` — tested in isolation from the real action components (each
 * has its own test file: ProjectApprovalActions.test.tsx,
 * SeniorShareApprovalActions.test.tsx, cancel-pending-share.test.tsx), so
 * these tests mock them as thin stand-ins and assert WHICH one gets
 * rendered with WHICH props, plus the title/meta text this file itself
 * owns (§6.1-6.5).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PendingItem } from '@/hooks/use-pending-items'
import { PendingItemRow } from '../PendingItemRow'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@/components/projects/ProjectApprovalActions', () => ({
  ProjectApprovalActions: (props: { projectId: string; companyName: string }) => (
    <div data-testid="stub-project-approval-actions">
      {props.projectId}:{props.companyName}
    </div>
  ),
}))

vi.mock('@/components/pending/SeniorShareApprovalActions', () => ({
  SeniorShareApprovalActions: (props: { scope: string; id: string }) => (
    <div data-testid="stub-senior-share-approval-actions">
      {props.scope}:{props.id}
    </div>
  ),
}))

vi.mock('@/components/pending-share/cancel-pending-share', () => ({
  CancelPendingShareButton: (props: { scope: string; id: string; pendingPercent: number }) => (
    <div data-testid="stub-cancel-pending-share">
      {props.scope}:{props.id}:{props.pendingPercent}
    </div>
  ),
}))

function item(overrides: Partial<PendingItem>): PendingItem {
  return {
    kind: 'PROJECT_APPROVAL',
    subjectId: 'subj-1',
    title: 'Acme Corp',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // ~2 days ago
    actions: ['approve', 'reject', 'open'],
    link: '/projects/subj-1',
    ...overrides,
  }
}

describe('PendingItemRow — PROJECT_APPROVAL', () => {
  it('mine: title + "Предложил X · давность", renders ProjectApprovalActions', () => {
    render(
      <PendingItemRow
        item={item({ proposedBy: 'Олексій Коваленко' })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText(/^Предложил Олексій Коваленко ·/)).toBeInTheDocument()
    expect(screen.getByTestId('stub-project-approval-actions')).toHaveTextContent(
      'subj-1:Acme Corp',
    )
  })

  it('mine, no proposedBy (fail-safe): renders only давность, no "Предложил"', () => {
    // `exactOptionalPropertyTypes` rejects `{ proposedBy: undefined }` (an
    // explicit undefined value differs from the key being absent) —
    // destructuring it off is what actually omits the key.
    const { proposedBy: _unused, ...withoutProposedBy } = item({})
    render(<PendingItemRow item={withoutProposedBy} zone="mine" onActed={vi.fn()} />)
    expect(screen.queryByText(/^Предложил/)).not.toBeInTheDocument()
  })

  it('proposedByMe: "Ждём: X · давность", renders only Открыть (no revoke endpoint for a project draft)', () => {
    render(
      <PendingItemRow
        item={item({ waitingFor: ['Ірина Савенко'], actions: ['open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText(/^Ждём: Ірина Савенко ·/)).toBeInTheDocument()
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId(`pending-item-open-subj-1`)).toBeInTheDocument()
  })

  it('actions missing approve/reject falls back to Открыть-only, even in `mine`', () => {
    render(<PendingItemRow item={item({ actions: ['open'] })} zone="mine" onActed={vi.fn()} />)
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })
})

describe('PendingItemRow — SHARE_APPROVAL', () => {
  it('mine, with currentPercent: "Сейчас X% → предлагают Y% · давность", renders SeniorShareApprovalActions', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          title: 'Доля по умолчанию',
          currentPercent: 26,
          pendingPercent: 30,
          subjectType: 'USER_SENIOR_SHARE',
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText(/^Сейчас 26% → предлагают 30% ·/)).toBeInTheDocument()
    expect(screen.getByTestId('stub-senior-share-approval-actions')).toHaveTextContent(
      'user:subj-1',
    )
  })

  it('mine, currentPercent absent (defensive): "Предлагают Y% · давность", no "Сейчас … →"', () => {
    const { currentPercent: _unused, ...withoutCurrentPercent } = item({
      kind: 'SHARE_APPROVAL',
      pendingPercent: 30,
    })
    render(<PendingItemRow item={withoutCurrentPercent} zone="mine" onActed={vi.fn()} />)
    expect(screen.getByText(/^Предлагают 30% ·/)).toBeInTheDocument()
    expect(screen.queryByText(/Сейчас/)).not.toBeInTheDocument()
  })

  it('subjectType PROJECT_SENIOR_SHARE (or absent) maps to scope="project"', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          pendingPercent: 30,
          subjectType: 'PROJECT_SENIOR_SHARE',
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('stub-senior-share-approval-actions')).toHaveTextContent(
      'project:subj-1',
    )
  })

  it('proposedByMe: "Сейчас X% → предлагают Y% · ждём: NAME · давность", renders CancelPendingShareButton with the resolved percent', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          currentPercent: 26,
          pendingPercent: 30,
          waitingFor: ['Олексій Коваленко'],
          actions: ['cancel'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(
      screen.getByText(/^Сейчас 26% → предлагают 30% · ждём: Олексій Коваленко ·/),
    ).toBeInTheDocument()
    expect(screen.getByTestId('stub-cancel-pending-share')).toHaveTextContent('project:subj-1:30')
  })
})

describe('PendingItemRow — CONTRACT_TO_SIGN', () => {
  it('title + "готов к подписанию" badge as SEPARATE flex items, meta is давность only, single primary Открыть, no approve/reject', () => {
    render(
      <PendingItemRow
        item={item({ kind: 'CONTRACT_TO_SIGN', title: 'Контракт сотрудника', actions: ['open'] })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Контракт сотрудника')).toBeInTheDocument()
    expect(screen.getByText('готов к подписанию')).toBeInTheDocument()
    expect(screen.queryByText(/^Предложил/)).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
  })
})

describe('PendingItemRow — AC6: unknown kind never crashes', () => {
  it('renders a generic row (title or fallback text, давность, Открыть if offered) instead of throwing', () => {
    const weirdItem = {
      ...item({ actions: ['open'] }),
      kind: 'SOMETHING_NEW',
    } as unknown as PendingItem
    expect(() =>
      render(<PendingItemRow item={weirdItem} zone="mine" onActed={vi.fn()} />),
    ).not.toThrow()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })

  it('unknown kind with no actions renders no action at all (does not guess)', () => {
    const weirdItem = {
      ...item({ actions: [] }),
      kind: 'SOMETHING_NEW',
    } as unknown as PendingItem
    render(<PendingItemRow item={weirdItem} zone="mine" onActed={vi.fn()} />)
    expect(screen.queryByTestId('pending-item-open-subj-1')).not.toBeInTheDocument()
  })
})
