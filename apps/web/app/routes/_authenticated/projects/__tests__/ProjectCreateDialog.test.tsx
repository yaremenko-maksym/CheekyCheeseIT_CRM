/**
 * Characterization of the create-project dialog + form hook extracted from the
 * projects list route (`projects/index.tsx`). Mounted through a tiny harness that
 * wires `useCreateProjectForm` into `ProjectCreateDialog` exactly like the page does.
 * Expected values are hand-written literals.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

type CreateForm = ReturnType<typeof useCreateProjectForm>['createForm']

let formHandle: CreateForm | null = null
let dialogOpen = true

function Harness({
  canEditPaymentType,
  dropUsers,
}: {
  canEditPaymentType: boolean
  dropUsers: { id: string; displayName: string }[]
}) {
  const [showCreate, setShow] = useState(true)
  const setShowCreate = (open: boolean) => {
    dialogOpen = open
    setShow(open)
  }
  const { createForm, createMutation } = useCreateProjectForm({
    canEditPaymentType,
    setShowCreate,
  })
  formHandle = createForm
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
  render(
    <QueryClientProvider client={qc}>
      <I18nTestProvider>
        <Harness
          canEditPaymentType={opts.canEditPaymentType ?? true}
          dropUsers={opts.dropUsers ?? []}
        />
      </I18nTestProvider>
    </QueryClientProvider>,
  )
  return { invalidate }
}

function form(): CreateForm {
  if (!formHandle) throw new Error('form not mounted')
  return formHandle
}

function setValue(name: string, value: unknown) {
  act(() => {
    ;(form() as unknown as { setFieldValue: (n: string, v: unknown) => void }).setFieldValue(
      name,
      value,
    )
  })
}

function seniorSelect(): HTMLSelectElement {
  const found = screen
    .getAllByRole('combobox')
    .find((el) => within(el).queryByText('— виберіть сеньйора —') !== null)
  if (!found) throw new Error('senior select not found')
  return found as HTMLSelectElement
}

function domainSelect(): HTMLSelectElement {
  const found = screen
    .getAllByRole('combobox')
    .find((el) => within(el).queryByText('FinTech') !== null)
  if (!found) throw new Error('domain select not found')
  return found as HTMLSelectElement
}

/** The six free-text boxes with an empty placeholder, in DOM order. */
function freeTextBoxes(): HTMLElement[] {
  const boxes = screen.getAllByRole('textbox').filter((el) => el.getAttribute('placeholder') === '')
  expect(boxes).toHaveLength(6)
  return boxes
}

function destructiveParagraphs(): number {
  return document.querySelectorAll('p.text-destructive').length
}

function fillRequired() {
  fireEvent.change(screen.getByPlaceholderText('AI Platform v2'), { target: { value: ' Proj ' } })
  fireEvent.change(screen.getByPlaceholderText('TechCorp AI'), { target: { value: ' Acme ' } })
  fireEvent.change(seniorSelect(), { target: { value: SENIOR_ID } })
  fireEvent.change(screen.getByTestId('amount-currency-amount-input'), {
    target: { value: '1200' },
  })
}

async function submitAndGetBody(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: 'Створити' }))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>]
  expect(url).toBe('/projects')
  return body
}

describe('ProjectCreateDialog + useCreateProjectForm', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-05T10:00:00Z'))
    formHandle = null
    dialogOpen = true
    post.mockResolvedValue({ data: { id: 'p-1' } })
    await loadCatalog('uk')
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders every title, label and button text', () => {
    mount({ dropUsers: DROPS, canEditPaymentType: false })
    expect(screen.getByRole('dialog', { name: 'Новий проєкт' })).toBeInTheDocument()
    expect(screen.getByText('Створення проєкту')).toBeInTheDocument()
    for (const text of [
      'Логотип компанії',
      'Назва проєкту',
      'Компанія',
      'Домен',
      'Сеньйор',
      'Дроп (опційно)',
      'Якщо обрано — надходження за проєктом підуть через дропа (частка 5% за замовчуванням).',
      'Ставка',
      'Дата початку',
      'Стек технологій',
      'Склад команди',
      'Бенефіти',
      'Тип оплати',
      'Перегляд ЗП',
      'Корп. техніка',
      'Загальні примітки',
      'Скасувати',
      'Створити',
      '— виберіть сеньйора —',
      '— не обрано —',
      'Змінювати може тільки адмін або бухгалтер.',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
    expect(screen.getByTestId('create-project-logo')).toBeInTheDocument()
  })

  it('starts empty: blank name/company/senior, default date and USDT/FOP defaults', () => {
    mount()
    expect(screen.getByPlaceholderText('AI Platform v2')).toHaveValue('')
    expect(screen.getByPlaceholderText('TechCorp AI')).toHaveValue('')
    expect(seniorSelect()).toHaveValue('')
    expect(screen.getByDisplayValue('2026-03-05')).toBeInTheDocument()
    expect(screen.getByTestId('amount-currency-amount-input')).toHaveValue('')
    expect(destructiveParagraphs()).toBe(0)
  })

  it('submits a trimmed body without dropId and with paymentType for ADMIN/ACCOUNTANT', async () => {
    const { invalidate } = mount({ canEditPaymentType: true })
    fillRequired()
    expect(screen.getByTestId('amount-currency-amount-input')).toHaveValue('1200')
    const body = await submitAndGetBody()
    expect(body).toStrictEqual({
      name: 'Proj',
      companyName: 'Acme',
      domain: 'Other',
      logoDocumentId: null,
      logoExternalUrl: null,
      seniorId: SENIOR_ID,
      rate: 1200,
      currency: 'USDT',
      startDate: '2026-03-05T00:00:00.000Z',
      techStack: null,
      teamSize: null,
      benefits: null,
      paymentType: 'FOP',
      salaryReview: null,
      corpTech: null,
      notesGeneral: null,
    })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] }))
    await waitFor(() => expect(dialogOpen).toBe(false))
    expect(form().state.values.name).toBe('')
  })

  it('trims every free-text field and turns blank ones into null', async () => {
    mount()
    fillRequired()
    const boxes = freeTextBoxes()
    fireEvent.change(boxes[0]!, { target: { value: '  Go  ' } })
    fireEvent.change(boxes[1]!, { target: { value: '   ' } })
    fireEvent.change(boxes[2]!, { target: { value: ' Gym ' } })
    fireEvent.change(boxes[3]!, { target: { value: '   ' } })
    fireEvent.change(boxes[4]!, { target: { value: ' Mac ' } })
    fireEvent.change(boxes[5]!, { target: { value: ' Notes ' } })
    const body = await submitAndGetBody()
    expect(body).toMatchObject({
      techStack: 'Go',
      teamSize: null,
      benefits: 'Gym',
      salaryReview: null,
      corpTech: 'Mac',
      notesGeneral: 'Notes',
    })
  })

  it('sends the typed start date, domain and payment type', async () => {
    mount()
    fillRequired()
    fireEvent.change(screen.getByDisplayValue('2026-03-05'), { target: { value: '2026-04-10' } })
    fireEvent.change(domainSelect(), { target: { value: 'FinTech' } })
    fireEvent.click(screen.getByTestId('project-payment-type-trigger'))
    fireEvent.click(screen.getByText('гіг-контракт'))
    const body = await submitAndGetBody()
    expect(body).toMatchObject({
      startDate: '2026-04-10T00:00:00.000Z',
      domain: 'FinTech',
      paymentType: 'GIG_CONTRACT',
    })
  })

  it('sends the chosen currency', async () => {
    mount()
    fillRequired()
    const trigger = screen.getAllByRole('combobox').find((el) => el.textContent === 'USDT')!
    fireEvent.click(trigger)
    fireEvent.click(within(screen.getByRole('listbox')).getByText('EUR'))
    const body = await submitAndGetBody()
    expect(body).toMatchObject({ currency: 'EUR', rate: 1200 })
  })

  it('sends the logo URL and feeds the form value back into the upload field', async () => {
    post.mockReturnValue(new Promise(() => {}))
    mount()
    fillRequired()
    setValue('logoExternalUrl', 'https://a.test/l.png')
    fireEvent.click(screen.getByRole('button', { name: 'Створити' }))
    // the pending mutation re-renders the dialog, which re-reads the form's logo value
    await screen.findByRole('button', { name: 'Створення…' })
    expect(post.mock.calls[0]![1]).toMatchObject({
      logoDocumentId: null,
      logoExternalUrl: 'https://a.test/l.png',
    })
    fireEvent.click(screen.getByTestId('image-upload-field-mode-url'))
    expect(screen.getByTestId('image-upload-field-url-input')).toHaveValue('https://a.test/l.png')
  })

  it('stores a logo picked through the upload field in the form', () => {
    mount()
    fireEvent.click(screen.getByTestId('image-upload-field-mode-url'))
    const input = screen.getByTestId('image-upload-field-url-input')
    fireEvent.change(input, { target: { value: 'https://b.test/x.png' } })
    fireEvent.blur(input)
    expect(form().state.values.logoExternalUrl).toBe('https://b.test/x.png')
    expect(form().state.values.logoDocumentId).toBeNull()
  })

  it('omits paymentType for viewers who cannot edit it and disables the select', async () => {
    mount({ canEditPaymentType: false })
    expect(screen.getByTestId('project-payment-type-trigger')).toBeDisabled()
    fillRequired()
    const body = await submitAndGetBody()
    expect('paymentType' in body).toBe(false)
  })

  it('enables the payment type select and hides the hint for privileged viewers', () => {
    mount({ canEditPaymentType: true })
    expect(screen.getByTestId('project-payment-type-trigger')).not.toBeDisabled()
    expect(screen.queryByText('Змінювати може тільки адмін або бухгалтер.')).toBeNull()
  })

  it('shows the payment type placeholder when no type is selected', () => {
    mount()
    setValue('paymentType', '')
    expect(screen.getByText('Виберіть тип оплати')).toBeInTheDocument()
  })

  it('renders the drop select only when drop users exist and sends the chosen dropId', async () => {
    mount({ dropUsers: DROPS })
    fillRequired()
    fireEvent.change(screen.getByTestId('create-project-drop-select'), {
      target: { value: DROP_ID },
    })
    const body = await submitAndGetBody()
    expect(body.dropId).toBe(DROP_ID)
  })

  it('trims the dropId before sending', async () => {
    mount({ dropUsers: DROPS })
    fillRequired()
    setValue('dropId', ` ${DROP_ID} `)
    const body = await submitAndGetBody()
    expect(body.dropId).toBe(DROP_ID)
  })

  it('treats a blank dropId as no drop', async () => {
    mount({ dropUsers: DROPS })
    fillRequired()
    setValue('dropId', '   ')
    const body = await submitAndGetBody()
    expect('dropId' in body).toBe(false)
  })

  it('has no drop select when there are no drop users', () => {
    mount({ dropUsers: [] })
    expect(screen.queryByTestId('create-project-drop-select')).toBeNull()
  })

  it('flags an empty name and company on blur, then clears the flag styling when valid', () => {
    mount()
    const name = screen.getByPlaceholderText('AI Platform v2')
    const company = screen.getByPlaceholderText('TechCorp AI')
    expect(screen.getByText('Назва проєкту').className).not.toContain('text-destructive')
    expect(name.className).not.toContain('border-destructive')
    expect(screen.getByText('Компанія').className).not.toContain('text-destructive')
    expect(company.className).not.toContain('border-destructive')

    fireEvent.change(name, { target: { value: '   ' } })
    fireEvent.blur(name)
    fireEvent.change(company, { target: { value: '   ' } })
    fireEvent.blur(company)

    expect(destructiveParagraphs()).toBe(2)
    expect(screen.getByText('Назва проєкту').className).toContain('text-destructive')
    expect(name.className).toContain('border-destructive')
    expect(name.className).toContain('focus-visible:ring-destructive/30')
    expect(screen.getByText('Компанія').className).toContain('text-destructive')
    expect(company.className).toContain('border-destructive')

    fireEvent.change(name, { target: { value: 'Ok' } })
    fireEvent.blur(name)
    expect(destructiveParagraphs()).toBe(1)
    expect(name.className).not.toContain('border-destructive')
  })

  it('shows the senior validation message after blur on an empty senior', () => {
    mount()
    const senior = seniorSelect()
    expect(senior.className).toContain('rounded-md')
    expect(senior.className).toContain('border-input')
    expect(screen.getByText('Сеньйор').className).not.toContain('text-destructive')
    fireEvent.blur(senior)
    const message = screen.getByText('Виберіть сеньйора')
    expect(message.tagName).toBe('P')
    expect(message.className).toContain('text-xs text-destructive')
    expect(senior.className).toContain('border-destructive')
    expect(senior.className).not.toContain('border-input')
    expect(screen.getByText('Сеньйор').className).toContain('text-destructive')
    fireEvent.change(senior, { target: { value: SENIOR_ID } })
    fireEvent.blur(senior)
    expect(screen.queryByText('Виберіть сеньйора')).toBeNull()
    expect(destructiveParagraphs()).toBe(0)
  })

  it('shows "Створення…" and disables submit while the request is pending', async () => {
    post.mockReturnValue(new Promise(() => {}))
    mount()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Створити' }))
    const pending = await screen.findByRole('button', { name: 'Створення…' })
    expect(pending).toBeDisabled()
    expect(pending).toHaveAttribute('data-track', 'project-create')
  })

  it('Cancel closes the dialog, resets entered values and does not submit', () => {
    mount()
    const name = screen.getByPlaceholderText('AI Platform v2')
    fireEvent.change(name, { target: { value: 'Typed' } })
    expect(name).toHaveValue('Typed')
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(dialogOpen).toBe(false)
    expect(form().state.values.name).toBe('')
    expect(post).not.toHaveBeenCalled()
  })
})
