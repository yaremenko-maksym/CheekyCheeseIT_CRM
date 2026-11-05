import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JobQueueListItemDto } from '@crm/shared'
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

  it('shows publication age when the date is known', () => {
    const { row } = renderRow()
    expect(row).toHaveTextContent('Опубліковано 3 дні тому')
    expect(row).not.toHaveTextContent('невідома')
  })

  it('falls back to first-seen with an unknown-date notice', () => {
    const { row } = renderRow({ publishedAt: null })
    expect(row).toHaveTextContent('Дата публікації невідома · вперше побачено позавчора')
    expect(row).not.toHaveTextContent('Опубліковано')
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
  })

  it('pluralizes the HR team-scoped matched count', () => {
    renderRow({ matchedSeniorCount: 3 })
    expect(screen.getByTestId('job-queue-row-matched')).toHaveTextContent(
      '3 сеньйори вашої команди мають збіг стеку',
    )
  })

  it('uses the HR singular form at 1', () => {
    renderRow({ matchedSeniorCount: 1 })
    expect(screen.getByTestId('job-queue-row-matched')).toHaveTextContent(
      '1 сеньйор вашої команди має збіг стеку',
    )
  })

  it('uses the studio-wide wording for ADMIN', () => {
    renderRow({ matchedSeniorCount: 5 }, { role: 'ADMIN' })
    expect(screen.getByTestId('job-queue-row-matched')).toHaveTextContent(
      '5 сеньйорів мають збіг стеку',
    )
  })

  it('shows the submitted companion only on the SUBMITTED tab', () => {
    renderRow({ matchedSeniorCount: 2, submittedSeniorCount: 1 }, { tab: 'SUBMITTED' })
    expect(screen.getByTestId('job-queue-row-submitted')).toHaveTextContent('1 подано')
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
})

describe('sourceLabel', () => {
  it('drops the transport suffix and keeps the brand', () => {
    expect(sourceLabel('DOU_RSS')).toBe('DOU')
    expect(sourceLabel('REMOTEOK_API')).toBe('REMOTEOK')
    expect(sourceLabel('WTTJ_HTML')).toBe('WTTJ')
    expect(sourceLabel('GREENHOUSE_ATS')).toBe('GREENHOUSE')
    expect(sourceLabel('HN_HIRING')).toBe('HN')
  })
})
