/**
 * Characterization tests for `PaymentRequisitesSection` after it moved out of
 * `UserDialog.tsx` verbatim. SECURITY-SENSITIVE (payment requisites / PII): pins
 * the method gating (USDT-only for SENIOR/ADMIN, toggle for the rest, which field
 * set each method shows) and every onBlur validator through a real TanStack form.
 */
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { PaymentRequisitesSection } from '../PaymentRequisitesSection'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

interface Defaults {
  role?: string
  paymentMethod?: string
}

function Harness({ defaults = {} }: { defaults?: Defaults }) {
  const form = useForm({
    defaultValues: {
      role: 'JUNIOR',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '',
      walletUsdtLabel: '',
      bankUahRecipient: '',
      bankUahIban: '',
      bankUahRnokpp: '',
      bankUahBankName: '',
      ...defaults,
    },
  })
  return (
    <>
      <PaymentRequisitesSection form={form} />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
    </>
  )
}

function values() {
  return JSON.parse(screen.getByTestId('values').textContent ?? '{}') as Record<string, unknown>
}

function type(testId: string, value: string) {
  const el = screen.getByTestId(testId)
  fireEvent.change(el, { target: { value } })
  fireEvent.blur(el)
}

const BANK = { paymentMethod: 'BANK_UAH_FOP' }

const VALID_WALLET = '0x' + 'aB3'.repeat(13) + 'f' // 2 + 40 hex chars
const VALID_IBAN = 'UA' + '1'.repeat(27)

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('PaymentRequisitesSection — method gating', () => {
  it.each(['SENIOR', 'ADMIN'])('%s sees the USDT-only note and no method toggle', (role) => {
    render(<Harness defaults={{ role, paymentMethod: 'BANK_UAH_FOP' }} />)
    expect(screen.getByRole('heading', { name: 'Реквізити для виплат' })).toBeInTheDocument()
    expect(
      screen.getByText(/доступні лише виплати в USDT ERC-20/, { exact: false }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-payment-method')).not.toBeInTheDocument()
    // USDT fields shown even though the form value says BANK (usdtOnly override).
    expect(screen.getByTestId('user-dialog-wallet')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-bank-iban')).not.toBeInTheDocument()
  })

  it('JUNIOR with USDT method sees the toggle and only the wallet fields', () => {
    render(<Harness />)
    expect(screen.getByTestId('user-dialog-payment-method')).toBeInTheDocument()
    expect(
      screen.getByText('Використовуватиметься адреса гаманця в мережі Ethereum.'),
    ).toBeVisible()
    expect(screen.getByTestId('user-dialog-wallet')).toBeInTheDocument()
    expect(screen.getByText('Мітка гаманця (необов’язково)')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-bank-recipient')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-bank-iban')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-bank-rnokpp')).not.toBeInTheDocument()
    expect(screen.queryByText('Банк (необов’язково)')).not.toBeInTheDocument()
  })

  it('JUNIOR with BANK method sees recipient/IBAN/RNOKPP/bank and no wallet fields', () => {
    render(<Harness defaults={BANK} />)
    expect(
      screen.getByText('Використовуватиметься український банківський рахунок ФОП.'),
    ).toBeVisible()
    expect(screen.getByTestId('user-dialog-bank-recipient')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-bank-iban')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-bank-rnokpp')).toBeInTheDocument()
    expect(screen.getByText('Банк (необов’язково)')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-wallet')).not.toBeInTheDocument()
    expect(screen.queryByText('Мітка гаманця (необов’язково)')).not.toBeInTheDocument()
  })

  it('the toggle switches the field set and writes paymentMethod to the form', () => {
    render(<Harness />)
    const toggle = screen.getByTestId('user-dialog-payment-method')
    fireEvent.click(screen.getByRole('radio', { name: 'ФОП (UAH)' }))
    expect(toggle).toBeInTheDocument()
    expect(values().paymentMethod).toBe('BANK_UAH_FOP')
    expect(screen.getByTestId('user-dialog-bank-iban')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-wallet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'USDT ERC-20' }))
    expect(values().paymentMethod).toBe('USDT_ERC20')
    expect(screen.getByTestId('user-dialog-wallet')).toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-bank-iban')).not.toBeInTheDocument()
  })
})

describe('PaymentRequisitesSection — wallet validators', () => {
  it('accepts a valid 0x + 40 hex address (padded with spaces)', async () => {
    render(<Harness />)
    type('user-dialog-wallet', `  ${VALID_WALLET}  `)
    await waitFor(() => expect(values().walletUsdtErc20).toBe(`  ${VALID_WALLET}  `))
    expect(screen.queryByText(/має починатися з 0x/)).not.toBeInTheDocument()
    expect(screen.queryByText('Вкажіть адресу USDT ERC-20')).not.toBeInTheDocument()
  })

  it.each([
    ['too short', '0x123'],
    ['41 hex chars', VALID_WALLET + '1'],
    ['no 0x prefix', VALID_WALLET.slice(2) + '12'],
    ['non-hex char', '0x' + 'g'.repeat(40)],
  ])('rejects %s', async (_n, bad) => {
    render(<Harness />)
    type('user-dialog-wallet', bad)
    expect(
      await screen.findByText('Адреса USDT ERC-20 має починатися з 0x і містити 42 символи'),
    ).toBeInTheDocument()
  })

  it('reports required when the dirty field is blank / whitespace-only', async () => {
    render(<Harness />)
    type('user-dialog-wallet', '   ')
    expect(await screen.findByText('Вкажіть адресу USDT ERC-20')).toBeInTheDocument()
  })

  it('shows no error for an untouched/never-edited blur', async () => {
    render(<Harness />)
    fireEvent.blur(screen.getByTestId('user-dialog-wallet'))
    await waitFor(() => expect(values().walletUsdtErc20).toBe(''))
    expect(screen.queryByText('Вкажіть адресу USDT ERC-20')).not.toBeInTheDocument()
  })

  it('writes the nickname label to the form', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText('наприклад: основний'), {
      target: { value: 'основний' },
    })
    expect(values().walletUsdtLabel).toBe('основний')
  })
})

describe('PaymentRequisitesSection — error styling and visibility', () => {
  const ERR_CLASS = 'border-destructive'

  it.each([
    ['wallet', {}, 'user-dialog-wallet', 'bad', VALID_WALLET],
    ['recipient', BANK, 'user-dialog-bank-recipient', 'ab', 'abc'],
    ['iban', BANK, 'user-dialog-bank-iban', 'UA1', VALID_IBAN],
    ['rnokpp', BANK, 'user-dialog-bank-rnokpp', '123', '1234567890'],
  ])('%s: red border only while invalid', async (_n, defaults, testId, bad, good) => {
    render(<Harness defaults={defaults} />)
    expect(screen.getByTestId(testId)).not.toHaveClass(ERR_CLASS)
    type(testId, bad)
    await waitFor(() => expect(screen.getByTestId(testId)).toHaveClass(ERR_CLASS))
    type(testId, good)
    await waitFor(() => expect(screen.getByTestId(testId)).not.toHaveClass(ERR_CLASS))
  })

  it('an edited-but-not-blurred field shows no error yet', async () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId('user-dialog-wallet'), { target: { value: 'bad' } })
    await waitFor(() => expect(values().walletUsdtErc20).toBe('bad'))
    expect(screen.getByTestId('user-dialog-wallet')).not.toHaveClass(ERR_CLASS)
  })

  it('pins the raw-input attributes of the sensitive fields', () => {
    const { unmount } = render(<Harness />)
    const wallet = screen.getByTestId('user-dialog-wallet')
    expect(wallet).toHaveAttribute('autocomplete', 'off')
    expect(wallet).toHaveAttribute('autocapitalize', 'off')
    expect(wallet).toHaveAttribute('autocorrect', 'off')
    expect(wallet).toHaveAttribute('spellcheck', 'false')
    unmount()
    render(<Harness defaults={BANK} />)
    const iban = screen.getByTestId('user-dialog-bank-iban')
    expect(iban).toHaveAttribute('autocorrect', 'off')
    expect(iban).toHaveAttribute('spellcheck', 'false')
    const recipient = screen.getByTestId('user-dialog-bank-recipient')
    expect(recipient).toHaveAttribute('autocapitalize', 'words')
    expect(recipient).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByTestId('user-dialog-bank-rnokpp')).toHaveAttribute('pattern', '[0-9]*')
  })
})

describe('PaymentRequisitesSection — bank validators', () => {
  it('accepts a 3-char recipient, valid IBAN and 10-digit RNOKPP', async () => {
    render(<Harness defaults={BANK} />)
    type('user-dialog-bank-recipient', 'Іва')
    type('user-dialog-bank-iban', ` ${VALID_IBAN} `)
    type('user-dialog-bank-rnokpp', ' 1234567890 ')
    await waitFor(() => expect(values().bankUahRnokpp).toBe(' 1234567890 '))
    expect(screen.queryByText('ПІБ отримувача — мінімум 3 символи')).not.toBeInTheDocument()
    expect(screen.queryByText(/IBAN має бути у форматі/)).not.toBeInTheDocument()
    expect(screen.queryByText('Введіть 10 цифр РНОКПП')).not.toBeInTheDocument()
  })

  it('rejects a recipient shorter than 3 chars (trimmed)', async () => {
    render(<Harness defaults={BANK} />)
    type('user-dialog-bank-recipient', ' Ів ')
    expect(await screen.findByText('ПІБ отримувача — мінімум 3 символи')).toBeInTheDocument()
  })

  it.each([
    ['26 digits', 'UA' + '1'.repeat(26)],
    ['28 digits', 'UA' + '1'.repeat(28)],
    ['lowercase prefix', 'ua' + '1'.repeat(27)],
    ['letters in body', 'UA' + 'a'.repeat(27)],
  ])('rejects IBAN with %s', async (_n, bad) => {
    render(<Harness defaults={BANK} />)
    type('user-dialog-bank-iban', bad)
    expect(
      await screen.findByText('IBAN має бути у форматі UA + 27 цифр (29 символів)'),
    ).toBeInTheDocument()
  })

  it.each([
    ['9 digits', '123456789'],
    ['11 digits', '12345678901'],
    ['letters', '12345abcde'],
  ])('rejects RNOKPP with %s', async (_n, bad) => {
    render(<Harness defaults={BANK} />)
    type('user-dialog-bank-rnokpp', bad)
    expect(await screen.findByText('Введіть 10 цифр РНОКПП')).toBeInTheDocument()
  })

  it('wires the optional bank name and the input hints', () => {
    render(<Harness defaults={BANK} />)
    fireEvent.change(screen.getByPlaceholderText('ПриватБанк'), { target: { value: 'Моно' } })
    expect(values().bankUahBankName).toBe('Моно')
    expect(screen.getByTestId('user-dialog-bank-rnokpp')).toHaveAttribute('inputmode', 'numeric')
    expect(screen.getByTestId('user-dialog-bank-iban')).toHaveAttribute(
      'autocapitalize',
      'characters',
    )
  })
})
