/* Node access: error paragraphs and the phone widget have no role/label to query, so they are reached by selector. */
/* eslint-disable testing-library/no-node-access, testing-library/prefer-presence-queries */
/**
 * HrCreateSeniorDialog — HR's "create senior" dialog on the team list page.
 * Extracted verbatim from `team/index.tsx` (pure move); this suite is the
 * behavior net for the extraction (the route file had no unit coverage).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Profiler } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// `hrCreateSeniorSchema.safeParse` is wrapped in a spy that defaults to the REAL schema; tests
// that need a specific verdict (a failure, or a recognisable parsed body) override it once.
vi.mock('@crm/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@crm/shared')>()
  return {
    ...actual,
    hrCreateSeniorSchema: {
      shape: actual.hrCreateSeniorSchema.shape,
      safeParse: vi.fn((p: unknown) => actual.hrCreateSeniorSchema.safeParse(p)),
    },
  }
})

// The real slider clamps to 1..100, so the dialog's own out-of-range
// validator is unreachable through it; this stub lets a test emit any value.
vi.mock('@/components/ui/share-slider', () => ({
  ShareSlider: ({
    value,
    onChange,
    onBlur,
    error,
  }: {
    value: number
    onChange: (v: number) => void
    onBlur?: () => void
    error?: boolean
  }) => (
    <div>
      <output data-testid="share-value">{String(value)}</output>
      <output data-testid="share-error">{String(error)}</output>
      <button type="button" onClick={() => onChange(1)}>
        share-1
      </button>
      <button type="button" onClick={() => onChange(100)}>
        share-100
      </button>
      <button type="button" onClick={() => onChange(0)}>
        share-0
      </button>
      <button type="button" onClick={() => onChange(101)}>
        share-101
      </button>
      <button type="button" onClick={() => onChange(40)}>
        share-40
      </button>
      <button type="button" onClick={onBlur}>
        share-blur
      </button>
    </div>
  ),
}))

import { toast } from 'sonner'
import { hrCreateSeniorSchema } from '@crm/shared'
import { api } from '@/lib/axios'
import { HrCreateSeniorDialog } from '../components/HrCreateSeniorDialog'

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const schemaSpy = vi.mocked(hrCreateSeniorSchema.safeParse)

const HR_ID = '11111111-1111-4111-8111-111111111111'
const ACC_A = '22222222-2222-4222-8222-222222222222'
const ACC_B = '44444444-4444-4444-8444-444444444444'
const ACCOUNTANT_A = {
  id: ACC_A,
  displayName: 'Anna Accountant',
  email: 'a@x.dev',
  role: 'ACCOUNTANT',
  avatarUrl: null,
  avatarDocumentId: null,
}
const ACCOUNTANT_B = { ...ACCOUNTANT_A, id: ACC_B, displayName: 'Boris Accountant' }
const SENIOR = {
  ...ACCOUNTANT_A,
  id: '33333333-3333-4333-8333-333333333333',
  displayName: 'Sam Senior',
  role: 'SENIOR',
}

function renderDialog(
  opts: { open?: boolean; users?: unknown[]; onClose?: () => void; hrUserId?: string } = {},
) {
  mockedGet.mockResolvedValue({ data: opts.users ?? [] } as never)
  const onClose = opts.onClose ?? vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const tree = (open: boolean) => (
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <HrCreateSeniorDialog open={open} onClose={onClose} hrUserId={opts.hrUserId ?? HR_ID} />
      </QueryClientProvider>
    </I18nTestProvider>
  )
  const utils = render(tree(opts.open ?? true))
  return {
    ...utils,
    qc,
    onClose,
    invalidate,
    rerenderWith: (open: boolean) => utils.rerender(tree(open)),
  }
}

const phoneEl = () => document.querySelector('input[type="tel"]') as HTMLInputElement

// Error text rendered under the field with the given label, or null.
function fieldError(label: string): string | null {
  const grid = screen.getByText(label).closest('div.grid')
  return grid?.querySelector('p.text-destructive')?.textContent ?? null
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('senior@cheekycheese.dev'), 'sen@cheeky.dev')
  // The phone widget pre-fills "+380", which the field validator rejects as incomplete;
  // a valid submit needs a full number or an emptied field.
  await user.clear(phoneEl())
  await user.type(phoneEl(), '+380501234567')
  await user.type(screen.getByPlaceholderText('Іван Іваненко'), '  Іван Сеньйор ')
}

beforeEach(async () => {
  vi.clearAllMocks()
  const actual = await vi.importActual<typeof import('@crm/shared')>('@crm/shared')
  schemaSpy.mockImplementation(((p: unknown) => actual.hrCreateSeniorSchema.safeParse(p)) as never)
  await loadCatalog('uk')
})

describe('HrCreateSeniorDialog rendering', () => {
  it('renders nothing and does not load users while closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByText('Створити сеньйора')).toBeNull()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('loads the user list from /users when open', async () => {
    renderDialog()
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/users'))
  })

  it('renders title, descriptions, fields, the HR auto block and the footer', () => {
    renderDialog()
    expect(screen.getByText('Створити сеньйора')).toBeTruthy()
    expect(screen.getByText('Створіть сеньйора та сформуйте команду.')).toBeTruthy()
    const hint = screen.getByText(
      'Буде створено акаунт сеньйора та сформовано команду з вами в ролі HR.',
    )
    expect(hint.className).toContain('text-muted-foreground')
    const email = screen.getByPlaceholderText('senior@cheekycheese.dev') as HTMLInputElement
    expect(email.type).toBe('email')
    expect(email.getAttribute('autocapitalize')).toBe('off')
    expect(email.getAttribute('autocorrect')).toBe('off')
    expect(email.getAttribute('spellcheck')).toBe('false')
    expect(email.getAttribute('autocomplete')).toBe('off')
    const name = screen.getByPlaceholderText('Іван Іваненко')
    expect(name.getAttribute('autocapitalize')).toBe('words')
    expect(name.getAttribute('autocomplete')).toBe('off')
    const tg = screen.getByPlaceholderText('@username')
    expect(tg.getAttribute('autocapitalize')).toBe('off')
    expect(tg.getAttribute('autocorrect')).toBe('off')
    expect(screen.getByPlaceholderText('Почніть вводити: React, Node.js…')).toBeTruthy()
    expect(screen.getByText('Email')).toBeTruthy()
    expect(screen.getByText('Ім’я та прізвище')).toBeTruthy()
    expect(screen.getByText('Технології')).toBeTruthy()
    expect(screen.getByText('Telegram')).toBeTruthy()
    expect(screen.getByText('Телефон')).toBeTruthy()
    expect(screen.getByText('Фінанси та команда')).toBeTruthy()
    expect(screen.getByText('Частка сеньйора (%)')).toBeTruthy()
    expect(screen.getByText('HR')).toBeTruthy()
    expect(screen.getByText('Ви')).toBeTruthy()
    expect(screen.getByText('авто')).toBeTruthy()
    expect(screen.getByText('Бухгалтер')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Створити' })).toBeTruthy()
  })

  it('marks email, name and share as required, not telegram/phone/tech', () => {
    renderDialog()
    expect(screen.getAllByText('*')).toHaveLength(3)
    expect(screen.getByText('Email').querySelector('span')?.textContent).toBe('*')
    expect(screen.getByText('Telegram').querySelector('span')).toBeNull()
  })

  it('defaults the senior share to 26', () => {
    renderDialog()
    expect(screen.getByTestId('share-value').textContent).toBe('26')
    expect(screen.getByTestId('share-error').textContent).toBe('false')
  })
})

describe('HrCreateSeniorDialog accountant selection', () => {
  it('shows the empty hint when there are no accountants', async () => {
    renderDialog({ users: [SENIOR] })
    expect(
      await screen.findByText('Бухгалтерів ще немає — зверніться до адміністратора'),
    ).toBeTruthy()
    expect(screen.queryByText(SENIOR.displayName)).toBeNull()
  })

  it('shows a single accountant as auto and submits their id', async () => {
    const user = userEvent.setup()
    renderDialog({ users: [SENIOR, ACCOUNTANT_A] })
    expect(await screen.findByText('Anna Accountant')).toBeTruthy()
    expect(screen.getAllByText('авто')).toHaveLength(2)
    expect(screen.queryByText('Sam Senior')).toBeNull()
    mockedPost.mockResolvedValue({ data: {} } as never)
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect(mockedPost.mock.calls[0]?.[1]).toMatchObject({ accountantId: ACC_A })
  })

  it('offers a select for several accountants and submits null until one is picked', async () => {
    const user = userEvent.setup()
    renderDialog({ users: [ACCOUNTANT_A, ACCOUNTANT_B] })
    const trigger = await screen.findByRole('combobox')
    expect(trigger.textContent).toContain('— оберіть бухгалтера —')
    expect(screen.queryByText('Бухгалтерів ще немає — зверніться до адміністратора')).toBeNull()
    mockedPost.mockResolvedValue({ data: {} } as never)
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect(mockedPost.mock.calls[0]?.[1]).toMatchObject({ accountantId: null })
  })

  it('submits the accountant chosen from the select', async () => {
    const user = userEvent.setup()
    renderDialog({ users: [ACCOUNTANT_A, ACCOUNTANT_B] })
    const trigger = await screen.findByRole('combobox')
    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: 'Boris Accountant' }))
    expect(screen.getByRole('combobox').textContent).toContain('Boris Accountant')
    mockedPost.mockResolvedValue({ data: {} } as never)
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect(mockedPost.mock.calls[0]?.[1]).toMatchObject({ accountantId: ACC_B })
  })

  it('re-derives the auto accountant each time the dialog reopens', async () => {
    const view = renderDialog({ users: [ACCOUNTANT_A] })
    expect(await screen.findByText('Anna Accountant')).toBeTruthy()
    view.rerenderWith(false)
    view.rerenderWith(true)
    expect(await screen.findByText('Anna Accountant')).toBeTruthy()
  })
})

describe('HrCreateSeniorDialog field validation on blur', () => {
  it('shows an email error only after blur, and clears it once valid', async () => {
    const user = userEvent.setup()
    renderDialog()
    const email = screen.getByPlaceholderText('senior@cheekycheese.dev')
    await user.type(email, 'not-an-email')
    expect(fieldError('Email')).toBeNull()
    await user.tab()
    expect(fieldError('Email')?.length).toBeGreaterThan(0)
    expect(email.className).toContain('border-destructive')
    expect(screen.getByText('Email').className).toContain('text-destructive')
    await user.clear(email)
    await user.type(email, 'ok@cheeky.dev')
    await user.tab()
    expect(fieldError('Email')).toBeNull()
    expect(email.className).not.toContain('border-destructive')
    expect(screen.getByText('Email').className).not.toContain('text-destructive')
  })

  it('shows a name error for an empty name after blur and clears it for a real one', async () => {
    const user = userEvent.setup()
    renderDialog()
    const name = screen.getByPlaceholderText('Іван Іваненко')
    await user.click(name)
    expect(fieldError('Ім’я та прізвище')).toBeNull()
    await user.tab()
    expect(fieldError('Ім’я та прізвище')?.length).toBeGreaterThan(0)
    expect(name.className).toContain('border-destructive')
    await user.type(name, 'Іван Іваненко')
    await user.tab()
    expect(fieldError('Ім’я та прізвище')).toBeNull()
    expect(name.className).not.toContain('border-destructive')
  })

  it('accepts an empty telegram and flags an over-long one', async () => {
    const user = userEvent.setup()
    renderDialog()
    const tg = screen.getByPlaceholderText('@username')
    await user.click(tg)
    await user.tab()
    expect(fieldError('Telegram')).toBeNull()
    await user.type(tg, 'a'.repeat(80))
    await user.tab()
    expect(fieldError('Telegram')?.length).toBeGreaterThan(0)
    expect(tg.className).toContain('border-destructive')
    await user.clear(tg)
    await user.type(tg, 'ok_name')
    await user.tab()
    expect(fieldError('Telegram')).toBeNull()
    expect(tg.className).not.toContain('border-destructive')
  })

  it('treats a whitespace-only telegram as empty (no error)', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByPlaceholderText('@username'), '   ')
    await user.tab()
    expect(fieldError('Telegram')).toBeNull()
  })

  it('pre-fills the phone widget with +380, flags it as incomplete and accepts a full number or none', async () => {
    const user = userEvent.setup()
    renderDialog()
    expect(phoneEl().value.replace(/\s/g, '')).toBe('+380')
    await user.click(phoneEl())
    await user.tab()
    expect(fieldError('Телефон')).toBe('Введіть номер у міжнародному форматі, напр. +380671234567')
    await user.clear(phoneEl())
    await user.type(phoneEl(), '+380501234567')
    await user.tab()
    expect(fieldError('Телефон')).toBeNull()
    await user.clear(phoneEl())
    await user.tab()
    expect(fieldError('Телефон')).toBeNull()
  })

  it('flags a share outside 1..100 on blur and passes an in-range one', async () => {
    const user = userEvent.setup()
    renderDialog()
    const label = 'Частка сеньйора (%)'
    await user.click(screen.getByRole('button', { name: 'share-0' }))
    await user.click(screen.getByRole('button', { name: 'share-blur' }))
    expect(fieldError(label)).toBe('Вкажіть від 1 до 100')
    expect(screen.getByTestId('share-error').textContent).toBe('true')
    await user.click(screen.getByRole('button', { name: 'share-40' }))
    await user.click(screen.getByRole('button', { name: 'share-blur' }))
    expect(fieldError(label)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'share-101' }))
    await user.click(screen.getByRole('button', { name: 'share-blur' }))
    expect(fieldError(label)).toBe('Вкажіть від 1 до 100')
    await user.click(screen.getByRole('button', { name: 'share-40' }))
    await user.click(screen.getByRole('button', { name: 'share-blur' }))
    expect(fieldError(label)).toBeNull()
    expect(screen.getByTestId('share-error').textContent).toBe('false')
  })

  it('accepts the 1 and 100 boundaries', async () => {
    const user = userEvent.setup()
    renderDialog()
    const label = 'Частка сеньйора (%)'
    await user.click(screen.getByRole('button', { name: 'share-1' }))
    await user.click(screen.getByRole('button', { name: 'share-blur' }))
    expect(fieldError(label)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'share-100' }))
    await user.click(screen.getByRole('button', { name: 'share-blur' }))
    expect(fieldError(label)).toBeNull()
  })
})

describe('HrCreateSeniorDialog submit', () => {
  it('posts the normalized payload and, on success, toasts, invalidates, closes and resets', async () => {
    const user = userEvent.setup()
    const view = renderDialog({ users: [ACCOUNTANT_A] })
    await screen.findByText('Anna Accountant')
    await fillRequired(user)
    await user.type(screen.getByPlaceholderText('@username'), '  senior_tg ')
    await user.type(screen.getByPlaceholderText('Почніть вводити: React, Node.js…'), 'React{Enter}')
    await user.click(screen.getByRole('button', { name: 'share-40' }))
    schemaSpy.mockImplementationOnce((() => ({ success: true, data: { parsed: true } })) as never)
    mockedPost.mockResolvedValue({ data: {} } as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    // The request body is the schema's parsed output, not the raw payload.
    expect(mockedPost).toHaveBeenCalledWith('/users', { parsed: true })
    expect(schemaSpy).toHaveBeenCalledWith({
      email: 'sen@cheeky.dev',
      displayName: 'Іван Сеньйор',
      role: 'SENIOR',
      telegram: '@senior_tg',
      phone: '+380501234567',
      techStack: ['React'],
      seniorSharePercent: 40,
      hrIds: [HR_ID],
      accountantId: ACC_A,
    })
    await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Сеньйора створено, команду сформовано')
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: ['teams'] })
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: ['users'] })
    expect(toast.error).not.toHaveBeenCalled()
    // form.reset(): typed values are gone
    expect((screen.getByPlaceholderText('senior@cheekycheese.dev') as HTMLInputElement).value).toBe(
      '',
    )
    expect(screen.getByTestId('share-value').textContent).toBe('26')
  })

  it('keeps an existing @ on telegram and omits empty optional fields', async () => {
    const user = userEvent.setup()
    renderDialog()
    await fillRequired(user)
    await user.clear(phoneEl())
    await user.type(screen.getByPlaceholderText('@username'), '@already')
    mockedPost.mockResolvedValue({ data: {} } as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    const payload = mockedPost.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.telegram).toBe('@already')
    expect(payload.phone).toBeUndefined()
    expect(payload.techStack).toBeUndefined()
    expect(payload.accountantId).toBeNull()
    expect(payload.seniorSharePercent).toBe(26)
  })

  it('omits telegram when it is blank', async () => {
    const user = userEvent.setup()
    renderDialog()
    await fillRequired(user)
    await user.type(screen.getByPlaceholderText('@username'), '   ')
    mockedPost.mockResolvedValue({ data: {} } as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    expect((mockedPost.mock.calls[0]?.[1] as Record<string, unknown>).telegram).toBeUndefined()
  })

  it('REGRESSION: the real schema accepts the requisite-less payload, POSTs it and succeeds', async () => {
    const user = userEvent.setup()
    const view = renderDialog()
    await fillRequired(user)
    mockedPost.mockResolvedValue({ data: {} } as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1))
    // Parsed by the REAL hrCreateSeniorSchema: HR sends no payment method, wallet or legal name.
    expect(mockedPost).toHaveBeenCalledWith('/users', {
      email: 'sen@cheeky.dev',
      displayName: 'Іван Сеньйор',
      role: 'SENIOR',
      phone: '+380501234567',
      seniorSharePercent: 26,
      hrIds: [HR_ID],
      accountantId: null,
    })
    await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Сеньйора створено, команду сформовано')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts the first schema issue verbatim, or translated when it is a zod code', async () => {
    const user = userEvent.setup()
    renderDialog()
    await fillRequired(user)
    schemaSpy.mockImplementationOnce((() => ({
      success: false,
      error: { issues: [{ message: 'Custom failure' }, { message: 'second' }] },
    })) as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenLastCalledWith('Custom failure')
    schemaSpy.mockImplementationOnce((() => ({
      success: false,
      error: { issues: [{ message: 'zod.PHONE_INVALID' }] },
    })) as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    expect(toast.error).toHaveBeenLastCalledWith(
      'Введіть номер у міжнародному форматі, напр. +380671234567',
    )
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('toasts the fallback message and stays open when the request fails', async () => {
    const user = userEvent.setup()
    const view = renderDialog()
    await fillRequired(user)
    mockedPost.mockRejectedValue({})
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenCalledWith('Не вдалося створити команду — спробуйте ще раз')
    expect(view.onClose).not.toHaveBeenCalled()
    expect(view.invalidate).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect((screen.getByPlaceholderText('senior@cheekycheese.dev') as HTMLInputElement).value).toBe(
      'sen@cheeky.dev',
    )
  })

  it('shows the pending label and disables submit while the request is in flight', async () => {
    const user = userEvent.setup()
    renderDialog()
    await fillRequired(user)
    let release: (v: unknown) => void = () => undefined
    mockedPost.mockReturnValue(new Promise((r) => (release = r)) as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    const pending = (await screen.findByRole('button', { name: 'Створюємо…' })) as HTMLButtonElement
    expect(pending.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Створити' })).toBeNull()
    await act(async () => {
      release({ data: {} })
    })
    expect(await screen.findByRole('button', { name: 'Створити' })).toHaveProperty(
      'disabled',
      false,
    )
  })
})

describe('HrCreateSeniorDialog closing', () => {
  it('cancel resets the form and calls onClose', async () => {
    const user = userEvent.setup()
    const view = renderDialog({ users: [ACCOUNTANT_A, ACCOUNTANT_B] })
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(view.onClose).toHaveBeenCalledTimes(1)
    expect((screen.getByPlaceholderText('senior@cheekycheese.dev') as HTMLInputElement).value).toBe(
      '',
    )
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('Escape closes through the same handler', async () => {
    const user = userEvent.setup()
    const view = renderDialog()
    await fillRequired(user)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1))
    expect((screen.getByPlaceholderText('senior@cheekycheese.dev') as HTMLInputElement).value).toBe(
      '',
    )
  })

  it('clears a chosen accountant on cancel', async () => {
    const user = userEvent.setup()
    const view = renderDialog({ users: [ACCOUNTANT_A, ACCOUNTANT_B] })
    await user.click(await screen.findByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Anna Accountant' }))
    expect(screen.getByRole('combobox').textContent).toContain('Anna Accountant')
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(view.onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('combobox').textContent).toContain('— оберіть бухгалтера —')
  })
})

describe('HrCreateSeniorDialog data wiring and trimming', () => {
  it('caches the loaded users under the shared ["users"] query key', async () => {
    const view = renderDialog({ users: [ACCOUNTANT_A] })
    await screen.findByText('Anna Accountant')
    expect(view.qc.getQueryData(['users'])).toEqual([ACCOUNTANT_A])
  })

  it('trims the email for validation and for the payload', async () => {
    const user = userEvent.setup()
    renderDialog()
    const email = screen.getByPlaceholderText('senior@cheekycheese.dev')
    // type=email makes the DOM strip whitespace; a text input lets the padding reach the form.
    email.setAttribute('type', 'text')
    await user.type(email, '  pad@cheeky.dev  ')
    await user.tab()
    expect(fieldError('Email')).toBeNull()
    await user.type(screen.getByPlaceholderText('Іван Іваненко'), 'Іван Сеньйор')
    await user.clear(phoneEl())
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(schemaSpy).toHaveBeenCalledTimes(1))
    expect(schemaSpy.mock.calls[0]?.[0]).toMatchObject({ email: 'pad@cheeky.dev' })
  })

  it('treats a whitespace-only name as empty', async () => {
    const user = userEvent.setup()
    renderDialog()
    const name = screen.getByPlaceholderText('Іван Іваненко')
    await user.type(name, '   ')
    await user.tab()
    expect(fieldError('Ім’я та прізвище')?.length).toBeGreaterThan(0)
  })

  it('highlights the phone widget only while the phone has an error', async () => {
    const user = userEvent.setup()
    renderDialog()
    const marked = () =>
      Array.from(document.querySelectorAll('*')).filter((el) =>
        (el.getAttribute('class') ?? '').includes('[&_input]:border-destructive'),
      )
    expect(marked()).toHaveLength(0)
    await user.click(phoneEl())
    await user.tab()
    expect(marked()).toHaveLength(1)
    await user.clear(phoneEl())
    await user.type(phoneEl(), '+380501234567')
    await user.tab()
    expect(marked()).toHaveLength(0)
  })

  it('feeds the chosen share back into the slider', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: 'share-40' }))
    expect(screen.getByTestId('share-value').textContent).toBe('40')
  })

  it('falls back to the generic form message when the schema reports no issue text', async () => {
    const user = userEvent.setup()
    renderDialog()
    await fillRequired(user)
    schemaSpy.mockImplementationOnce((() => ({
      success: false,
      error: { issues: [] },
    })) as never)
    await user.click(screen.getByRole('button', { name: 'Створити' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.error).toHaveBeenCalledWith('Перевірте заповнені поля')
    expect(mockedPost).not.toHaveBeenCalled()
  })
})

describe('HrCreateSeniorDialog while closed', () => {
  it('does not touch its state while closed, even with the users already cached', () => {
    const qc = new QueryClient()
    qc.setQueryData(['users'], [ACCOUNTANT_A])
    const onRender = vi.fn()
    render(
      <I18nTestProvider>
        <QueryClientProvider client={qc}>
          <Profiler id="dialog" onRender={onRender}>
            <HrCreateSeniorDialog open={false} onClose={vi.fn()} hrUserId={HR_ID} />
          </Profiler>
        </QueryClientProvider>
      </I18nTestProvider>,
    )
    // Mount plus the query observer settling is 2 commits; an effect that seeds state while
    // closed would add more (4 with the open-gate removed).
    expect(onRender).toHaveBeenCalledTimes(2)
  })
})
