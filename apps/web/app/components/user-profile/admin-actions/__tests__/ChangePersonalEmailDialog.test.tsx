/**
 * ChangePersonalEmailDialog — mutation-gate closure (security-review PR
 * #623 round 5): this component had ZERO prior direct unit coverage (only
 * indirectly reached via `AdminActionsMenu.change-personal-email.test.tsx`,
 * which only checks the title text). The gate found 30+ surviving mutants
 * across validate(), isAdding/isRemoval/isNoop, the state-dependent
 * description, and the submit button's variant/label/disabled state — this
 * file closes that gap directly.
 */
import { useState } from 'react'
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

  it('description names ONLY the current address, no mention of a new one (COPY-M-11), and matches the "Удалить" button verb (COPY-M-14)', async () => {
    await typeEmptyAfterClearing()
    const description = screen.getByText(
      'Удалите — и вход по этому адресу закроется сразу, даже если сотрудник уже подтвердил его.',
    )
    expect(description).toBeInTheDocument()
    expect(screen.queryByText(/На новый адрес уйдёт приглашение/)).not.toBeInTheDocument()

    // COPY-M-16 (copy-review PR #623 closing round): a non-breaking space
    // (U+00A0) before "его." keeps the last two words on the same line at
    // 375px, the mandatory mobile width (responsive-design.md) — a regular
    // space here left "его." hanging alone on its own line. `getByText`'s
    // default normalizer treats NBSP as ordinary whitespace (JS `\s`
    // matches U+00A0) and collapses both to a plain space before
    // comparing, so the `getByText` match above would pass with EITHER
    // character — it does not, by itself, prove the nbsp is there. Reading
    // the raw `textContent` instead (no normalizer) does.
    expect(description.textContent).toContain('подтвердил его.')
    const heIndex = description.textContent?.indexOf('его.') ?? -1
    expect(heIndex).toBeGreaterThan(0)
    expect(description.textContent?.charCodeAt(heIndex - 1)).toBe(0x00a0)
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

  // mutation-gate closure: `const trimmed = value.trim()` mutated to `const
  // trimmed = value` — every OTHER test in this file that "clears" the
  // field does so via `userEvent.clear()`/`userEvent.type()`, which drive a
  // real `<input type="email">` through the DOM's OWN value-sanitization
  // (strips leading/trailing whitespace before React's onChange ever sees
  // it), so `value` never actually CONTAINS whitespace to trim in the first
  // place — confirmed by hand-applying this exact mutant and re-running the
  // whole file: all 23 pre-existing tests still passed. `fireEvent.change`
  // sets the DOM value directly and bypasses that sanitization, so a
  // whitespace-only value genuinely reaches `value` un-trimmed — only THIS
  // reaches the `.trim()` call in an observable way.
  // mutation-gate closure: `const trimmed = value.trim()` mutated to `const
  // trimmed = value`. Every OTHER test in this file drives the field via
  // `userEvent`/`fireEvent.change` on a real `<input type="email">` — and
  // that element's OWN value-sanitization algorithm (WHATWG HTML §
  // "value sanitization algorithm" for `type=email`) strips leading/
  // trailing whitespace on assignment, in happy-dom the same as a real
  // browser: confirmed by hand-applying this exact mutant and re-running
  // the whole file (all 23 pre-existing tests still passed), and by
  // instrumenting `fireEvent.change(input(), { target: { value: '   ' } })`
  // directly — `input().value` reads back `''`, not `'   '`. Whitespace
  // typed OR pasted into this field can never reach `value` state at all,
  // so `.trim()` is unobservable through THAT path in any browser, not
  // just in this test.
  //
  // It IS observable through the OTHER source of `value`: `useState(
  // currentEmail ?? '')`'s initial value, which is never routed through the
  // DOM's sanitizing setter — if the STORED address itself carries
  // whitespace (a dirty write from before this trim existed, or a future
  // caller), `value` starts out un-sanitized.
  it('a currentEmail prop carrying whitespace is trimmed before the noop check (kills the value.trim()->value mutant)', () => {
    renderDialog({ currentEmail: '  padded@example.com  ' })
    // Real code: trimmed = '  padded@example.com  '.trim() =
    // 'padded@example.com', which does NOT equal the untrimmed
    // currentEmail — isNoop is false, submit stays enabled. The mutant
    // keeps trimmed identical to currentEmail — isNoop true, disabled.
    expect(submitButton()).not.toBeDisabled()
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

describe('ChangePersonalEmailDialog — error-state styling (mutation-gate closure)', () => {
  function label() {
    return screen.getByText('Личный email')
  }

  it('the field never renders empty (spellcheck stays off, per EMAIL_NO_AUTOFILL posture)', () => {
    renderDialog({ currentEmail: null })
    expect(input()).toHaveAttribute('spellcheck', 'false')
  })

  it('no error paragraph exists in the DOM at all when there is no error (not just an empty one)', () => {
    renderDialog({ currentEmail: null })
    // Real code: `error && <p>...</p>` — `error` is `null` initially, so
    // the whole expression is `null`, nothing renders. The `||` mutant
    // would instead render `<p data-testid="change-personal-email-error"
    // className="text-xs text-destructive">{null}</p>` — an EMPTY
    // paragraph, present but textless — which `queryByText` alone cannot
    // distinguish from "does not exist"; `queryByTestId` can.
    expect(screen.queryByTestId('change-personal-email-error')).not.toBeInTheDocument()
    // Label mirrors the same guard — `error && 'text-destructive'` — and
    // must not carry the destructive class before any error exists either.
    expect(label().className).not.toContain('text-destructive')
  })

  it('once an error exists, BOTH the label and a real (non-empty) error paragraph turn destructive', async () => {
    renderDialog({ currentEmail: null })
    const user = userEvent.setup()
    await user.type(input(), 'not-an-email')
    await user.tab()
    const errorParagraph = await screen.findByTestId('change-personal-email-error')
    expect(errorParagraph).toHaveTextContent('Некорректный email')
    expect(errorParagraph.className).toContain('text-destructive')
    expect(label().className).toContain('text-destructive')
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

  // mutation-gate closure: `onOpenChange={(o) => !o && onClose()}` mutated
  // to `() => undefined` — `open` is a hardcoded `true` prop, never wired
  // to any state in THIS isolated render, so a REAL Escape/outside-click
  // close cannot be observed as an unmount here either way (Radix's
  // controlled-`open` semantics keep it rendered regardless of what its
  // internal close intent does) — only the CALLBACK firing is observable
  // via THIS helper.
  it('pressing Escape fires onClose via onOpenChange (kills the onOpenChange ArrowFunction->undefined mutant)', async () => {
    const { onClose } = renderDialog({ currentEmail: CURRENT_PERSONAL })
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// `renderDialog` above hardcodes `open` to `true` with no parent reacting to
// `onClose` — the dialog never actually unmounts there. This harness wires a
// real `open` boolean around the dialog instead, so `onClose` genuinely
// tears it down — used below to pin that the full open/Escape/close cycle
// works through a real parent, not just through the mocked callback.
function TogglingDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button data-testid="persistent-trigger" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <ChangePersonalEmailDialog
          userId="u-1"
          currentEmail={CURRENT_PERSONAL}
          workEmail={WORK_EMAIL}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

describe('ChangePersonalEmailDialog — closes end-to-end through a real toggle (not the hardcoded-open harness above)', () => {
  it('Escape closes the dialog when a real parent unmounts it on onClose (unlike renderDialog above, which cannot)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TogglingDialog />
      </QueryClientProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('persistent-trigger'))
    expect(screen.getByRole('heading', { name: 'Изменить личный email' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Изменить личный email' }),
      ).not.toBeInTheDocument(),
    )
  })
})
