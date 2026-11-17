/**
 * ResumeFactsForm, section by section: every field is labelled, typed into, saved
 * with the exact payload, and shows its error after blur. Plus the draft rules
 * (echo of an own save, job keys) and the add limits. Split from
 * ResumeFactsForm.test.tsx, which wires the real hooks.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_RESUME_FACTS,
  RESUME_LIMITS,
  type ResumeFacts,
  type ResumeFactsExperience,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeFactsForm, moveItem, type ResumeFactsFormProps } from '../ResumeFactsForm'

const STUB_JOBS_AT = RESUME_LIMITS.experience - 1 // render-heavy cap test only; every other test renders 0-2 jobs

vi.mock('../ResumeFactsJob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ResumeFactsJob')>()
  return {
    ...actual,
    JobBlock: (props: Parameters<typeof actual.JobBlock>[0]) =>
      props.count >= STUB_JOBS_AT ? null : <actual.JobBlock {...props} />,
  }
})

const NOW = new Date('2026-11-11T12:00:00Z')

const job = (changes: Partial<ResumeFactsExperience> = {}): ResumeFactsExperience => ({
  company: 'Acme',
  role: 'Backend Engineer',
  location: null,
  start: '2020-01',
  end: null,
  current: true,
  technologies: [],
  notes: ['Built the billing service'],
  ...changes,
})

const BASE: ResumeFacts = {
  ...EMPTY_RESUME_FACTS,
  headline: 'Backend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  skills: ['Go', 'Kubernetes', 'PostgreSQL', 'Docker', 'gRPC'],
  experience: [job()],
  languages: [{ name: 'English', level: 'C1' }],
}

const onSave = vi.fn<ResumeFactsFormProps['onSave']>()
const onSubmit = vi.fn<ResumeFactsFormProps['onSubmit']>()

function Form(props: Partial<ResumeFactsFormProps>) {
  return (
    <I18nTestProvider>
      <ResumeFactsForm
        facts={BASE}
        displayName="Alex Doe"
        disabled={false}
        now={NOW}
        onSave={onSave}
        onSubmit={onSubmit}
        {...props}
      />
    </I18nTestProvider>
  )
}

function renderForm(props: Partial<ResumeFactsFormProps> = {}, extra?: ReactNode) {
  const view = render(
    <>
      {extra}
      <Form {...props} />
    </>,
  )
  return {
    ...view,
    rerenderForm: (next: Partial<ResumeFactsFormProps>) =>
      view.rerender(
        <>
          {extra}
          <Form {...next} />
        </>,
      ),
  }
}

/** Clicks Save and returns the payload it sent. */
async function save(): Promise<ResumeFacts> {
  const calls = onSave.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти чернетку' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(calls + 1))
  return onSave.mock.calls[calls]![0]
}

const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } })

/** The field shows `message` under it once blurred, tied by aria-describedby. */
function expectErrorAfterBlur(field: HTMLElement, message: string) {
  expect(field).not.toHaveAttribute('aria-invalid')
  fireEvent.blur(field)
  expect(field).toHaveAttribute('aria-invalid', 'true')
  expect(field).toHaveAccessibleDescription(message)
}

const NON_LATIN = 'Пишіть лише латиницею — резюме англійською'

beforeEach(async () => {
  vi.clearAllMocks()
  onSave.mockResolvedValue(undefined)
  onSubmit.mockResolvedValue(undefined)
  await loadCatalog('uk')
})

describe('moveItem', () => {
  it('moves forward, backward, to the first and to the last place', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('an index out of range on either side leaves a copy', () => {
    const items = ['a', 'b', 'c']
    for (const [from, to] of [
      [-1, 0],
      [0, -1],
      [0, 3],
      [3, 0],
      [5, 1],
    ] as const) {
      const moved = moveItem(items, from, to)
      expect(moved).toEqual(['a', 'b', 'c'])
      expect(moved).not.toBe(items)
    }
  })
})

describe('the main card', () => {
  it('headline, city and country are labelled, typed and saved together', async () => {
    renderForm()
    type(screen.getByLabelText('Цільова посада'), 'Platform Engineer')
    type(screen.getByLabelText('Місто'), 'Lviv')
    type(screen.getByLabelText('Країна'), 'Poland')
    const payload = await save()
    expect(payload.headline).toBe('Platform Engineer')
    expect(payload.location).toEqual({ city: 'Lviv', country: 'Poland' })
  })

  it('a field without an error has no aria-describedby at all', () => {
    renderForm()
    const headline = screen.getByLabelText('Цільова посада')
    fireEvent.blur(headline)
    expect(headline).not.toHaveAttribute('aria-describedby')
  })

  it('a blank headline and a non-Latin city or country show their errors after blur', () => {
    renderForm()
    const headline = screen.getByLabelText('Цільова посада')
    type(headline, '')
    expectErrorAfterBlur(headline, 'Вкажіть цільову посаду')
    const city = screen.getByLabelText('Місто')
    type(city, 'Київ')
    expectErrorAfterBlur(city, NON_LATIN)
    const country = screen.getByLabelText('Країна')
    type(country, 'Україна')
    expectErrorAfterBlur(country, NON_LATIN)
  })

  it('an error line holds the message text only', () => {
    const { container } = renderForm()
    const headline = screen.getByLabelText('Цільова посада')
    type(headline, '')
    fireEvent.blur(headline)
    expect(container.innerHTML).toContain('text-destructive">Вкажіть цільову посаду</p>')
  })

  it('the work format shows its placeholder, the saved value, and saves a new choice', async () => {
    const user = userEvent.setup()
    const { unmount } = renderForm({ facts: { ...BASE, workFormat: 'remote' } })
    expect(screen.getByLabelText('Формат роботи')).toHaveTextContent('Віддалено')
    unmount()

    renderForm()
    const trigger = screen.getByLabelText('Формат роботи')
    expect(trigger).toHaveTextContent('Формат роботи')
    await user.click(trigger)
    const listbox = await screen.findByRole('listbox')
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Віддалено', 'Гібридно', 'В офісі'])
    await user.click(within(listbox).getByRole('option', { name: 'Гібридно' }))
    expect((await save()).workFormat).toBe('hybrid')
  })
})

describe('skills', () => {
  it('blank lines stay while typing and are dropped from the saved payload', async () => {
    renderForm()
    const skills = screen.getByRole('textbox', { name: 'Навички' })
    type(skills, 'Go\n\n  \nRust')
    expect(skills).toHaveValue('Go\n\n  \nRust')
    expect((await save()).skills).toEqual(['Go', 'Rust'])
  })

  it('too few skills shows the hint and the error, in that order, after blur', () => {
    renderForm({ facts: { ...BASE, skills: ['Go'] } })
    const skills = screen.getByRole('textbox', { name: 'Навички' })
    expectErrorAfterBlur(
      skills,
      'По одній навичці в рядку Потрібно щонайменше 5 навичок разом із технологіями з досвіду',
    )
  })

  it('the counter adds own skills and new ones from jobs, and hides at five', () => {
    const facts = {
      ...BASE,
      skills: ['Go', 'Rust'],
      experience: [job({ technologies: ['Go', 'Kotlin'] })],
    }
    const { unmount } = renderForm({ facts })
    expect(screen.getByText('2 + 1 з досвіду = 3 з 5')).toBeInTheDocument()
    unmount()

    renderForm({ facts: { ...BASE, skills: ['a', 'b', 'c', 'd'] } })
    expect(screen.getByText('4 + 0 з досвіду = 4 з 5')).toBeInTheDocument()
  })

  it('five skills hide the counter', () => {
    renderForm()
    expect(screen.queryByText(/з досвіду =/)).not.toBeInTheDocument()
  })
})

const TWO_JOBS: ResumeFacts = {
  ...BASE,
  experience: [job({ role: 'First role' }), job({ role: 'Second role', company: 'Beta' })],
}
const tech = (position: number) =>
  screen.getByPlaceholderText(`Технології, місце роботи ${position}`)
const role = (position: number) => screen.getByLabelText(`Посада, місце роботи ${position}`)

describe('experience', () => {
  it('blank note lines are dropped at save, the rest of the job is kept', async () => {
    renderForm()
    type(screen.getByLabelText('Нотатки, місце роботи 1'), 'Did A\n\n \nDid B')
    expect((await save()).experience).toEqual([job({ notes: ['Did A', 'Did B'] })])
  })

  it('an edit to job 2 leaves job 1 as it was', async () => {
    renderForm({ facts: TWO_JOBS })
    type(screen.getByLabelText('Компанія, місце роботи 2'), 'Gamma')
    const payload = await save()
    expect(payload.experience.map((j) => j.company)).toEqual(['Acme', 'Gamma'])
  })

  it('Add appends an empty job and keeps the text typed in the others', async () => {
    renderForm()
    type(tech(1), 'Kotl')
    fireEvent.click(screen.getByRole('button', { name: 'Додати місце роботи' }))
    expect(tech(1)).toHaveValue('Kotl')
    const payload = await save()
    expect(payload.experience).toEqual([
      job(),
      {
        company: '',
        role: '',
        location: null,
        start: null,
        end: null,
        current: false,
        technologies: [],
        notes: [],
      },
    ])
  })

  it('moving a job down saves the new order and carries its typed text along', async () => {
    renderForm({ facts: TWO_JOBS })
    type(tech(1), 'Kotl')
    fireEvent.click(screen.getByRole('button', { name: 'Перемістити місце роботи 1 вниз' }))
    expect(role(1)).toHaveValue('Second role')
    expect(tech(2)).toHaveValue('Kotl')
    expect((await save()).experience.map((j) => j.role)).toEqual(['Second role', 'First role'])
  })

  it('jobs that arrive from the server get their own keys', () => {
    const { rerenderForm } = renderForm()
    rerenderForm({ facts: TWO_JOBS })
    type(tech(2), 'Kotl')
    fireEvent.click(screen.getByRole('button', { name: 'Видалити місце роботи 1' }))
    expect(role(1)).toHaveValue('Second role')
    expect(tech(1)).toHaveValue('Kotl')
  })

  it('no jobs: the issue focuses Add and shows its error under it', () => {
    renderForm({ facts: { ...BASE, experience: [] } })
    const list = screen.getByRole('list', { name: 'Незаповнені поля' })
    fireEvent.click(within(list).getByRole('button', { name: /^Досвід роботи/ }))
    expect(screen.getByRole('button', { name: 'Додати місце роботи' })).toHaveFocus()
    const form = screen.getByTestId('resume-facts-form')
    expect(within(form).getByText('Додайте хоча б одне місце роботи')).toBeInTheDocument()
  })

  it('the month pickers stop at this month', async () => {
    const user = userEvent.setup()
    renderForm({ facts: { ...BASE, experience: [job({ start: '2026-01' })] } })
    await user.click(screen.getByLabelText('Місяць початку, місце роботи 1'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: /^Листопад/ })).not.toHaveAttribute(
      'data-disabled',
    )
    expect(within(listbox).getByRole('option', { name: /^Грудень/ })).toHaveAttribute(
      'data-disabled',
    )
  })

  it('in a single-digit month the pickers stop at that month too', async () => {
    const user = userEvent.setup()
    renderForm({
      facts: { ...BASE, experience: [job({ start: '2026-01' })] },
      now: new Date('2026-03-15T12:00:00Z'),
    })
    await user.click(screen.getByLabelText('Місяць початку, місце роботи 1'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: /^Березень/ })).not.toHaveAttribute(
      'data-disabled',
    )
    expect(within(listbox).getByRole('option', { name: /^Квітень/ })).toHaveAttribute(
      'data-disabled',
    )
  })

  it('Add is disabled at 30 jobs and enabled below', () => {
    const many = (n: number) => ({ ...BASE, experience: Array.from({ length: n }, () => job()) })
    const { unmount } = renderForm({ facts: many(30) })
    expect(screen.getByTestId('resume-facts-experience-add')).toBeDisabled()
    unmount()
    renderForm({ facts: many(29) })
    expect(screen.getByTestId('resume-facts-experience-add')).toBeEnabled()
  })
})

describe('the draft and the server value', () => {
  it('an outside change during an own save is announced, and the echo then clears it', async () => {
    onSave.mockReturnValue(new Promise(() => {}))
    const { rerenderForm } = renderForm()
    const headline = screen.getByLabelText('Цільова посада')
    type(headline, 'A')
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти чернетку' }))
    type(headline, 'AB')

    rerenderForm({ facts: { ...BASE, headline: 'Other' } })
    expect(screen.getByTestId('resume-facts-server-changed')).toBeInTheDocument()

    rerenderForm({ facts: { ...BASE, headline: 'A' } })
    expect(screen.queryByTestId('resume-facts-server-changed')).not.toBeInTheDocument()
    expect(headline).toHaveValue('AB')
  })

  it('a refetch with the same content under a dirty draft is not announced', () => {
    const { rerenderForm } = renderForm()
    type(screen.getByLabelText('Цільова посада'), 'Typing')
    rerenderForm({ facts: { ...BASE } })
    expect(screen.queryByTestId('resume-facts-server-changed')).not.toBeInTheDocument()
  })

  it('dirty is reported to the current listener, and unmount reports clean', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerenderForm, unmount } = renderForm({ onDirtyChange: first })
    type(screen.getByLabelText('Цільова посада'), 'Typing')
    expect(first).toHaveBeenLastCalledWith(true)
    rerenderForm({ onDirtyChange: second })
    expect(second).toHaveBeenLastCalledWith(true)
    unmount()
    expect(second).toHaveBeenLastCalledWith(false)
  })

  it('Save and Submit each show their own spinner while pending', () => {
    onSave.mockReturnValue(new Promise(() => {}))
    const { unmount } = renderForm()
    type(screen.getByLabelText('Цільова посада'), 'Typing')
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти чернетку' }))
    expect(screen.getByTestId('resume-facts-save').innerHTML).toContain('animate-spin')
    expect(screen.getByTestId('resume-facts-submit').innerHTML).not.toContain('animate-spin')
    unmount()

    onSubmit.mockReturnValue(new Promise(() => {}))
    renderForm()
    fireEvent.click(screen.getByRole('button', { name: 'Надіслати на перевірку' }))
    expect(screen.getByTestId('resume-facts-submit').innerHTML).toContain('animate-spin')
    expect(screen.getByTestId('resume-facts-save').innerHTML).not.toContain('animate-spin')
  })

  it('Submit saves unsaved facts silently first, and does not save clean ones', async () => {
    const { unmount } = renderForm()
    fireEvent.click(screen.getByRole('button', { name: 'Надіслати на перевірку' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSave).not.toHaveBeenCalled()
    unmount()

    renderForm()
    type(screen.getByLabelText('Цільова посада'), 'Platform Engineer')
    fireEvent.click(screen.getByRole('button', { name: 'Надіслати на перевірку' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSave).toHaveBeenCalledWith(
      { ...BASE, headline: 'Platform Engineer' },
      { silent: true },
    )
  })

  it('a run that disables the form hands a focused field to the checking line', async () => {
    const extra = (
      <p id="resume-confirm-checking" tabIndex={-1}>
        checking
      </p>
    )
    const { rerenderForm } = renderForm({}, extra)
    act(() => screen.getByLabelText('Цільова посада').focus())
    rerenderForm({ disabled: true })
    await waitFor(() => expect(screen.getByText('checking')).toHaveFocus())
  })

  it('the panel column and the dimmed fieldset follow the disabled flag', () => {
    const { container, rerenderForm } = renderForm()
    expect(container.innerHTML).toContain('lg:grid-cols-[minmax(0,1fr)_304px]')
    expect(container.innerHTML).toContain('class="grid gap-4 lg:items-start')
    const fieldset = screen.getByTestId('resume-facts-form')
    expect(fieldset).toHaveClass('min-w-0', 'space-y-4', 'lg:order-1')
    expect(fieldset).not.toHaveClass('opacity-50')
    rerenderForm({ disabled: true })
    expect(container.innerHTML).not.toContain('lg:grid-cols-[minmax(0,1fr)_304px]')
    expect(fieldset).toHaveClass('opacity-50')
  })
})

/** Row `n` (0-based) of the controls labelled by the visible `label`. */
const nth = (label: string, n: number) => screen.getAllByLabelText(label)[n]!
const many = <T,>(n: number, item: T) => Array.from({ length: n }, () => item)

describe('education', () => {
  const EDU = { institution: 'KPI', degree: 'BSc', startYear: 2010, endYear: 2014 }

  it('no rows: no rows box; Add appends an empty row', async () => {
    renderForm()
    expect(screen.queryByTestId('resume-facts-education-rows')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Додати освіту' }))
    expect(screen.getByTestId('resume-facts-education-rows')).toBeInTheDocument()
    expect(screen.getByText('Освіта 1')).toBeInTheDocument()
    expect((await save()).education).toEqual([
      { institution: '', degree: '', startYear: null, endYear: null },
    ])
  })

  it('shows the saved years, saves typed values in row 2 only, and a cleared year as null', async () => {
    renderForm({ facts: { ...BASE, education: [EDU, EDU] } })
    expect(screen.getByLabelText('Рік початку, освіта 1')).toHaveValue(2010)
    expect(screen.getByLabelText('Рік завершення, освіта 1')).toHaveValue(2014)
    type(nth('Навчальний заклад', 1), 'MIT')
    type(nth('Ступінь / спеціальність', 1), 'MSc')
    type(nth('Рік початку', 1), '2015')
    type(nth('Рік завершення', 1), '')
    expect(screen.getByLabelText('Навчальний заклад, освіта 2')).toHaveValue('MIT')
    expect(screen.getByLabelText('Ступінь / спеціальність, освіта 2')).toHaveValue('MSc')
    expect((await save()).education).toEqual([
      EDU,
      { institution: 'MIT', degree: 'MSc', startYear: 2015, endYear: null },
    ])
  })

  it('Remove drops its own row', async () => {
    renderForm({ facts: { ...BASE, education: [EDU, { ...EDU, institution: 'MIT' }] } })
    fireEvent.click(screen.getByRole('button', { name: 'Видалити освіту 1' }))
    expect((await save()).education).toEqual([{ ...EDU, institution: 'MIT' }])
  })

  it('non-Latin names and an end before the start show their errors after blur', () => {
    renderForm({ facts: { ...BASE, education: [{ ...EDU, startYear: 2014, endYear: 2010 }] } })
    const institution = nth('Навчальний заклад', 0)
    type(institution, 'КПІ')
    expectErrorAfterBlur(institution, NON_LATIN)
    const degree = nth('Ступінь / спеціальність', 0)
    type(degree, 'Бакалавр')
    expectErrorAfterBlur(degree, NON_LATIN)
    expectErrorAfterBlur(nth('Рік завершення', 0), 'Кінець не може бути раніше за початок')
  })

  it('Add is disabled at 20 rows and enabled below', () => {
    const { unmount } = renderForm({ facts: { ...BASE, education: many(20, EDU) } })
    expect(screen.getByRole('button', { name: 'Додати освіту' })).toBeDisabled()
    unmount()
    renderForm({ facts: { ...BASE, education: many(19, EDU) } })
    expect(screen.getByRole('button', { name: 'Додати освіту' })).toBeEnabled()
  })
})

describe('languages', () => {
  it('name and level of a new row are saved for that row only', async () => {
    const user = userEvent.setup()
    renderForm()
    fireEvent.click(screen.getByRole('button', { name: 'Додати мову' }))
    type(screen.getByLabelText('Мова, рядок 2'), 'German')
    expect(nth('Мова', 1)).toHaveValue('German')
    const level = screen.getByLabelText('Рівень, рядок 2')
    expect(nth('Рівень', 1)).toBe(level)
    await user.click(level)
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: 'Рідна' })).toBeInTheDocument()
    await user.click(within(listbox).getByRole('option', { name: 'C1' }))
    expect((await save()).languages).toEqual([
      { name: 'English', level: 'C1' },
      { name: 'German', level: 'C1' },
    ])
  })

  it('a new row starts at B2 with no name', async () => {
    renderForm({ facts: { ...BASE, languages: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Додати мову' }))
    expect((await save()).languages).toEqual([{ name: '', level: 'B2' }])
  })

  it('Remove drops its own row', async () => {
    const languages = [
      { name: 'English', level: 'C1' as const },
      { name: 'German', level: 'native' as const },
    ]
    renderForm({ facts: { ...BASE, languages } })
    expect(screen.getByLabelText('Рівень, рядок 2')).toHaveTextContent('Рідна')
    fireEvent.click(screen.getByRole('button', { name: 'Видалити мову 1' }))
    expect((await save()).languages).toEqual([{ name: 'German', level: 'native' }])
  })

  it('a non-Latin name shows its error; no English shows the error under Add', () => {
    const { unmount } = renderForm()
    const name = nth('Мова', 0)
    type(name, 'Англійська')
    expectErrorAfterBlur(name, NON_LATIN)
    unmount()

    renderForm({ facts: { ...BASE, languages: [] } })
    const list = screen.getByRole('list', { name: 'Незаповнені поля' })
    fireEvent.click(within(list).getByRole('button', { name: /^Мови/ }))
    const form = screen.getByTestId('resume-facts-form')
    expect(within(form).getByText('Додайте англійську до мов')).toBeInTheDocument()
  })

  it('Add is disabled at 20 rows and enabled below', () => {
    const row = { name: 'English', level: 'C1' as const }
    const { unmount } = renderForm({ facts: { ...BASE, languages: many(20, row) } })
    expect(screen.getByRole('button', { name: 'Додати мову' })).toBeDisabled()
    unmount()
    renderForm({ facts: { ...BASE, languages: many(19, row) } })
    expect(screen.getByRole('button', { name: 'Додати мову' })).toBeEnabled()
  })
})

describe('links', () => {
  const LINK = { label: 'GitHub', url: 'https://github.com/alex' }

  it('no rows: no rows box; Add appends an empty row', async () => {
    renderForm()
    expect(screen.queryByTestId('resume-facts-links-rows')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Додати посилання' }))
    expect(screen.getByTestId('resume-facts-links-rows')).toBeInTheDocument()
    expect((await save()).links).toEqual([{ label: '', url: '' }])
  })

  it('label and url are labelled, typed and saved for that row only', async () => {
    renderForm({ facts: { ...BASE, links: [LINK, LINK] } })
    type(nth('Назва', 1), 'Site')
    const url = nth('Адреса посилання', 1)
    expect(screen.getAllByPlaceholderText('https://… або mailto:…')[1]).toBe(url)
    type(url, 'https://alex.dev')
    expect(url).toHaveAttribute('spellcheck', 'false')
    expect((await save()).links).toEqual([LINK, { label: 'Site', url: 'https://alex.dev' }])
  })

  it('Remove drops its own row', async () => {
    renderForm({ facts: { ...BASE, links: [LINK, { ...LINK, label: 'Site' }] } })
    fireEvent.click(screen.getByRole('button', { name: 'Видалити посилання 1' }))
    expect((await save()).links).toEqual([{ ...LINK, label: 'Site' }])
  })

  it('a blank label shows its error after blur', () => {
    renderForm({ facts: { ...BASE, links: [{ ...LINK, label: '' }] } })
    expectErrorAfterBlur(nth('Назва', 0), 'Вкажіть назву й адресу https:// або mailto:')
  })

  it('Add is disabled at 20 rows and enabled below', () => {
    const { unmount } = renderForm({ facts: { ...BASE, links: many(20, LINK) } })
    expect(screen.getByRole('button', { name: 'Додати посилання' })).toBeDisabled()
    unmount()
    renderForm({ facts: { ...BASE, links: many(19, LINK) } })
    expect(screen.getByRole('button', { name: 'Додати посилання' })).toBeEnabled()
  })
})
