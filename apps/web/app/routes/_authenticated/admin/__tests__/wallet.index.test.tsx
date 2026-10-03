/**
 * routes/_authenticated/admin/wallet.index.tsx + ChangeWalletAddressDialog — unit tests for the
 * ADMIN company-wallet page.
 *
 * task-i18n stage 6A: these two screens were still hardcoded Russian when the
 * `lingui/no-unlocalized-strings` rule was promoted to `error`; they now go through the catalog
 * and this file pins what an admin actually reads (visible text, toasts, aria-label) plus the
 * save / copy / change flows that carry those messages.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, waitFor, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

function render(ui: ReactElement, options?: RenderOptions) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <I18nTestProvider>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </I18nTestProvider>
    ),
    ...options,
  })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

// CodeMirror — heavy lazy dep; a plain textarea keeps the save flow drivable.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      aria-label="requisites-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))
vi.mock('@codemirror/lang-markdown', () => ({ markdown: () => ({}) }))
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }))

const apiGetMock = vi.fn()
const apiPatchMock = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
  },
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { Route } from '../wallet.index'

const CompanyWalletPage = Route.options.component!

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'
const NEW_WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

beforeEach(() => {
  apiGetMock.mockReset()
  apiPatchMock.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe('CompanyWalletPage — visible text', () => {
  it('renders the uk page copy for a configured wallet', async () => {
    apiGetMock.mockResolvedValue({
      data: { walletAddress: WALLET, requisitesMarkdown: '# Реквізити' },
    })
    render(<CompanyWalletPage />)

    expect(await screen.findByTestId('admin-company-wallet-address')).toHaveTextContent(WALLET)
    expect(
      screen.getByText(
        'Налаштування компанії: гаманець для отримання USDT і реквізити, які автоматично додаються в кінець кожного нового контракту під час підписання.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Гаманець компанії (USDT ERC-20)')).toBeInTheDocument()
    expect(screen.getByText('Поточна адреса')).toBeInTheDocument()
    expect(screen.getByText('Мережа: Ethereum ERC-20')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Змінити адресу' })).toBeInTheDocument()
    expect(screen.getByText('Реквізити компанії')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Markdown. Цей блок додається в кінець кожного нового контракту під заголовком «Реквізити компанії». Шаблони контрактів змінювати не потрібно. Зміни стосуються лише майбутніх підписань — уже підписані контракти не змінюються.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скопіювати адресу гаманця' })).toBeInTheDocument()
  })

  it('shows «Адресу не налаштовано» when no wallet is set', async () => {
    apiGetMock.mockResolvedValue({ data: { walletAddress: null, requisitesMarkdown: null } })
    render(<CompanyWalletPage />)

    expect(await screen.findByTestId('admin-company-wallet-empty')).toHaveTextContent(
      'Адресу не налаштовано',
    )
    expect(screen.queryByRole('button', { name: 'Скопіювати адресу гаманця' })).toBeNull()
  })
})

describe('CompanyWalletPage — copy address', () => {
  it('writes the address to the clipboard and toasts «Адресу скопійовано»', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: { walletAddress: WALLET, requisitesMarkdown: null } })
    render(<CompanyWalletPage />)
    // userEvent.setup() installs its own clipboard stub — spy AFTER it, on that stub.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')

    await user.click(await screen.findByRole('button', { name: 'Скопіювати адресу гаманця' }))

    expect(writeText).toHaveBeenCalledWith(WALLET)
    expect(toastSuccess).toHaveBeenCalledWith('Адресу скопійовано')
  })
})

describe('CompanyWalletPage — requisites save', () => {
  it('keeps «Зберегти» disabled until edited, saves, then toasts «Реквізити збережено»', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: { walletAddress: WALLET, requisitesMarkdown: 'old' } })
    apiPatchMock.mockResolvedValue({ data: { walletAddress: WALLET, requisitesMarkdown: 'new' } })
    render(<CompanyWalletPage />)

    const save = await screen.findByRole('button', { name: 'Зберегти' })
    expect(save).toBeDisabled()

    const editor = await screen.findByLabelText('requisites-editor')
    await user.clear(editor)
    await user.type(editor, 'new')
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Реквізити збережено'))
    expect(apiPatchMock).toHaveBeenCalledWith('/company-account/requisites', {
      requisitesMarkdown: 'new',
    })
  })

  it('shows «Збереження…» on the button while the save is in flight', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: { walletAddress: WALLET, requisitesMarkdown: 'old' } })
    apiPatchMock.mockReturnValue(new Promise(() => {}))
    render(<CompanyWalletPage />)

    await user.type(await screen.findByLabelText('requisites-editor'), '!')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByRole('button', { name: 'Збереження…' })).toBeDisabled()
  })

  it('toasts «Не вдалося зберегти реквізити» when the save fails', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: { walletAddress: WALLET, requisitesMarkdown: 'old' } })
    apiPatchMock.mockRejectedValue(new Error('boom'))
    render(<CompanyWalletPage />)

    const editor = await screen.findByLabelText('requisites-editor')
    await user.type(editor, '!')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Не вдалося зберегти реквізити'))
  })
})

describe('ChangeWalletAddressDialog (opened from the page)', () => {
  it('shows the uk dialog copy and «Не вказано» when no wallet is configured', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: { walletAddress: null, requisitesMarkdown: null } })
    render(<CompanyWalletPage />)

    await user.click(await screen.findByRole('button', { name: 'Змінити адресу' }))

    expect(await screen.findByText('Змінити адресу гаманця компанії')).toBeInTheDocument()
    expect(screen.getByText('Зміна ERC-20 адреси для отримання USDT-депозитів')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Зміна адреси набуде чинності негайно. Повідомте партнерам нову адресу для поповнень.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByDisplayValue('Не вказано')).toBeInTheDocument()
    expect(screen.getByText('Нова адреса (ERC-20)')).toBeInTheDocument()
    expect(screen.getByText('Ethereum ERC-20, починається з 0x, 42 символи')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Зберегти адресу' })).toBeDisabled()
  })

  it('shows «Збереження…» on the dialog button while the address save is in flight', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: { walletAddress: WALLET, requisitesMarkdown: null } })
    apiPatchMock.mockReturnValue(new Promise(() => {}))
    render(<CompanyWalletPage />)

    await user.click(await screen.findByRole('button', { name: 'Змінити адресу' }))
    await user.type(await screen.findByPlaceholderText('0x…'), NEW_WALLET)
    await user.click(screen.getByRole('button', { name: 'Зберегти адресу' }))

    expect(await screen.findByRole('button', { name: 'Збереження…' })).toBeDisabled()
  })

  it('saves a valid address and toasts «Адресу гаманця оновлено»', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: { walletAddress: WALLET, requisitesMarkdown: null } })
    apiPatchMock.mockResolvedValue({ data: { walletAddress: NEW_WALLET } })
    render(<CompanyWalletPage />)

    await user.click(await screen.findByRole('button', { name: 'Змінити адресу' }))
    expect(await screen.findByDisplayValue(WALLET)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('0x…'), NEW_WALLET)
    await user.click(screen.getByRole('button', { name: 'Зберегти адресу' }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Адресу гаманця оновлено'))
    expect(apiPatchMock).toHaveBeenCalledWith('/company-account/wallet', {
      walletAddress: NEW_WALLET,
    })
  })
})
