/**
 * ResumeCompletenessPanel — the live list of what blocks Submit (design §5.1).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { IssueRow, ResumeCompletenessPanel } from '../ResumeCompletenessPanel'

const noop = () => undefined

function renderPanel(props: Partial<Parameters<typeof ResumeCompletenessPanel>[0]> = {}) {
  const onSubmit = vi.fn()
  const onFocusField = vi.fn()
  render(
    <ResumeCompletenessPanel
      issues={[]}
      onFocusField={onFocusField}
      onSubmit={onSubmit}
      onSaveDraft={noop}
      canSave={false}
      disabled={false}
      pending={null}
      {...props}
    />,
    { wrapper: I18nTestProvider },
  )
  return { onSubmit, onFocusField }
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('ResumeCompletenessPanel', () => {
  it('Submit disabled while completeness lists issues', () => {
    const { onSubmit } = renderPanel({
      issues: [
        { path: 'headline', code: 'HEADLINE_MISSING' },
        { path: 'languages', code: 'ENGLISH_MISSING' },
      ],
    })
    const submit = screen.getByRole('button', { name: 'Надіслати на перевірку' })
    expect(submit).toBeDisabled()
    // The reason is text, tied to the button, not only the grey look.
    expect(submit).toHaveAccessibleDescription('Спершу заповніть поля зі списку')
    // The polite live region carries the count; it stays mounted (L-3).
    expect(screen.getByTestId('resume-completeness-live')).toHaveTextContent('2 поля')
    fireEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('enables Submit and shows the clean title once nothing is missing', () => {
    const { onSubmit } = renderPanel()
    expect(
      screen.getByRole('heading', { name: 'Усе заповнено — можна надсилати' }),
    ).toBeInTheDocument()
    // The clean state is announced by the same live region, not only shown.
    const live = screen.getByTestId('resume-completeness-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('Усе заповнено — можна надсилати')
    const submit = screen.getByRole('button', { name: 'Надіслати на перевірку' })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps Submit disabled while the form is disabled (a check is running)', () => {
    renderPanel({ disabled: true })
    expect(screen.getByRole('button', { name: 'Надіслати на перевірку' })).toBeDisabled()
  })

  it('disables Submit with the already-verified reason when alreadyVerified is set and facts are not changed (backlog 452)', () => {
    const { onSubmit } = renderPanel({ alreadyVerified: true })
    const submit = screen.getByRole('button', { name: 'Надіслати на перевірку' })
    expect(submit).toBeDisabled()
    expect(submit).toHaveAccessibleDescription(
      'Резюме вже підтверджено. Змініть факти, щоб надіслати його знову.',
    )
    // The polite region announces the refusal, not "ready to send".
    expect(screen.getByTestId('resume-completeness-live')).toHaveTextContent(
      'Резюме вже підтверджено. Змініть факти, щоб надіслати його знову.',
    )
    fireEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('enables Submit when alreadyVerified is set but canSave is true because facts changed (backlog 452)', () => {
    const { onSubmit } = renderPanel({ alreadyVerified: true, canSave: true })
    const submit = screen.getByRole('button', { name: 'Надіслати на перевірку' })
    expect(submit).toBeEnabled()
    expect(submit).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByTestId('resume-facts-submit-already-verified')).not.toBeInTheDocument()
    expect(screen.getByTestId('resume-completeness-live')).toHaveTextContent(
      'Усе заповнено — можна надсилати',
    )
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('shows only the completeness reason when an already-verified resume still lists issues (backlog 452)', () => {
    renderPanel({ alreadyVerified: true, issues: [{ path: 'headline', code: 'HEADLINE_MISSING' }] })
    const submit = screen.getByRole('button', { name: 'Надіслати на перевірку' })
    expect(submit).toBeDisabled()
    expect(submit).toHaveAccessibleDescription('Спершу заповніть поля зі списку')
    expect(screen.queryByTestId('resume-facts-submit-already-verified')).not.toBeInTheDocument()
    expect(screen.getByTestId('resume-completeness-live')).toHaveTextContent('1 поле')
  })

  it('labels each row by its field and its code text', () => {
    const { onFocusField } = renderPanel({
      issues: [{ path: 'experience.1.notes', code: 'NO_NOTES' }],
    })
    const row = screen.getByRole('button', { name: /Місце роботи 2 · Нотатки/ })
    expect(row).toHaveTextContent('Додайте хоча б одну нотатку про досягнення')
    fireEvent.click(row)
    expect(onFocusField).toHaveBeenCalledWith('experience.1.notes')
  })

  it('a row hands over its field path, not the issue path', () => {
    const { onFocusField } = renderPanel({
      issues: [
        { path: 'experience.0.notes.2', code: 'NO_NOTES' },
        { path: 'skills.3', code: 'NON_LATIN' },
      ],
    })
    const [job, skill] = screen.getAllByRole('button', { name: /Місце роботи 1|Навички/ })
    fireEvent.click(job!)
    fireEvent.click(skill!)
    expect(onFocusField.mock.calls).toEqual([['experience.0.notes'], ['skills']])
  })

  it('renders the profile-name issue as a plain row, not a button', () => {
    renderPanel({ issues: [{ path: 'displayName', code: 'NAME_NON_LATIN' }] })
    expect(screen.getByText('Ім’я в шапці резюме')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ім’я в шапці резюме/ })).toBeNull()
  })
})

const issues = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `skills.${i}`, code: 'TOO_FEW_SKILLS' as const }))

describe('every completeness code reads its own text', () => {
  it.each([
    ['HEADLINE_MISSING', 'Вкажіть цільову посаду'],
    ['NO_EXPERIENCE', 'Додайте хоча б одне місце роботи'],
    ['COMPANY_MISSING', 'Вкажіть компанію'],
    ['ROLE_MISSING', 'Вкажіть посаду'],
    ['START_MISSING', 'Вкажіть місяць початку'],
    ['END_MISSING', 'Вкажіть місяць завершення або позначте «Працюю тут зараз»'],
    ['END_BEFORE_START', 'Кінець не може бути раніше за початок'],
    ['START_IN_FUTURE', 'Початок не може бути в майбутньому'],
    [
      'END_IN_FUTURE',
      'Кінець не може бути в майбутньому. Якщо ви ще тут працюєте, позначте «Працюю тут зараз»',
    ],
    ['NO_NOTES', 'Додайте хоча б одну нотатку про досягнення'],
    ['TOO_FEW_SKILLS', 'Потрібно щонайменше 5 навичок разом із технологіями з досвіду'],
    ['ENGLISH_MISSING', 'Додайте англійську до мов'],
    ['NON_LATIN', 'Пишіть лише латиницею — резюме англійською'],
    ['NAME_NON_LATIN', 'Ім’я в шапці резюме має бути латиницею. Виправте його в шапці'],
    [
      'CONTACT_IN_TEXT',
      'Приберіть ім’я, email або телефон — контакти не потрапляють у текст резюме',
    ],
    ['LINK_INVALID', 'Вкажіть назву й адресу https:// або mailto:'],
    ['YEAR_INVALID', 'Рік має бути між 1950 і 2100'],
  ] as const)('%s', (code, text) => {
    renderPanel({ issues: [{ path: 'headline', code }] })
    expect(screen.getByText(text)).toBeInTheDocument()
  })
})

describe('the panel around the list', () => {
  it('is a region named by its title', () => {
    renderPanel({ issues: issues(1) })
    expect(screen.getByRole('region', { name: 'Що ще потрібно' })).toBeInTheDocument()
  })

  it('a clean panel has no count badge, no toggle and no list', () => {
    renderPanel()
    expect(screen.queryByRole('button', { name: /Показати|Сховати/ })).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByText('Спершу заповніть поля зі списку')).toBeNull()
  })

  it('five issues start expanded, and the toggle collapses them', () => {
    renderPanel({ issues: issues(5) })
    const toggle = screen.getByRole('button', { name: 'Сховати' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list')).toHaveClass('block')
    expect(screen.getByRole('list')).not.toHaveClass('hidden')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Показати' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByRole('list', { hidden: true })).toHaveClass('hidden')
  })

  it('six issues start collapsed below lg, with the count in the badge', () => {
    renderPanel({ issues: issues(6) })
    expect(screen.getByRole('button', { name: 'Показати' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByRole('list', { hidden: true })).toHaveClass('hidden')
    expect(screen.getAllByText('6 полів')).toHaveLength(2)
  })
})

describe('the two buttons', () => {
  const submit = () => screen.getByTestId('resume-facts-submit')
  const save = () => screen.getByTestId('resume-facts-save')

  it('a clean panel with a pending save blocks Submit', () => {
    renderPanel({ pending: 'save', canSave: true })
    expect(submit()).toBeDisabled()
    expect(save()).toBeDisabled()
    expect(save().innerHTML).toContain('animate-spin')
    expect(submit().innerHTML).not.toContain('animate-spin')
  })

  it('a pending submit spins on Submit only', () => {
    renderPanel({ pending: 'submit', canSave: true })
    expect(submit().innerHTML).toContain('animate-spin')
    expect(save().innerHTML).not.toContain('animate-spin')
  })

  it('Save is enabled only with changes, no check running and nothing pending', () => {
    const onSaveDraft = vi.fn()
    renderPanel({ canSave: true, onSaveDraft })
    expect(save()).toBeEnabled()
    expect(save().innerHTML).not.toContain('animate-spin')
    expect(submit().innerHTML).not.toContain('animate-spin')
    fireEvent.click(save())
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no changes', { canSave: false }],
    ['a check running', { canSave: true, disabled: true }],
  ])('Save is disabled with %s', (_, props) => {
    renderPanel(props)
    expect(save()).toBeDisabled()
  })
})

describe('IssueRow tone', () => {
  it.each([
    ['amber', 'bg-amber-500', 'bg-destructive'],
    [undefined, 'bg-destructive', 'bg-amber-500'],
  ] as const)('tone %s colours the dot %s', (tone, on, off) => {
    render(
      <ul>
        <IssueRow label="L" text="T" onFocus={null} {...(tone ? { tone } : {})} />
      </ul>,
    )
    expect(screen.getByTestId('resume-issue-dot')).toHaveClass(on)
    expect(screen.getByTestId('resume-issue-dot')).not.toHaveClass(off)
  })
})
