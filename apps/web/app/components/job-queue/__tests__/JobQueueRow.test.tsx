import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { jobSourceTypeSchema, type JobQueueListItemDto, type JobSourceType } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { JobQueueRow, sourceLabel } from '../JobQueueRow'

const NOW = new Date('2026-11-05T12:00:00.000Z')

function item(over: Partial<JobQueueListItemDto> = {}): JobQueueListItemDto {
  return {
    opportunityId: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    title: 'Senior React Engineer',
    companyName: 'Acme Labs',
    location: null,
    primarySource: {
      sourceRecordId: '22222222-2222-4222-8222-222222222222',
      sourceType: 'DOU_RSS',
      url: 'https://jobs.dou.ua/x',
    },
    applicationUrl: null,
    alsoSeenOnCount: 0,
    availability: 'OPEN',
    eligibility: 'LEAD',
    seniority: 'UNKNOWN',
    matchedKeywords: [],
    matchedSeniorCount: 0,
    submittedSeniorCount: 0,
    stopListedSeniorCount: 0,
    openedByTeam: false,
    hidden: false,
    publishedAt: '2026-11-02T12:00:00.000Z',
    firstSeenAt: '2026-11-03T12:00:00.000Z',
    ...over,
  }
}

function renderRow(
  over: Partial<JobQueueListItemDto> = {},
  props: Partial<Parameters<typeof JobQueueRow>[0]> = {},
) {
  const onOpen = vi.fn()
  render(<JobQueueRow item={item(over)} tab="NEW" role="HR" onOpen={onOpen} {...props} />, {
    wrapper: I18nTestProvider,
  })
  return { onOpen, row: screen.getByTestId('job-queue-row-11111111-1111-4111-8111-111111111111') }
}

describe('JobQueueRow', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await loadCatalog('uk')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders title, company and source as one button that opens the card', async () => {
    const { onOpen, row } = renderRow()
    expect(row.tagName).toBe('BUTTON')
    expect(row).toHaveTextContent('Senior React Engineer')
    expect(row).toHaveTextContent('Acme Labs')
    expect(screen.getByTestId('job-queue-row-source')).toHaveAccessibleName('Джерело: DOU')
    await userEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
  })

  describe('seniority and stack chips', () => {
    it('shows no seniority badge for UNKNOWN', () => {
      renderRow({ seniority: 'UNKNOWN' })
      expect(screen.queryByTestId('job-queue-row-seniority')).not.toBeInTheDocument()
    })

    it.each([
      ['MIDDLE', 'Мідл'],
      ['SENIOR', 'Сеньйор'],
      ['LEAD', 'Лід'],
    ] as const)('labels %s as %s', (seniority, label) => {
      renderRow({ seniority })
      expect(screen.getByTestId('job-queue-row-seniority')).toHaveTextContent(label)
    })

    it('renders no chip line at all with no badge and 0 keywords', () => {
      renderRow({ seniority: 'UNKNOWN', matchedKeywords: [] })
      expect(screen.queryByTestId('job-queue-row-chips')).not.toBeInTheDocument()
    })

    it('shows the badge without a keyword group for 0 keywords', () => {
      renderRow({ seniority: 'LEAD', matchedKeywords: [] })
      expect(screen.getByTestId('job-queue-row-chips')).toBeInTheDocument()
      expect(screen.queryByTestId('job-queue-row-keywords')).not.toBeInTheDocument()
    })

    it('shows the chip line for keywords without a badge', () => {
      renderRow({ seniority: 'UNKNOWN', matchedKeywords: ['go'] })
      expect(screen.getByTestId('job-queue-row-chips')).toContainElement(
        screen.getByTestId('job-queue-row-keyword'),
      )
    })

    it('styles the badge and the overflow as chips', () => {
      renderRow({ seniority: 'LEAD', matchedKeywords: ['a', 'b', 'c', 'd'] })
      expect(screen.getByTestId('job-queue-row-seniority')).toHaveClass('rounded-md', 'font-medium')
      expect(screen.getByTestId('job-queue-row-keywords-more')).toHaveClass(
        'rounded-md',
        'tabular-nums',
      )
    })

    it('shows 3 keywords without an overflow chip', () => {
      renderRow({ matchedKeywords: ['go', 'react', 'sql'] })
      const chips = within(screen.getByTestId('job-queue-row-keywords'))
      expect(chips.getAllByTestId('job-queue-row-keyword').map((c) => c.textContent)).toEqual([
        'go',
        'react',
        'sql',
      ])
      expect(chips.queryByTestId('job-queue-row-keywords-more')).not.toBeInTheDocument()
    })

    it('shows the first 3 of 7 keywords and +4', () => {
      renderRow({ matchedKeywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
      const chips = within(screen.getByTestId('job-queue-row-keywords'))
      expect(chips.getAllByTestId('job-queue-row-keyword').map((c) => c.textContent)).toEqual([
        'a',
        'b',
        'c',
      ])
      expect(chips.getByTestId('job-queue-row-keywords-more')).toHaveTextContent('+4')
    })

    it('shows a 4th keyword as +1', () => {
      renderRow({ matchedKeywords: ['a', 'b', 'c', 'd'] })
      expect(screen.getByTestId('job-queue-row-keywords-more')).toHaveTextContent('+1')
    })

    it('truncates a long keyword inside its chip and keeps it readable by title', () => {
      const long = 'k'.repeat(100)
      renderRow({ matchedKeywords: [long] })
      const chip = screen.getByTestId('job-queue-row-keyword')
      expect(chip).toHaveClass('truncate', 'max-w-full')
      expect(chip).toHaveAttribute('title', long)
    })

    it('renders chips as text, not as markup', () => {
      renderRow({ matchedKeywords: ['<img src=x>'] })
      expect(screen.getByTestId('job-queue-row-keyword').textContent).toBe('<img src=x>')
      expect(screen.queryByRole('img', { name: '' })).not.toBeInTheDocument()
    })

    it('keeps chips inside the row button with no nested interactive element', () => {
      const { row } = renderRow({ seniority: 'LEAD', matchedKeywords: ['a', 'b', 'c', 'd'] })
      expect(row).toContainElement(screen.getByTestId('job-queue-row-keywords-more'))
      expect(within(row).queryAllByRole('button')).toEqual([])
      expect(screen.getByTestId('job-queue-row-seniority').tagName).toBe('SPAN')
      expect(screen.getByTestId('job-queue-row-keywords').tagName).toBe('SPAN')
    })
  })

  it('shows publication age when the date is known', () => {
    const { row } = renderRow()
    expect(row).toHaveTextContent('Опубліковано 3 дні тому')
    expect(row).not.toHaveTextContent('невідома')
  })

  it('falls back to first-seen with an unknown-date notice', () => {
    const { row } = renderRow({ publishedAt: null })
    expect(row).toHaveTextContent('Дата публікації невідома · вперше побачено позавчора')
    expect(row).not.toHaveTextContent('Опубліковано')
    // §4.3: the first-seen phrase never wraps apart, and the separator wraps with it
    expect(screen.getByText('· вперше побачено позавчора')).toHaveClass('whitespace-nowrap')
  })

  it('sets the title semibold (§4.3)', () => {
    renderRow()
    expect(screen.getByText('Senior React Engineer')).toHaveClass('font-semibold')
  })

  it('labels a triage item and omits the label for a lead', () => {
    renderRow({ eligibility: 'TRIAGE' })
    expect(screen.getByTestId('job-queue-row-triage')).toHaveTextContent('Потребує розгляду')
  })

  it('omits the triage label for a lead', () => {
    renderRow()
    expect(screen.queryByTestId('job-queue-row-triage')).toBeNull()
  })

  it('hides the matched count at 0', () => {
    renderRow({ matchedSeniorCount: 0 })
    expect(screen.queryByTestId('job-queue-row-matched')).toBeNull()
    // no empty counts line either
    expect(screen.queryByTestId('job-queue-row-counts')).toBeNull()
  })

  it('wraps a non-zero matched count in the counts line', () => {
    renderRow({ matchedSeniorCount: 1 })
    expect(screen.getByTestId('job-queue-row-counts')).toHaveTextContent(
      /^1 сеньйор вашої команди має збіг стеку$/,
    )
  })

  it.each([
    [1, '1 сеньйор вашої команди має збіг стеку'],
    [2, '2 сеньйори вашої команди мають збіг стеку'],
    [5, '5 сеньйорів вашої команди мають збіг стеку'],
    [11, '11 сеньйорів вашої команди мають збіг стеку'],
    [21, '21 сеньйор вашої команди має збіг стеку'],
    [22, '22 сеньйори вашої команди мають збіг стеку'],
    [25, '25 сеньйорів вашої команди мають збіг стеку'],
  ])('HR: %i matched reads «%s»', (n, text) => {
    renderRow({ matchedSeniorCount: n })
    expect(screen.getByTestId('job-queue-row-matched')).toHaveTextContent(text)
  })

  it.each([
    [1, '1 сеньйор має збіг стеку'],
    [2, '2 сеньйори мають збіг стеку'],
    [5, '5 сеньйорів мають збіг стеку'],
    [11, '11 сеньйорів мають збіг стеку'],
    [21, '21 сеньйор має збіг стеку'],
    [22, '22 сеньйори мають збіг стеку'],
    [25, '25 сеньйорів мають збіг стеку'],
  ])('ADMIN: %i matched reads the studio-wide «%s»', (n, text) => {
    renderRow({ matchedSeniorCount: n }, { role: 'ADMIN' })
    expect(screen.getByTestId('job-queue-row-matched')).toHaveTextContent(text)
    expect(screen.getByTestId('job-queue-row-matched')).not.toHaveTextContent('вашої команди')
  })

  it('shows the submitted companion only on the SUBMITTED tab', () => {
    renderRow({ matchedSeniorCount: 2, submittedSeniorCount: 1 }, { tab: 'SUBMITTED' })
    const submitted = screen.getByTestId('job-queue-row-submitted')
    expect(submitted).toHaveTextContent(/^1 подано$/)
    // the check mark is a decorative icon, not a glyph in the translated string
    const icon = within(submitted).getByTestId('job-queue-row-submitted-icon')
    expect(icon.tagName.toLowerCase()).toBe('svg')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows the submitted companion with no matched count (manual submission)', () => {
    renderRow({ matchedSeniorCount: 0, submittedSeniorCount: 1 }, { tab: 'SUBMITTED' })
    expect(screen.getByTestId('job-queue-row-submitted')).toHaveTextContent(/^1 подано$/)
    expect(screen.queryByTestId('job-queue-row-matched')).toBeNull()
  })

  it('omits the submitted companion at 0 on the SUBMITTED tab', () => {
    renderRow({ matchedSeniorCount: 2, submittedSeniorCount: 0 }, { tab: 'SUBMITTED' })
    expect(screen.queryByTestId('job-queue-row-submitted')).toBeNull()
  })

  it('explains a row whose every matching senior stop-listed the company (HR)', () => {
    renderRow({ matchedSeniorCount: 0, stopListedSeniorCount: 2 })
    expect(screen.getByTestId('job-queue-row-stop-listed')).toHaveTextContent(
      'Усі сеньйори вашої команди зі збігом внесли компанію до стоп-листа',
    )
  })

  it('uses the studio-wide stop-list wording for ADMIN', () => {
    renderRow({ matchedSeniorCount: 0, stopListedSeniorCount: 1 }, { role: 'ADMIN' })
    const line = screen.getByTestId('job-queue-row-stop-listed')
    expect(line).toHaveTextContent('Усі сеньйори зі збігом внесли компанію до стоп-листа')
    expect(line).not.toHaveTextContent('вашої команди')
  })

  it.each([
    ['some seniors still match', { matchedSeniorCount: 1, stopListedSeniorCount: 2 }],
    ['nobody stop-listed it', { matchedSeniorCount: 0, stopListedSeniorCount: 0 }],
  ])('has no stop-list line when %s', (_label, over) => {
    renderRow(over)
    expect(screen.queryByTestId('job-queue-row-stop-listed')).toBeNull()
  })

  it('gives a triage row its reason line', () => {
    renderRow({ eligibility: 'TRIAGE' })
    expect(screen.getByTestId('job-queue-row-triage-reason')).toHaveTextContent(
      'Роботодавця не вдалося підтвердити',
    )
  })

  it('has no reason line for a lead', () => {
    renderRow()
    expect(screen.queryByTestId('job-queue-row-triage-reason')).toBeNull()
  })

  it('does not show the submitted companion on the NEW tab', () => {
    renderRow({ matchedSeniorCount: 2, submittedSeniorCount: 1 })
    expect(screen.queryByTestId('job-queue-row-submitted')).toBeNull()
  })

  it('shows how many other sources carry the vacancy, hidden at 0', () => {
    renderRow({ alsoSeenOnCount: 2 })
    expect(screen.getByTestId('job-queue-row-also-seen')).toHaveTextContent('+2 на інших джерелах')
  })

  it('omits the also-seen line at 0', () => {
    renderRow()
    expect(screen.queryByTestId('job-queue-row-also-seen')).toBeNull()
  })

  it('marks a manual card instead of a source and survives a missing company', () => {
    const { row } = renderRow({ primarySource: null, companyName: null })
    expect(screen.getByTestId('job-queue-row-source')).toHaveAccessibleName('Додано вручну')
    expect(row).toHaveTextContent('Компанію не вказано')
  })

  describe('two-column layout structure (§4.3 ≥720px)', () => {
    it('has both layout wrappers job-queue-row-main and job-queue-row-meta', () => {
      renderRow()
      expect(screen.getByTestId('job-queue-row-main')).toBeInTheDocument()
      expect(screen.getByTestId('job-queue-row-meta')).toBeInTheDocument()
    })

    it('meta column carries the 230px width class', () => {
      renderRow()
      expect(screen.getByTestId('job-queue-row-meta')).toHaveClass('@min-[720px]:w-[14.375rem]')
    })

    it('meta column carries the shrink-0 class', () => {
      renderRow()
      expect(screen.getByTestId('job-queue-row-meta')).toHaveClass('@min-[720px]:shrink-0')
    })

    it('matched count sits inside meta, not in main', () => {
      renderRow({ matchedSeniorCount: 2 })
      expect(
        within(screen.getByTestId('job-queue-row-meta')).getByTestId('job-queue-row-counts'),
      ).toBeInTheDocument()
      expect(
        within(screen.getByTestId('job-queue-row-main')).queryByTestId('job-queue-row-counts'),
      ).not.toBeInTheDocument()
    })

    it('also-seen sits inside meta', () => {
      renderRow({ alsoSeenOnCount: 3 })
      expect(
        within(screen.getByTestId('job-queue-row-meta')).getByTestId('job-queue-row-also-seen'),
      ).toBeInTheDocument()
    })

    it('publication age carries the order-first class for wide layouts', () => {
      renderRow()
      expect(screen.getByTestId('job-queue-row-age')).toHaveClass('@min-[720px]:order-first')
    })

    it('DOM order inside meta: counts precedes age, age precedes also-seen', () => {
      renderRow({ matchedSeniorCount: 1, alsoSeenOnCount: 1 })
      const meta = screen.getByTestId('job-queue-row-meta')
      const counts = within(meta).getByTestId('job-queue-row-counts')
      const age = within(meta).getByTestId('job-queue-row-age')
      const alsoSeen = within(meta).getByTestId('job-queue-row-also-seen')
      // Node.DOCUMENT_POSITION_FOLLOWING = 4: the argument follows the caller in the DOM
      expect(counts.compareDocumentPosition(age) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(age.compareDocumentPosition(alsoSeen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })
})

// Hand-written literals (not derived from the code under test) so a mutated name is caught.
const EXPECTED_SOURCE_NAME: Record<JobSourceType, string> = {
  DOU_RSS: 'DOU',
  REMOTEOK_API: 'RemoteOK',
  REMOTIVE_API: 'Remotive',
  HIMALAYAS_API: 'Himalayas',
  JOBICY_API: 'Jobicy',
  ARBEITNOW_API: 'Arbeitnow',
  WORKINGNOMADS_API: 'Working Nomads',
  JOBGETHER_API: 'Jobgether',
  HN_HIRING: 'Hacker News: Who is hiring',
  GREENHOUSE_ATS: 'Greenhouse',
  LEVER_ATS: 'Lever',
  ASHBY_ATS: 'Ashby',
  WORKABLE_ATS: 'Workable',
  SMARTRECRUITERS_ATS: 'SmartRecruiters',
  RECRUITEE_ATS: 'Recruitee',
  PERSONIO_ATS: 'Personio',
  JOOBLE_API: 'Jooble',
  JSEARCH_API: 'JSearch',
  THEIRSTACK_API: 'TheirStack',
  MUSE_API: 'The Muse',
  REED_API: 'Reed',
  DJINNI_RSS: 'Djinni',
  WWR_RSS: 'We Work Remotely',
  EUREMOTEJOBS_RSS: 'EU Remote Jobs',
  JUSTJOIN_HTML: 'Just Join IT',
  NOFLUFF_HTML: 'No Fluff Jobs',
  LANDINGJOBS_HTML: 'Landing.jobs',
  NEXTLEVELJOBS_HTML: 'Next Level Jobs',
  DICE_HTML: 'Dice',
  THEHUB_HTML: 'The Hub',
  WTTJ_HTML: 'Welcome to the Jungle',
}

describe('sourceLabel', () => {
  it('covers exactly the source types of the schema', () => {
    expect(Object.keys(EXPECTED_SOURCE_NAME).sort()).toEqual(
      [...jobSourceTypeSchema.options].sort(),
    )
    expect(jobSourceTypeSchema.options).toHaveLength(31)
  })

  it.each(Object.entries(EXPECTED_SOURCE_NAME))('%s -> %s', (code, name) => {
    expect(sourceLabel(code)).toBe(name)
  })

  it.each(['toString', 'constructor', '__proto__', 'CUSTOM_API_FEED'])(
    'unknown code %s falls back to the raw string',
    (code) => {
      expect(sourceLabel(code)).toBe(code)
    },
  )
})
