/**
 * ChangePersonalEmailDialog — mutation-gate closure (security-review PR
 * #623 round 5): this component had ZERO prior direct unit coverage (only
 * indirectly reached via `AdminActionsMenu.change-personal-email.test.tsx`,
 * which only checks the title text). The gate found 30+ surviving mutants
 * across validate(), isAdding/isRemoval/isNoop, the state-dependent
 * description, and the submit button's variant/label/disabled state — this
 * file closes that gap directly.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/axios'
import { ChangePersonalEmailDialog } from '../ChangePersonalEmailDialog'

const WORK_EMAIL = 'ivan@work.example'
const CURRENT_PERSONAL = 'ivan.personal@gmail.com'

function renderDialog(overrides: { currentEmail: string | null; onClose?: () => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = overrides.onClose ?? vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <ChangePersonalEmailDialog
        userId="u-1"
        currentEmail={overrides.currentEmail}
        workEmail={WORK_EMAIL}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
  return { onClose }
}

function input() {
  return screen.getByTestId('change-personal-email-input') as HTMLInputElement
}

function submitButton() {
  return screen.getByTestId('change-personal-email-submit')
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { ok: true, delivered: true },
  })
})

describe('ChangePersonalEmailDialog — adding state (currentEmail === null)', () => {
  it('title is "Добавить личный email"', () => {
    renderDialog({ currentEmail: null })
    expect(screen.getByRole('heading', { name: 'Добавить личный email' })).toBeInTheDocument()
  })

  it('description names the invite, not a revocation (COPY-M-12) — no "старого"/"нынешнего" claim', () => {
    renderDialog({ currentEmail: null })
    expect(
      screen.getByText(
        'На этот адрес сразу уйдёт приглашение. Входить по нему сотрудник сможет только после того, как подтвердит адрес.',
      ),
    ).toBeInTheDocument()
  })

  it('input starts empty and the submit button is the neutral (non-destructive) variant', () => {
    renderDialog({ currentEmail: null })
    expect(input().value).toBe('')
    expect(submitButton().className).not.toContain('bg-destructive')
  })

  it('submit button is disabled while the field is empty (isNoop: "" === "")', () => {
    renderDialog({ currentEmail: null })
    expect(submitButton()).toBeDisabled()
  })

  it('typing a valid new address enables the button, labelled "Сохранить" (not the removal label)', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    await user.type(input(), 'new.personal@gmail.com')
    expect(submitButton()).not.toBeDisabled()
    expect(submitButton()).toHaveTextContent('Сохранить')
  })
})

describe('ChangePersonalEmailDialog — change state (currentEmail set)', () => {
  it('title is "Изменить личный email"', () => {
    renderDialog({ currentEmail: CURRENT_PERSONAL })
    expect(screen.getByRole('heading', { name: 'Изменить личный email' })).toBeInTheDocument()
  })

  it('description mentions BOTH the current address closing AND the new invite (COPY-H-4)', () => {
    renderDialog({ currentEmail: CURRENT_PERSONAL })
    expect(
      screen.getByText(
        'Сохраните — и вход по нынешнему адресу закроется сразу, даже если сотрудник уже подтвердил его. На новый адрес уйдёт приглашение.',
      ),
    ).toBeInTheDocument()
  })

  it('input is pre-filled with the current address', () => {
    renderDialog({ currentEmail: CURRENT_PERSONAL })
    expect(input().value).toBe(CURRENT_PERSONAL)
  })

  it('submit button is disabled on an unmodified resubmit (isNoop: byte-identical value)', () => {
    renderDialog({ currentEmail: CURRENT_PERSONAL })
    expect(submitButton()).toBeDisabled()
  })

  it('submit button is the destructive variant (revokesExisting) even though the label stays "Сохранить"', async () => {
    renderDialog({ currentEmail: CURRENT_PERSONAL })
    const user = userEvent.setup()
    await user.clear(input())
    await user.type(input(), 'different.personal@gmail.com')
    expect(submitButton().className).toContain('bg-destructive')
    expect(submitButton()).toHaveTextContent('Сохранить')
  })
})

describe('ChangePersonalEmailDialog — removal state (field cleared, currentEmail was set)', () => {
  async function typeEmptyAfterClearing() {
    renderDialog({ currentEmail: CURRENT_PERSONAL })
    const user = userEvent.setup()
    await user.clear(input())
    return user
  }

  it('description names ONLY the current address, no mention of a new one (COPY-M-11)', async () => {
    await typeEmptyAfterClearing()
    expect(
      screen.getByText(
        'Сохраните — и вход по этому адресу закроется сразу, даже если сотрудник уже подтвердил его.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/На новый адрес уйдёт приглашение/)).not.toBeInTheDocument()
  })

  it('submit button reads "Удалить адрес" and is the destructive variant', async () => {
    await typeEmptyAfterClearing()
    expect(submitButton()).toHaveTextContent('Удалить адрес')
    expect(submitButton().className).toContain('bg-destructive')
  })

  it('submit button is enabled (clearing a non-empty field is a real change, not isNoop)', async () => {
    await typeEmptyAfterClearing()
    expect(submitButton()).not.toBeDisabled()
  })

  it('no standalone hint paragraph duplicates the description (COPY-M-11 — removed, not softened)', async () => {
    await typeEmptyAfterClearing()
    expect(screen.queryByText(/сохранение удалит личный адрес/i)).not.toBeInTheDocument()
  })
})

describe('ChangePersonalEmailDialog — validate() on blur', () => {
  it('an invalid email shape shows the exact Russian message and reddens the input', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    await user.type(input(), 'not-an-email')
    await user.tab() // blur
    expect(await screen.findByText('Некорректный email')).toBeInTheDocument()
    expect(input().className).toContain('border-destructive')
  })

  it('an email over the 255-char cap shows the length message', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    const tooLong = `${'a'.repeat(250)}@x.com`
    await user.type(input(), tooLong)
    await user.tab()
    expect(await screen.findByText('Email не длиннее 255 символов')).toBeInTheDocument()
  })

  it('an address identical to the work email is rejected, distinctly from the format error', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    await user.type(input(), WORK_EMAIL)
    await user.tab()
    expect(
      await screen.findByText('Личный email должен отличаться от рабочего'),
    ).toBeInTheDocument()
  })

  it('a genuinely valid, different address shows no error', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    await user.type(input(), 'brand.new@gmail.com')
    await user.tab()
    expect(screen.queryByText('Некорректный email')).not.toBeInTheDocument()
    expect(screen.queryByText('Личный email должен отличаться от рабочего')).not.toBeInTheDocument()
  })

  it('editing the field after an error clears it immediately (does not wait for the next blur)', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    await user.type(input(), 'not-an-email')
    await user.tab()
    expect(await screen.findByText('Некорректный email')).toBeInTheDocument()
    await user.type(input(), 'x')
    expect(screen.queryByText('Некорректный email')).not.toBeInTheDocument()
  })
})

describe('ChangePersonalEmailDialog — submit', () => {
  it('a validation failure on submit blocks the request entirely (no PATCH call)', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    await user.type(input(), 'not-an-email')
    // Button is enabled (non-noop), but clicking must still validate.
    await user.click(submitButton())
    expect(await screen.findByText('Некорректный email')).toBeInTheDocument()
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('a valid change PATCHes the endpoint with the trimmed address and closes the dialog', async () => {
    const { onClose } = renderDialog({ currentEmail: CURRENT_PERSONAL })
    const user = userEvent.setup()
    await user.clear(input())
    await user.type(input(), '  new.personal@gmail.com  ')
    await user.click(submitButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.patch).toHaveBeenCalledWith('/users/u-1/personal-email', {
      personalEmail: 'new.personal@gmail.com',
    })
  })

  it('a removal (field cleared) PATCHes with personalEmail: null', async () => {
    const { onClose } = renderDialog({ currentEmail: CURRENT_PERSONAL })
    const user = userEvent.setup()
    await user.clear(input())
    await user.click(submitButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.patch).toHaveBeenCalledWith('/users/u-1/personal-email', { personalEmail: null })
  })

  it('Cancel closes the dialog without calling the endpoint', async () => {
    const { onClose } = renderDialog({ currentEmail: CURRENT_PERSONAL })
    const user = userEvent.setup()
    await user.click(screen.getByText('Отмена'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.patch).not.toHaveBeenCalled()
  })
})
