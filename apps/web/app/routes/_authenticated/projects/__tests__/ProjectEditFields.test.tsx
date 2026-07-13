/**
 * task-drop-share-override-and-receiver — Surface A (drop-share ShareSlider)
 * + Surface C (paymentType Select) interaction tests for `ProjectEditFields`.
 *
 * `ProjectEditFields` is a subcomponent of the 2000-line `$projectId.tsx`
 * route page — exported (test-only addition, no behavior change) so these
 * interaction tests can mount it directly with a minimal `useForm` harness
 * instead of rendering the entire route.
 *
 * Pins:
 * 1. Surface A — drop-share section renders ONLY when `dropId != null`, and
 *    only for viewers who are neither HR nor JUNIOR; ADMIN/ACCOUNTANT edit,
 *    everyone else sees it disabled.
 * 2. Surface A — changing the slider makes the form dirty and the value
 *    reaches submit.
 * 3. Surface C — the "Тип оплаты" Select renders 3 options; ADMIN/ACCOUNTANT
 *    edit, everyone else (who can still open the dialog — HR) sees it
 *    disabled with a hint.
 * 4. Surface C — selecting an option makes the form dirty and the value
 *    reaches submit.
 */
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useForm } from '@tanstack/react-form'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectEditFields } from '../$projectId'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

type HarnessValues = {
  name: string
  companyName: string
  domain: string
  logoDocumentId: string | null
  logoExternalUrl: string | null
  rate: number
  currency: string
  seniorSharePercentOverride: number | null
  dropSharePercentOverride: number | null
  techStack: string
  teamSize: string
  benefits: string
  paymentType: string
  salaryReview: string
  corpTech: string
  notesGeneral: string
}

const defaultHarnessValues: HarnessValues = {
  name: 'AI Platform',
  companyName: 'TechCorp',
  domain: 'Other',
  logoDocumentId: null,
  logoExternalUrl: null,
  rate: 5000,
  currency: 'USDT',
  seniorSharePercentOverride: null,
  dropSharePercentOverride: null,
  techStack: '',
  teamSize: '',
  benefits: '',
  paymentType: 'FOP',
  salaryReview: '',
  corpTech: '',
  notesGeneral: '',
}

function Harness({
  onSubmit,
  canEditOverride,
  dropId,
  viewerRole,
  defaultDropSharePercent = 5,
}: {
  onSubmit: (values: HarnessValues) => void
  canEditOverride: boolean
  dropId: string | null
  viewerRole: string | undefined
  defaultDropSharePercent?: number
}) {
  const form = useForm({
    defaultValues: defaultHarnessValues,
    onSubmit: async ({ value }) => onSubmit(value),
  })
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ProjectEditFields
        form={form}
        mode="info"
        canEditOverride={canEditOverride}
        defaultSharePercent={26}
        defaultDropSharePercent={defaultDropSharePercent}
        dropId={dropId}
        viewerRole={viewerRole}
        projectId="project-1"
      />
      <button type="button" data-testid="harness-submit" onClick={() => void form.handleSubmit()}>
        Submit
      </button>
    </QueryClientProvider>
  )
}

describe('ProjectEditFields — Surface A (drop-share ShareSlider)', () => {
  it('renders the section when dropId is set and viewer is ADMIN (editable)', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId="drop-1" viewerRole="ADMIN" />)
    expect(screen.getByTestId('project-edit-drop-share-section')).toBeInTheDocument()
    const input = screen.getByTestId('project-edit-drop-share-override')
    expect(input).not.toBeDisabled()
  })

  it('hides the section entirely when dropId is null (not a drop-project)', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    expect(screen.queryByTestId('project-edit-drop-share-section')).not.toBeInTheDocument()
  })

  it('hides the section for HR viewers even on a drop-project', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={false} dropId="drop-1" viewerRole="HR" />)
    expect(screen.queryByTestId('project-edit-drop-share-section')).not.toBeInTheDocument()
  })

  it('hides the section for JUNIOR viewers even on a drop-project', () => {
    render(
      <Harness onSubmit={vi.fn()} canEditOverride={false} dropId="drop-1" viewerRole="JUNIOR" />,
    )
    expect(screen.queryByTestId('project-edit-drop-share-section')).not.toBeInTheDocument()
  })

  it('shows the section disabled (read-only) for SENIOR/DROP viewers', () => {
    render(
      <Harness onSubmit={vi.fn()} canEditOverride={false} dropId="drop-1" viewerRole="SENIOR" />,
    )
    const section = screen.getByTestId('project-edit-drop-share-section')
    expect(section).toBeInTheDocument()
    expect(screen.getByTestId('project-edit-drop-share-override')).toBeDisabled()
    expect(
      within(section).getByText('Менять может только ADMIN или ACCOUNTANT.'),
    ).toBeInTheDocument()
  })

  it('defaults the slider value to defaultDropSharePercent when no override is set', () => {
    render(
      <Harness
        onSubmit={vi.fn()}
        canEditOverride={true}
        dropId="drop-1"
        viewerRole="ADMIN"
        defaultDropSharePercent={7}
      />,
    )
    expect(screen.getByTestId('project-edit-drop-share-override')).toHaveValue(7)
  })

  it('changing the slider value makes the form dirty and reaches submit', async () => {
    const onSubmit = vi.fn()
    render(
      <Harness onSubmit={onSubmit} canEditOverride={true} dropId="drop-1" viewerRole="ADMIN" />,
    )
    const input = screen.getByTestId('project-edit-drop-share-override')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('harness-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ dropSharePercentOverride: 12 })
  })
})

describe('ProjectEditFields — Surface C (paymentType Select)', () => {
  it('renders 3 payment-type options, editable for ADMIN', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    const trigger = screen.getByTestId('project-payment-type-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger).not.toBeDisabled()
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getByText('ФОП')).toBeInTheDocument()
    expect(within(listbox).getByText('гіг-контракт')).toBeInTheDocument()
    expect(within(listbox).getByText('USDT')).toBeInTheDocument()
  })

  it('is disabled with a hint for non-ADMIN/ACCOUNTANT viewers (e.g. HR)', () => {
    render(<Harness onSubmit={vi.fn()} canEditOverride={false} dropId={null} viewerRole="HR" />)
    expect(screen.getByTestId('project-payment-type-trigger')).toBeDisabled()
    expect(screen.getByText('Менять может только ADMIN или ACCOUNTANT.')).toBeInTheDocument()
  })

  it('selecting an option makes the form dirty and reaches submit', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} canEditOverride={true} dropId={null} viewerRole="ADMIN" />)
    fireEvent.click(screen.getByTestId('project-payment-type-trigger'))
    fireEvent.click(screen.getByText('гіг-контракт'))
    fireEvent.click(screen.getByTestId('harness-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ paymentType: 'GIG_CONTRACT' })
  })
})
