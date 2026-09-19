/**
 * task-projects-followups-web (backlog 201, AC5).
 *
 * `ProjectHeaderApprovalNote` is exported from `$projectId.tsx` for exactly
 * the reason `InfoRow` / `ProjectEditFields` / `PendingShareApprovalBanner`
 * in the same file already are (see that banner's own doc): mounting the
 * whole 2000+-line route to read one <p> would test the router, not this
 * component. No router / no QueryClient needed — this component has neither
 * a `<Link>` nor a `useMutation` call.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProjectApprovalCaptionInput } from '@/components/projects/project-approval-caption'
import { ProjectHeaderApprovalNote } from '../$projectId'

const SENIOR_ID = '00000000-0000-0000-0000-0000000000b1'
const DROP_ID = '00000000-0000-0000-0000-0000000000b2'

function makeProject(
  overrides: Partial<ProjectApprovalCaptionInput> = {},
): ProjectApprovalCaptionInput {
  return {
    status: 'DRAFT',
    rejectionReason: null,
    seniorId: SENIOR_ID,
    seniorName: 'Oleksiy Kovalenko',
    dropId: null,
    dropName: null,
    seniorApprovalPending: true,
    dropApprovalPending: undefined,
    ...overrides,
  }
}

describe('ProjectHeaderApprovalNote', () => {
  it('REJECTED with a reason — the reason is visible, quoted, under the badge', () => {
    render(
      <ProjectHeaderApprovalNote
        project={makeProject({ status: 'REJECTED', rejectionReason: 'нет бюджета на Q3' })}
      />,
    )
    const reason = screen.getByTestId('project-header-rejection-reason')
    expect(reason).toHaveTextContent('«нет бюджета на Q3»')
    expect(reason).toHaveAttribute('title', 'нет бюджета на Q3')
  })

  it('REJECTED, no reason on the DTO (masked for this viewer, SR-M-5) — renders nothing', () => {
    render(<ProjectHeaderApprovalNote project={makeProject({ status: 'REJECTED' })} />)
    expect(screen.queryByTestId('project-header-rejection-reason')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-header-approval-caption')).not.toBeInTheDocument()
  })

  it('DRAFT, both approvers still pending — «Ждём …» caption (третье лицо)', () => {
    render(
      <ProjectHeaderApprovalNote
        project={makeProject({
          dropId: DROP_ID,
          dropName: 'Nadiya Dropivska',
          dropApprovalPending: true,
        })}
      />,
    )
    const caption = screen.getByTestId('project-header-approval-caption')
    expect(caption).toHaveTextContent('от Nadiya Dropivska и Oleksiy Kovalenko')
  })

  it('DRAFT, viewer already confirmed — first-person «Вы подтвердили. Ждём …» caption', () => {
    render(
      <ProjectHeaderApprovalNote
        project={makeProject({
          dropId: DROP_ID,
          dropName: 'Nadiya Dropivska',
          seniorApprovalPending: false,
          dropApprovalPending: true,
        })}
        viewerId={SENIOR_ID}
      />,
    )
    const caption = screen.getByTestId('project-header-approval-caption')
    expect(caption).toHaveTextContent('Вы подтвердили. Ждём дропа')
  })

  it('ACTIVE — neither the reason nor the caption renders', () => {
    render(<ProjectHeaderApprovalNote project={makeProject({ status: 'ACTIVE' })} />)
    expect(screen.queryByTestId('project-header-rejection-reason')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-header-approval-caption')).not.toBeInTheDocument()
  })
})
