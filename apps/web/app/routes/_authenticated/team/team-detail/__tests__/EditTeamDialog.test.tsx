/* Node access: an empty error paragraph has no text/role to query, so absence is asserted by selector. */
/* eslint-disable testing-library/no-node-access */
import { fireEvent, render, screen } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { EditTeamDialog } from '../components/EditTeamDialog'

interface Values {
  name: string
  telegram: string
  notes: string
  seniorSharePercentOverride: string
}

const DEFAULTS: Values = {
  name: 'Alpha',
  telegram: '',
  notes: '',
  seniorSharePercentOverride: '',
}

interface Spies {
  onOpenChange: (open: boolean) => void
  onSubmit: (value: Values) => void
}

function Harness({
  defaults = {},
  open = true,
  isPending = false,
  spies,
}: {
  defaults?: Partial<Values>
  open?: boolean
  isPending?: boolean
  spies: Spies
}) {
  const form = useForm({
    defaultValues: { ...DEFAULTS, ...defaults },
    onSubmit: ({ value }) => spies.onSubmit(value),
    // The name field has no validator of its own: a form-level validator is the
    // only way an error can reach it, and the dialog must still surface it.
    validators: {
      onChange: ({ value }) =>
        value.name === 'bad' ? { fields: { name: 'Name is not allowed' } } : undefined,
    },
  })
  return (
    <>
      <EditTeamDialog
        open={open}
        onOpenChange={spies.onOpenChange}
        form={form}
        isPending={isPending}
      />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
      <form.Subscribe selector={(s) => s.fieldMeta.seniorSharePercentOverride?.isTouched ?? false}>
        {(touched) => <output data-testid="override-touched">{String(touched)}</output>}
      </form.Subscribe>
    </>
  )
}

function renderDialog(
  opts: { defaults?: Partial<Values>; open?: boolean; isPending?: boolean } = {},
) {
  const spies = { onOpenChange: vi.fn(), onSubmit: vi.fn() }
  render(
    <I18nTestProvider>
      <Harness {...opts} spies={spies} />
    </I18nTestProvider>,
  )
  return spies
}

function values(): Values {
  return JSON.parse(screen.getByTestId('values').textContent ?? '{}') as Values
}

const OVERRIDE_INPUT = 'team-edit-senior-share-override-input'
const OVERRIDE_RESET = 'team-edit-senior-share-override-reset'

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('EditTeamDialog rendering', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByText('Редагувати команду')).toBeNull()
    expect(screen.queryByLabelText(/Назва/)).toBeNull()
  })

  it('renders title, description and the name, telegram and notes fields', () => {
    renderDialog({ defaults: { name: 'Alpha', telegram: 'https://t.me/a', notes: 'hi' } })
    expect(screen.getByText('Редагувати команду')).toBeTruthy()
    expect(
      screen.getByText('Редагування назви, Telegram-посилання та заміток команди.'),
    ).toBeTruthy()
    const name = screen.getByLabelText(/Назва/) as HTMLInputElement
    expect(name.id).toBe('edit-name')
    expect(name.value).toBe('Alpha')
    expect(name.placeholder).toBe('Назва команди')
    const tg = screen.getByLabelText('Telegram') as HTMLInputElement
    expect(tg.id).toBe('edit-telegram')
    expect(tg.type).toBe('url')
    expect(tg.value).toBe('https://t.me/a')
    expect(tg.placeholder).toBe('https://t.me/team_chat')
    expect(tg.getAttribute('autocapitalize')).toBe('off')
    expect(tg.getAttribute('autocorrect')).toBe('off')
    expect(tg.getAttribute('spellcheck')).toBe('false')
    expect(screen.getByText('Посилання на Telegram-чат команди')).toBeTruthy()
    const notes = screen.getByLabelText('Замітки') as HTMLTextAreaElement
    expect(notes.id).toBe('edit-notes')
    expect(notes.value).toBe('hi')
    expect(notes.placeholder).toBe('Внутрішні замітки…')
  })

  it('marks the name label as required', () => {
    renderDialog()
    const star = screen.getByText('*')
    expect(star.className).toContain('text-destructive')
  })
})

describe('EditTeamDialog field edits', () => {
  it('propagates name, telegram and notes edits into the shared form', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText(/Назва/), { target: { value: 'Beta' } })
    fireEvent.change(screen.getByLabelText('Telegram'), {
      target: { value: 'https://t.me/beta' },
    })
    fireEvent.change(screen.getByLabelText('Замітки'), { target: { value: 'note' } })
    expect(values()).toEqual({
      name: 'Beta',
      telegram: 'https://t.me/beta',
      notes: 'note',
      seniorSharePercentOverride: '',
    })
  })

  it('shows the telegram validation error for a non t.me link and clears it for a valid one', () => {
    renderDialog()
    const tg = screen.getByLabelText('Telegram')
    expect(screen.queryByText('Посилання має починатися з https://t.me/')).toBeNull()
    fireEvent.change(tg, { target: { value: 'http://example.com' } })
    const err = screen.getByText('Посилання має починатися з https://t.me/')
    expect(err.className).toContain('text-destructive')
    fireEvent.change(tg, { target: { value: 'https://t.me/ok' } })
    expect(screen.queryByText('Посилання має починатися з https://t.me/')).toBeNull()
  })

  it('renders a form-level name error under the field and nothing when valid', () => {
    renderDialog()
    const name = screen.getByLabelText(/Назва/)
    expect(document.querySelectorAll('p.text-destructive')).toHaveLength(0)
    fireEvent.change(name, { target: { value: 'bad' } })
    const err = screen.getByText('Name is not allowed')
    expect(err.tagName).toBe('P')
    expect(err.className).toContain('text-destructive')
    fireEvent.change(name, { target: { value: 'good' } })
    expect(screen.queryByText('Name is not allowed')).toBeNull()
    expect(document.querySelectorAll('p.text-destructive')).toHaveLength(0)
  })

  it('accepts an empty telegram link without an error', () => {
    renderDialog({ defaults: { telegram: 'https://t.me/x' } })
    fireEvent.change(screen.getByLabelText('Telegram'), { target: { value: '' } })
    expect(screen.queryByText('Посилання має починатися з https://t.me/')).toBeNull()
  })
})

describe('EditTeamDialog senior share override UI', () => {
  it('shows the default 26 and the not-set hint with no reset button when empty', () => {
    renderDialog()
    expect(screen.getByText('Частка сеньйора на рівні команди')).toBeTruthy()
    expect((screen.getByTestId(OVERRIDE_INPUT) as HTMLInputElement).value).toBe('26')
    expect(screen.getByText(/Не задано — діє частка сеньйора за замовчуванням/)).toBeTruthy()
    expect(screen.queryByText(/Задано для команди/)).toBeNull()
    expect(screen.queryByTestId(OVERRIDE_RESET)).toBeNull()
    // Rendering alone must not write an override into the form.
    expect(values().seniorSharePercentOverride).toBe('')
  })

  it('shows the stored override, the set hint and the reset button', () => {
    renderDialog({ defaults: { seniorSharePercentOverride: '40' } })
    expect((screen.getByTestId(OVERRIDE_INPUT) as HTMLInputElement).value).toBe('40')
    expect(screen.getByText(/Задано для команди/)).toBeTruthy()
    expect(screen.queryByText(/Не задано/)).toBeNull()
    expect(screen.getByTestId(OVERRIDE_RESET).textContent).toBe('Скинути')
  })

  it('treats a whitespace-only value as no override', () => {
    renderDialog({ defaults: { seniorSharePercentOverride: '   ' } })
    expect(screen.queryByTestId(OVERRIDE_RESET)).toBeNull()
    expect((screen.getByTestId(OVERRIDE_INPUT) as HTMLInputElement).value).toBe('26')
  })

  it('shows zero as a real override, not as unset', () => {
    renderDialog({ defaults: { seniorSharePercentOverride: '0' } })
    expect((screen.getByTestId(OVERRIDE_INPUT) as HTMLInputElement).value).toBe('0')
    expect(screen.getByTestId(OVERRIDE_RESET)).toBeTruthy()
  })

  it('clamps an out-of-range stored value into 0..100 for display', () => {
    renderDialog({ defaults: { seniorSharePercentOverride: '150' } })
    expect((screen.getByTestId(OVERRIDE_INPUT) as HTMLInputElement).value).toBe('100')
  })

  it('clamps a negative stored value up to 0 for display', () => {
    renderDialog({ defaults: { seniorSharePercentOverride: '-5' } })
    expect((screen.getByTestId(OVERRIDE_INPUT) as HTMLInputElement).value).toBe('0')
  })

  it('writes typed numbers into the form as strings, clamped to 0..100', () => {
    renderDialog()
    const input = screen.getByTestId(OVERRIDE_INPUT)
    fireEvent.change(input, { target: { value: '55' } })
    expect(values().seniorSharePercentOverride).toBe('55')
    fireEvent.change(input, { target: { value: '250' } })
    expect(values().seniorSharePercentOverride).toBe('100')
    fireEvent.change(input, { target: { value: '0' } })
    expect(values().seniorSharePercentOverride).toBe('0')
  })

  it('writes range slider moves into the form as strings', () => {
    renderDialog()
    const range = screen.getAllByLabelText('Частка сеньйора у відсотках')[0] as HTMLInputElement
    expect(range.type).toBe('range')
    expect(range.min).toBe('0')
    expect(range.max).toBe('100')
    fireEvent.change(range, { target: { value: '70' } })
    expect(values().seniorSharePercentOverride).toBe('70')
  })

  it('reset clears the override back to the empty string', () => {
    renderDialog({ defaults: { seniorSharePercentOverride: '40' } })
    fireEvent.click(screen.getByTestId(OVERRIDE_RESET))
    expect(values().seniorSharePercentOverride).toBe('')
    expect(screen.queryByTestId(OVERRIDE_RESET)).toBeNull()
    expect(screen.getByText(/Не задано/)).toBeTruthy()
  })

  it('marks the override field touched on blur of the number input', () => {
    renderDialog()
    expect(screen.getByTestId('override-touched').textContent).toBe('false')
    fireEvent.blur(screen.getByTestId(OVERRIDE_INPUT))
    expect(screen.getByTestId('override-touched').textContent).toBe('true')
  })
})

describe('EditTeamDialog footer and submit', () => {
  it('submit button is enabled with the save label when idle', () => {
    renderDialog()
    const save = screen.getByRole('button', { name: 'Зберегти' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    expect(save.type).toBe('submit')
  })

  it('disables submit and shows the saving label while pending', () => {
    renderDialog({ isPending: true })
    const save = screen.getByRole('button', { name: 'Зберігаємо…' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull()
  })

  it('submitting drives the shared form handleSubmit with the raw string values', async () => {
    const spies = renderDialog({ defaults: { seniorSharePercentOverride: '33' } })
    fireEvent.change(screen.getByLabelText(/Назва/), { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }))
    await vi.waitFor(() => expect(spies.onSubmit).toHaveBeenCalledTimes(1))
    expect(spies.onSubmit).toHaveBeenCalledWith({
      name: 'Gamma',
      telegram: '',
      notes: '',
      seniorSharePercentOverride: '33',
    })
  })

  it('cancel requests close without submitting', () => {
    const spies = renderDialog()
    const cancel = screen.getByRole('button', { name: 'Скасувати' }) as HTMLButtonElement
    expect(cancel.type).toBe('button')
    fireEvent.click(cancel)
    expect(spies.onOpenChange).toHaveBeenCalledWith(false)
    expect(spies.onSubmit).not.toHaveBeenCalled()
  })
})
