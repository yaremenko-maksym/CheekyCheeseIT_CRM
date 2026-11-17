/** r5 Task 7.3 — the possible-duplicate note (spec §5.8, visibility §3). */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { JobQueueCardResponseDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { PossibleDuplicates } from '../PossibleDuplicates'

type Preview = NonNullable<JobQueueCardResponseDto['possibleDuplicates']>

const dup = (
  n: number,
  companyName: string | null = `Company ${n}`,
  submittedSeniorNames: string[] = [],
) => ({
  opportunityId: `55555555-5555-4555-8555-${n.toString(16).padStart(12, '0')}`,
  title: `Similar role ${n}`,
  companyName,
  submittedSeniorNames,
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
    expect(note).not.toHaveTextContent('Можливий дублікат') // spec §5.8 has the heading only (SPEC-L-2)
    const items = within(note).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Similar role 1 · Company 1')
    expect(items[1]).toHaveTextContent(/^Similar role 2$/)
    expect(within(note).queryByTestId('job-queue-duplicates-shown')).toBeNull()
    // no own-scope submission on either duplicate, so no «already submitted» line (spec §5.8)
    expect(note).not.toHaveTextContent('вже подано')
  })

  it('says how many are hidden when the preview is cut', () => {
    renderNote({ items: [1, 2, 3, 4, 5].map((n) => dup(n)), totalCount: 7 })
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.getByTestId('job-queue-duplicates-shown')).toHaveTextContent('Показано 5 із 7')
  })

  it('names who the own scope already submitted to a duplicate, and only on that duplicate', () => {
    renderNote({
      items: [dup(1, null, ['Олена Коваль', 'Іван Шевченко']), dup(2)],
      totalCount: 2,
    })
    const lines = screen.getAllByTestId('job-queue-duplicate-submitted')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent(/^Уже подано: Олена Коваль, Іван Шевченко$/)
    const [first, second] = screen.getAllByRole('listitem') as [HTMLElement, HTMLElement]
    expect(within(first).getByTestId('job-queue-duplicate-submitted')).toBe(lines[0])
    expect(within(second).queryByTestId('job-queue-duplicate-submitted')).toBeNull()
  })

  it('reads the submitted line in English', async () => {
    await loadCatalog('en')
    renderNote({ items: [dup(1, null, ['Olena'])], totalCount: 1 })
    expect(screen.getByTestId('job-queue-duplicate-submitted')).toHaveTextContent(
      /^Already submitted: Olena$/,
    )
  })
})
