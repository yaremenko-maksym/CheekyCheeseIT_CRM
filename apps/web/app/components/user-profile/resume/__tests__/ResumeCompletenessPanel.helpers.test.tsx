/**
 * The completeness helpers the facts form and the failure panel share: which
 * field an issue path focuses, the field's DOM id, focusing it, and the row label.
 */
import { render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import {
  factsFieldId,
  focusFactsField,
  issueFieldPath,
  useIssueLabel,
} from '../ResumeCompletenessPanel'

beforeEach(() => loadCatalog('uk'))

describe('issueFieldPath', () => {
  it.each([
    ['displayName', null],
    ['', null],
    ['experience', 'experience.add'],
    ['languages', 'languages.add'],
    ['skills', 'skills'],
    ['skills.3', 'skills'],
    ['experience.0.notes.2', 'experience.0.notes'],
    ['experience.12.technologies.0', 'experience.12.technologies'],
    ['experience.0.company', 'experience.0.company'],
    ['experience.0.a.b.c', 'experience.0.a.b.c'],
    ['education.1.degree.0', 'education.1.degree.0'],
    ['languages.0.name', 'languages.0.name'],
    ['headline', 'headline'],
    ['links.0.url', 'links.0.url'],
  ])('%j focuses %j', (path, field) => {
    expect(issueFieldPath(path)).toBe(field)
  })
})

describe('factsFieldId', () => {
  it('turns every dot of the path into a dash', () => {
    expect(factsFieldId('experience.0.company')).toBe('resume-facts-experience-0-company')
  })
})

describe('focusFactsField', () => {
  it('is false when the field is not on screen', () => {
    expect(focusFactsField('headline')).toBe(false)
  })

  it('focuses a control that carries the id and scrolls it to the centre', () => {
    render(<input id="resume-facts-headline" aria-label="headline" />)
    const input = screen.getByRole('textbox', { name: 'headline' })
    const scroll = vi.fn()
    input.scrollIntoView = scroll
    expect(focusFactsField('headline')).toBe(true)
    expect(input).toHaveFocus()
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
  })

  it('focuses the first control inside a wrapper', () => {
    render(
      <div id="resume-facts-experience-add">
        <span>label</span>
        <button type="button">Add</button>
      </div>,
    )
    expect(focusFactsField('experience.add')).toBe(true)
    expect(screen.getByRole('button', { name: 'Add' })).toHaveFocus()
  })

  it('focuses the wrapper itself when it holds no control, even without scrollIntoView', () => {
    render(
      <div id="resume-facts-skills" tabIndex={-1} data-testid="wrap">
        text
      </div>,
    )
    const wrap = screen.getByTestId('wrap')
    // An environment without scrollIntoView (jsdom) must still get the focus.
    Object.defineProperty(wrap, 'scrollIntoView', { value: undefined })
    expect(focusFactsField('skills')).toBe(true)
    expect(wrap).toHaveFocus()
  })
})

describe('useIssueLabel', () => {
  const label = (path: string) =>
    renderHook(() => useIssueLabel(), { wrapper: I18nTestProvider }).result.current(path)

  it.each([
    ['location.city', 'Місто'],
    ['location.country', 'Країна'],
    ['headline', 'Цільова посада'],
    ['summary', 'Про себе'],
    ['summary.0', 'Про себе'],
    ['displayName', 'Ім’я в шапці резюме'],
    ['email', 'Email у шапці резюме'],
    ['experience', 'Досвід роботи'],
    ['experience.0', 'Місце роботи 1'],
    ['experience.0.unknown', 'Місце роботи 1'],
    ['experience.1.company', 'Місце роботи 2 · Компанія'],
    ['experience.1.role', 'Місце роботи 2 · Посада'],
    ['experience.1.location', 'Місце роботи 2 · Локація (необов’язково)'],
    ['experience.1.start', 'Місце роботи 2 · Початок'],
    ['experience.1.end', 'Місце роботи 2 · Кінець'],
    ['experience.1.period', 'Місце роботи 2 · Період'],
    ['experience.1.notes', 'Місце роботи 2 · Нотатки'],
    ['experience.1.technologies', 'Місце роботи 2 · Технології'],
    ['experience.1.bullets', 'Місце роботи 2 · Пункти'],
    ['education', 'Освіта'],
    ['education.0', 'Освіта 1'],
    ['education.0.unknown', 'Освіта 1'],
    ['education.2.institution', 'Освіта 3 · Навчальний заклад'],
    ['education.2.degree', 'Освіта 3 · Ступінь / спеціальність'],
    ['education.2.startYear', 'Освіта 3 · Початок'],
    ['education.2.endYear', 'Освіта 3 · Кінець'],
    ['education.2.period', 'Освіта 3 · Період'],
    ['skills', 'Навички'],
    ['skills.4', 'Навички · Навичка 5'],
    ['languages', 'Мови'],
    ['languages.0', 'Мови · Мова 1'],
    ['links', 'Посилання'],
    ['links.1', 'Посилання · Посилання 2'],
    ['pages', 'Резюме загалом'],
    ['pages.0', 'Сторінка 1'],
    ['nothing', 'Резюме загалом'],
    ['', 'Резюме загалом'],
  ])('%j reads %j', (path, text) => {
    expect(label(path)).toBe(text)
  })
})
