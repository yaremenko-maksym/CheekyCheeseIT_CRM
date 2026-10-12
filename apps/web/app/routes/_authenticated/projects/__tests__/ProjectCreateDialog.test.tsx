/**
 * Characterization of the create-project dialog + form hook extracted from the
 * projects list route (`projects/index.tsx`). Mounted through a tiny harness that
 * wires `useCreateProjectForm` into `ProjectCreateDialog` exactly like the page does.
 * Expected values are hand-written literals.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }), post },
}))

import { ProjectCreateDialog } from '../components/ProjectCreateDialog'
import { useCreateProjectForm } from '../use-create-project-form'

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'
const DROP_ID = '22222222-2222-4222-8222-222222222222'
const SENIORS = [{ id: SENIOR_ID, displayName: 'Sen One' }]
const DROPS = [{ id: DROP_ID, displayName: 'Drop One' }]

function Harness({
  canEditPaymentType,
  dropUsers,
  onOpenChange,
}: {
  canEditPaymentType: boolean
  dropUsers: { id: string; displayName: string }[]
  onOpenChange: (open: boolean) => void
}) {
  const [showCreate, setShow] = useState(true)
  const setShowCreate = (open: boolean) => {
    onOpenChange(open)
    setShow(open)
  }
  const { createForm, createMutation } = useCreateProjectForm({
    canEditPaymentType,
    setShowCreate,
  })
  return (
    <ProjectCreateDialog
      showCreate={showCreate}
      setShowCreate={setShowCreate}
      createForm={createForm}
      createMutation={createMutation}
      canEditPaymentType={canEditPaymentType}
      seniorUsers={SENIORS}
      dropUsers={dropUsers}
    />
  )
}

function mount(opts: { canEditPaymentType?: boolean; dropUsers?: typeof DROPS } = {}) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <I18nTestProvider>
        <Harness
          canEditPaymentType={opts.canEditPaymentType ?? true}
          dropUsers={opts.dropUsers ?? []}
          onOpenChange={onOpenChange}
        />
      </I18nTestProvider>
    </QueryClientProvider>,
  )
  return { invalidate, onOpenChange }
}

function seniorSelect(): HTMLElement {
  const found = screen
    .getAllByRole('combobox')
    .find((el) => within(el).queryByText('— виберіть сеньйора —') !== null)
  if (!found) throw new Error('senior select not found')
  return found
}

function fillRequired() {
  fireEvent.change(screen.getByPlaceholderText('AI Platform v2'), { target: { value: ' Proj ' } })
  fireEvent.change(screen.getByPlaceholderText('TechCorp AI'), { target: { value: ' Acme ' } })
  const senior = seniorSelect()
  fireEvent.change(senior, { target: { value: SENIOR_ID } })
  fireEvent.change(screen.getByPlaceholderText('5000'), { target: { value: '1200' } })
}

describe('ProjectCreateDialog + useCreateProjectForm', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    post.mockResolvedValue({ data: { id: 'p-1' } })
    await loadCatalog('uk')
  })
  afterEach(() => cleanup())

  it('submits a trimmed body without dropId and with paymentType for ADMIN/ACCOUNTANT', async () => {
    const { invalidate, onOpenChange } = mount({ canEditPaymentType: true })
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/projects')
    expect(body).toMatchObject({
      name: 'Proj',
      companyName: 'Acme',
      domain: 'Other',
      seniorId: SENIOR_ID,
      rate: 1200,
      currency: 'USDT',
      paymentType: 'FOP',
      techStack: null,
      teamSize: null,
      benefits: null,
      salaryReview: null,
      corpTech: null,
      notesGeneral: null,
      logoDocumentId: null,
      logoExternalUrl: null,
    })
    expect('dropId' in body).toBe(false)
    expect(typeof body.startDate).toBe('string')
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('omits paymentType for viewers who cannot edit it and shows the hint', async () => {
    mount({ canEditPaymentType: false })
    expect(screen.getByText('Змінювати може тільки адмін або бухгалтер.')).toBeTruthy()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const body = post.mock.calls[0]![1] as Record<string, unknown>
    expect('paymentType' in body).toBe(false)
  })

  it('hides the hint for privileged viewers', () => {
    mount({ canEditPaymentType: true })
    expect(screen.queryByText('Змінювати може тільки адмін або бухгалтер.')).toBeNull()
  })

  it('renders the drop select only when drop users exist and sends the chosen dropId', async () => {
    mount({ dropUsers: DROPS })
    fillRequired()
    fireEvent.change(screen.getByTestId('create-project-drop-select'), {
      target: { value: DROP_ID },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect((post.mock.calls[0]![1] as Record<string, unknown>).dropId).toBe(DROP_ID)
  })

  it('has no drop select when there are no drop users', () => {
    mount({ dropUsers: [] })
    expect(screen.queryByTestId('create-project-drop-select')).toBeNull()
  })

  it('shows the senior validation message after blur on an empty senior', () => {
    mount()
    const senior = seniorSelect()
    fireEvent.blur(senior)
    expect(screen.getByText('Виберіть сеньйора')).toBeTruthy()
  })

  it('Cancel closes the dialog without submitting', () => {
    const { onOpenChange } = mount()
    const name = screen.getByPlaceholderText('AI Platform v2') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Typed' } })
    expect(name.value).toBe('Typed')
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(post).not.toHaveBeenCalled()
  })
})
