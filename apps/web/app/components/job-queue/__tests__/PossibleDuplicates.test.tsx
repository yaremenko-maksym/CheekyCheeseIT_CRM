/** r5 Task 7.3 — the possible-duplicate note (spec §5.8, visibility §3). */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { JobQueueCardResponseDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { PossibleDuplicates } from '../PossibleDuplicates'

type Preview = NonNullable<JobQueueCardResponseDto['possibleDuplicates']>

const dup = (n: number, companyName: string | null = `Company ${n}`) => ({
  opportunityId: `55555555-5555-4555-8555-${n.toString(16).padStart(12, '0')}`,
  title: `Similar role ${n}`,
  companyName,
})

function renderNote(preview: Preview | null) {
  return render(<PossibleDuplicates preview={preview} />, { wrapper: I18nTestProvider })
}

describe('PossibleDuplicates', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('renders nothing without a preview or with an empty one', () => {
    const { container, rerender } = renderNote(null)
    expect(container).toBeEmptyDOMElement()
    rerender(<PossibleDuplicates preview={{ items: [], totalCount: 0 }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the similar vacancies in a bounded preview', () => {
    renderNote({ items: [dup(1), dup(2, null)], totalCount: 2 })
    const note = screen.getByTestId('job-queue-duplicates')
    expect(within(note).getByText('У черзі є схожа вакансія')).toBeVisible()
    expect(note).toHaveTextContent('Можливий дублікат. Перевірте, чи це не та сама вакансія.')
    const items = within(note).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Similar role 1 · Company 1')
    expect(items[1]).toHaveTextContent(/^Similar role 2$/)
    expect(within(note).queryByTestId('job-queue-duplicates-shown')).toBeNull()
    // the «already submitted to a similar vacancy» line needs own-team data the API does not send
    expect(note).not.toHaveTextContent('вже подано')
  })

  it('says how many are hidden when the preview is cut', () => {
    renderNote({ items: [1, 2, 3, 4, 5].map((n) => dup(n)), totalCount: 7 })
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.getByTestId('job-queue-duplicates-shown')).toHaveTextContent('Показано 5 із 7')
  })
})
