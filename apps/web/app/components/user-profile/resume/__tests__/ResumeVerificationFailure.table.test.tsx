/**
 * ResumeVerificationFailure — the per-code copy and actions (design §10.3), the
 * report reasons (§10.5), where a report path points (§10.6), and the list
 * rules (R63, the row cap). Expected strings are copied from the design tables.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResumeVerificationReport } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeVerificationFailure, resolveReportPath } from '../ResumeVerificationFailure'

beforeEach(() => loadCatalog('uk'))

type Props = ComponentProps<typeof ResumeVerificationFailure>

function renderPanel(overrides: Partial<Props> = {}) {
  const props: Props = {
    code: 'INCOMPLETE',
    report: null,
    variant: 'failed',
    onFocusField: vi.fn(() => true),
    onRetry: vi.fn(),
    onChooseTemplate: vi.fn(),
    disabled: false,
    ...overrides,
  }
  render(<ResumeVerificationFailure {...props} />, { wrapper: I18nTestProvider })
  return props
}

const report = (...items: Array<[string, string]>): ResumeVerificationReport => ({
  gates: [{ gate: 'ats', ok: false, items: items.map(([path, reason]) => ({ path, reason })) }],
  fallbacks: [],
})

const TEMPORARY = 'Це тимчасово. Спробуйте ще раз за кілька хвилин.'
const FIX = 'Виправити факти'
const RETRY = 'Перевірити ще раз'
const TEMPLATE = 'Обрати шаблон'

describe('each code has its own title, body and actions (§10.3)', () => {
  it.each([
    [
      'INCOMPLETE',
      'Заповнено не все',
      'Перевірка не почалася: заповніть поля зі списку.',
      [FIX, RETRY],
    ],
    ['WRITER_UNAVAILABLE', 'Сервіс написання тексту недоступний', TEMPORARY, [RETRY]],
    ['ENTAILMENT_UNAVAILABLE', 'Сервіс звірки з фактами недоступний', TEMPORARY, [RETRY]],
    [
      'RENDER_FAILED',
      'Не вдалося зібрати PDF',
      'Спробуйте ще раз. Якщо повториться — змініть шаблон або зверніться до адміністратора.',
      [RETRY, TEMPLATE],
    ],
    [
      'ATS_CHECK_FAILED',
      'ATS не прочитав PDF',
      'Частина тексту не читається з PDF. Скоротіть поля зі списку або оберіть інший шаблон.',
      [FIX, RETRY, TEMPLATE],
    ],
    [
      'GLYPH_CHECK_FAILED',
      'Шрифт не показує частину символів',
      'У PDF випали символи з полів зі списку. Замініть їх звичайними латинськими літерами або оберіть інший шаблон.',
      [FIX, RETRY, TEMPLATE],
    ],
    [
      'LAYOUT_UNFIXABLE',
      'Резюме не вміщується в макет',
      'Резюме не вміщується у 2 сторінки або остання сторінка майже порожня. Скоротіть нотатки або змініть щільність в оформленні.',
      [FIX, RETRY],
    ],
    [
      'VISUAL_CHECK_FAILED',
      'PDF не пройшов візуальну перевірку',
      'На сторінці знайдено накладання або обрізаний текст. Скоротіть поля зі списку або оберіть інший шаблон.',
      [FIX, RETRY, TEMPLATE],
    ],
    ['VISUAL_CHECK_UNAVAILABLE', 'Візуальна перевірка недоступна', TEMPORARY, [RETRY]],
    [
      'STALLED',
      'Перевірка зупинилася',
      'Перевірка тривала надто довго й зупинилась. Запустіть її ще раз — факти збережено.',
      [RETRY],
    ],
  ] as const)('%s', (code, title, body, buttons) => {
    renderPanel({ code })
    const panel = within(screen.getByTestId('resume-verification-failure'))
    expect(panel.getByRole('heading', { level: 3 })).toHaveTextContent(title)
    expect(panel.getByText(body)).toBeInTheDocument()
    expect(panel.getByText('Не пройшло перевірку')).toBeInTheDocument()
    const actions = panel
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((text) => text === FIX || text === RETRY || text === TEMPLATE)
    expect(actions).toEqual(buttons)
  })
})

describe('the action buttons', () => {
  it('Fix is primary when present; Retry and Template are then outline', () => {
    renderPanel({ code: 'ATS_CHECK_FAILED' })
    expect(screen.getByRole('button', { name: FIX })).toHaveClass('bg-primary')
    expect(screen.getByRole('button', { name: RETRY })).toHaveClass('border')
    expect(screen.getByRole('button', { name: TEMPLATE })).toHaveClass('border')
  })

  it('Retry is primary when there is no Fix', () => {
    renderPanel({ code: 'RENDER_FAILED' })
    expect(screen.getByRole('button', { name: RETRY })).toHaveClass('bg-primary')
    expect(screen.getByRole('button', { name: TEMPLATE })).toHaveClass('border')
  })

  it('Retry and Template call their handlers', async () => {
    const props = renderPanel({ code: 'RENDER_FAILED' })
    await userEvent.click(screen.getByRole('button', { name: RETRY }))
    await userEvent.click(screen.getByRole('button', { name: TEMPLATE }))
    expect(props.onRetry).toHaveBeenCalledTimes(1)
    expect(props.onChooseTemplate).toHaveBeenCalledTimes(1)
  })

  it('a disabled panel disables every action', () => {
    renderPanel({ code: 'ATS_CHECK_FAILED', disabled: true })
    for (const name of [FIX, RETRY, TEMPLATE]) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })

  it('unsaved facts disable only Retry', () => {
    renderPanel({ code: 'ATS_CHECK_FAILED', retryDisabled: true })
    expect(screen.getByRole('button', { name: RETRY })).toBeDisabled()
    expect(screen.getByRole('button', { name: FIX })).toBeEnabled()
    expect(screen.getByRole('button', { name: TEMPLATE })).toBeEnabled()
  })

  it('a Retry-only code explains a Retry held by unsaved facts', () => {
    renderPanel({ code: 'WRITER_UNAVAILABLE', retryDisabled: true })
    expect(screen.getByTestId('resume-verification-retry-reason')).toBeInTheDocument()
  })
})

describe('Fix the facts focuses the first field the report names', () => {
  it('the first row that has a field', async () => {
    const props = renderPanel({
      report: report(['summary', 'EMPTY'], ['experience.0.role', 'EMPTY']),
    })
    await userEvent.click(screen.getByRole('button', { name: FIX }))
    expect(props.onFocusField).toHaveBeenCalledTimes(1)
    expect(props.onFocusField).toHaveBeenCalledWith('experience.0.role')
  })

  it('falls back to the headline when that field is not on screen', async () => {
    const onFocusField = vi.fn(() => false)
    renderPanel({ report: report(['experience.0.role', 'EMPTY']), onFocusField })
    await userEvent.click(screen.getByRole('button', { name: FIX }))
    expect(onFocusField.mock.calls).toEqual([['experience.0.role'], ['headline']])
  })

  it('goes to the headline when no row has a field', async () => {
    const props = renderPanel({ report: report(['summary', 'EMPTY']) })
    await userEvent.click(screen.getByRole('button', { name: FIX }))
    expect(props.onFocusField).toHaveBeenCalledTimes(1)
    expect(props.onFocusField).toHaveBeenCalledWith('headline')
  })
})

describe('the failing rows', () => {
  it('a row with a field is a button that focuses it; a plain row is not', async () => {
    const props = renderPanel({ report: report(['summary', 'EMPTY'], ['links.0.url', 'EMPTY']) })
    const items = within(screen.getByTestId('resume-verification-items'))
    expect(items.getAllByRole('listitem')).toHaveLength(2)
    expect(items.getAllByRole('button')).toHaveLength(1)
    await userEvent.click(items.getByRole('button'))
    expect(props.onFocusField).toHaveBeenCalledWith('links.0.url')
    expect(items.getByText('Про себе')).toBeInTheDocument()
  })

  it('only failed gates contribute rows', () => {
    renderPanel({
      report: {
        gates: [
          { gate: 'ok', ok: true, items: [{ path: 'summary', reason: 'EMPTY' }] },
          { gate: 'bad', ok: false, items: [{ path: 'headline', reason: 'EMPTY' }] },
        ],
        fallbacks: [],
      },
    })
    const items = within(screen.getByTestId('resume-verification-items'))
    expect(items.getAllByRole('listitem')).toHaveLength(1)
    expect(items.getByText('Цільова посада')).toBeInTheDocument()
  })

  it('shows at most 8 rows, then "і ще N"', () => {
    const many = Array.from({ length: 10 }, (_, i) => [`skills.${i}`, 'EMPTY'] as [string, string])
    renderPanel({ report: report(...many) })
    const list = screen.getByTestId('resume-verification-items')
    expect(within(list).getAllByRole('button')).toHaveLength(8)
    expect(within(list).getByText('і ще 2')).toBeInTheDocument()
  })

  it('exactly 8 rows have no "і ще" line', () => {
    const eight = Array.from({ length: 8 }, (_, i) => [`skills.${i}`, 'EMPTY'] as [string, string])
    renderPanel({ report: report(...eight) })
    expect(screen.queryByText(/і ще/)).toBeNull()
  })

  it('a list code with no failing items still shows the whole-resume row (R63)', () => {
    renderPanel({ code: 'ATS_CHECK_FAILED', report: null })
    const items = within(screen.getByTestId('resume-verification-items'))
    expect(items.getAllByRole('listitem')).toHaveLength(1)
    expect(items.getByText('Резюме загалом')).toBeInTheDocument()
    expect(items.getByText('автоматична перевірка не пройдена')).toBeInTheDocument()
  })

  it('a non-list code with no items shows no list', () => {
    renderPanel({ code: 'STALLED', report: null })
    expect(screen.queryByTestId('resume-verification-items')).toBeNull()
  })

  it('a non-list code still lists the items its report names', () => {
    renderPanel({ code: 'LAYOUT_UNFIXABLE', report: report(['pages.1', 'LAST_PAGE_UNDERFILLED']) })
    const items = within(screen.getByTestId('resume-verification-items'))
    expect(items.getByText('Сторінка 2')).toBeInTheDocument()
    expect(items.getByText('остання сторінка майже порожня')).toBeInTheDocument()
  })
})

describe('the warning variant', () => {
  it('names the kept version, the body, and a list only for a list code', () => {
    renderPanel({
      variant: 'warning',
      code: 'ATS_CHECK_FAILED',
      report: report(['headline', 'EMPTY']),
    })
    const warning = screen.getByTestId('resume-verification-warning')
    expect(warning).toHaveAttribute('role', 'status')
    expect(warning).toHaveTextContent(
      'Зміна шаблону чи оформлення не пройшла перевірку — залишено попередній варіант.',
    )
    expect(warning).toHaveTextContent('Частина тексту не читається з PDF.')
    // The title and the body are one sentence pair, a space apart.
    expect(warning.textContent).toContain('варіант. Частина')
    expect(within(warning).getByTestId('resume-verification-items')).toBeInTheDocument()
    expect(screen.queryByTestId('resume-verification-failure')).toBeNull()
    expect(screen.queryByRole('button', { name: RETRY })).toBeNull()
  })

  it('a non-list code warns without a list', () => {
    renderPanel({
      variant: 'warning',
      code: 'RENDER_FAILED',
      report: report(['headline', 'EMPTY']),
    })
    expect(screen.queryByTestId('resume-verification-items')).toBeNull()
  })
})

describe('report reasons read as their own line (§10.5)', () => {
  it.each([
    ['EMPTY', 'порожньо'],
    ['UNGROUNDED', 'немає у фактах'],
    ['NON_LATIN', 'не латиницею'],
    ['CONTACT_IN_TEXT', 'містить контакти'],
    ['NOT_SUPPORTED', 'шаблон це не підтримує'],
    ['HUMAN_EDITED', 'змінено вручну'],
    ['MISSING_TEXT', 'текст не знайдено в PDF'],
    ['HEADING_MISSING', 'немає заголовка розділу'],
    ['HEADING_ORDER', 'заголовки розділів не в тому порядку'],
    ['HIDDEN_SECTION_PRESENT', 'прихований розділ потрапив у PDF'],
    ['ITEM_ORDER', 'текст стоїть не у своєму місці роботи'],
    ['PERIOD_FORMAT', 'дати у неправильному форматі'],
    ['CONTACT_NOT_IN_BODY', 'немає в шапці першої сторінки'],
    ['REPLACEMENT_CHAR', 'нечитабельні символи'],
    ['LIGATURE', 'злиті літери (лігатури)'],
    ['LETTER_SPACED', 'заголовок набрано врозрядку'],
    ['TOO_MANY_PAGES', 'більше 2 сторінок'],
    ['TOO_LARGE', 'файл більший за 1 МБ'],
    ['UNREADABLE', 'PDF не читається як текст'],
    ['DROPPED_GLYPHS', 'символи випали з PDF'],
    ['LAST_PAGE_UNDERFILLED', 'остання сторінка майже порожня'],
    ['overflow', 'текст виходить за поле'],
    ['overlap', 'рядки накладаються'],
    ['ragged', 'нерівний край тексту'],
    ['orphan', 'висячий рядок'],
    ['broken-bullet', 'пункт розірвано'],
    ['uneven-spacing', 'нерівні відступи'],
    ['cut-off', 'текст обрізано'],
    ['BAD_INDEX', 'автоматична перевірка не пройдена'],
    ['SOMETHING_NEW', 'автоматична перевірка не пройдена'],
  ])('%s', (reason, text) => {
    renderPanel({ report: report(['headline', reason]) })
    expect(
      within(screen.getByTestId('resume-verification-items')).getByText(text),
    ).toBeInTheDocument()
  })
})

describe('resolveReportPath (§10.6)', () => {
  it.each([
    ['headline', 'headline', 'headline'],
    ['location.city', 'location.city', 'location.city'],
    ['location.country', 'location.country', 'location.country'],
    ['skills', 'skills', 'skills'],
    ['skills.2', 'skills.2', 'skills'],
    ['experience.1.period', 'experience.1.period', 'experience.1.start'],
    ['experience.0.bullets', 'experience.0.bullets', 'experience.0.notes'],
    ['experience.0.bullets.3', 'experience.0.bullets.3', 'experience.0.notes'],
    ['experience.2.company', 'experience.2.company', 'experience.2.company'],
    ['experience.2.role', 'experience.2.role', 'experience.2.role'],
    ['experience.2.location', 'experience.2.location', 'experience.2.location'],
    ['experience.2.start', 'experience.2.start', 'experience.2.start'],
    ['experience.2.end', 'experience.2.end', 'experience.2.end'],
    ['experience.0.notes', 'experience.0.notes', 'experience.0.notes'],
    ['experience.0.technologies.1', 'experience.0.technologies.1', 'experience.0.technologies'],
    ['education.0.period', 'education.0.period', 'education.0.startYear'],
    ['education.1.institution', 'education.1.institution', 'education.1.institution'],
    ['education.1.degree', 'education.1.degree', 'education.1.degree'],
    ['education.1.startYear', 'education.1.startYear', 'education.1.startYear'],
    ['education.1.endYear', 'education.1.endYear', 'education.1.endYear'],
    ['languages.0', 'languages.0', 'languages.0.name'],
    ['languages.0.name', 'languages.0.name', 'languages.0.name'],
    ['links.0.label', 'links.0.label', 'links.0.label'],
    ['links.0.url', 'links.0.url', 'links.0.url'],
    ['links.1', 'links.1', 'links.1.label'],
    // Bracket paths from the ATS checker are dot paths.
    ['experience[0].period', 'experience.0.period', 'experience.0.start'],
    ['links[12]', 'links.12', 'links.12.label'],
    // Resume-level paths: a label, no field.
    ['', '', null],
    ['summary', 'summary', null],
    ['displayName', 'displayName', null],
    ['email', 'email', null],
    ['pages.3', 'pages.3', null],
    // Unknown paths: the section row, or the whole resume.
    ['experience.0.foo', 'experience', 'experience.add'],
    ['education.0.foo', 'education', 'education.0.institution'],
    ['languages.0.level', 'languages', 'languages.add'],
    ['links.0.foo', 'links', 'links.0.label'],
    ['headline.x', 'headline', 'headline'],
    ['skills.1.x', 'skills', 'skills'],
    ['skills.x', 'skills', 'skills'],
    ['pages.x', '', null],
    ['summary.x', '', null],
    ['myskills', '', null],
    ['xheadline', '', null],
    ['headlinex', '', null],
    ['xlocation.city', '', null],
    ['location.cityx', '', null],
    ['xexperience.0.period', '', null],
    ['experience.0.periodx', 'experience', 'experience.add'],
    ['experience.0.bulletsx', 'experience', 'experience.add'],
    ['experience.0.rolex', 'experience', 'experience.add'],
    ['experience.0.notesx', 'experience', 'experience.add'],
    ['education.0.periodx', 'education', 'education.0.institution'],
    ['education.0.degreex', 'education', 'education.0.institution'],
    ['languages.0.namex', 'languages', 'languages.add'],
    ['links.0.urlx', 'links', 'links.0.label'],
    ['links.0x', 'links', 'links.0.label'],
    ['xemail', '', null],
    ['emailx', '', null],
    ['pages.1x', '', null],
    // Multi-digit indexes.
    ['skills.12', 'skills.12', 'skills'],
    ['experience.12.period', 'experience.12.period', 'experience.12.start'],
    ['experience.12.bullets', 'experience.12.bullets', 'experience.12.notes'],
    ['experience.0.bullets.12', 'experience.0.bullets.12', 'experience.0.notes'],
    ['experience.12.role', 'experience.12.role', 'experience.12.role'],
    ['experience.12.notes', 'experience.12.notes', 'experience.12.notes'],
    ['experience.0.notes.12', 'experience.0.notes.12', 'experience.0.notes'],
    ['education.12.period', 'education.12.period', 'education.12.startYear'],
    ['education.12.degree', 'education.12.degree', 'education.12.degree'],
    ['languages.12', 'languages.12', 'languages.12.name'],
    ['links.12.url', 'links.12.url', 'links.12.url'],
    ['pages.12', 'pages.12', null],
    // A rule matches from the start of the path only.
    ['myskills.1', '', null],
    ['xexperience.0.bullets', '', null],
    ['xexperience.0.role', '', null],
    ['xexperience.0.notes', '', null],
    ['xeducation.0.period', '', null],
    ['xeducation.0.degree', '', null],
    ['xlanguages.0', '', null],
    ['xlinks.0.url', '', null],
    ['xlinks.0', '', null],
  ])('%s', (raw, labelPath, field) => {
    expect(resolveReportPath(raw)).toEqual({ labelPath, field })
  })
})
