/** r5 Task 7.3 — «Також опубліковано на:» (spec §5.1 item 5). */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { openOriginalPosting } from '@/components/job-sourcing/open-original'
import { useJobQueueSources } from '@/hooks/use-job-queue'
import { AlsoSeenOn } from '../AlsoSeenOn'
import { cardFixture, idleContinuation, OPP, PRIMARY, source } from './card-fixtures'

vi.mock('@/hooks/use-job-queue', async (orig) => ({
  ...(await orig<typeof import('@/hooks/use-job-queue')>()),
  useJobQueueSources: vi.fn(),
}))
vi.mock('@/components/job-sourcing/open-original', async (orig) => ({
  ...(await orig<typeof import('@/components/job-sourcing/open-original')>()),
  openOriginalPosting: vi.fn(() => true),
}))

const SCOPE = { actorId: 'actor', role: 'HR' as const, teamId: null }
const sourcesHook = vi.mocked(useJobQueueSources)

function renderBlock(card = cardFixture()) {
  return render(<AlsoSeenOn scope={SCOPE} card={card} onAccessLost={vi.fn()} />, {
    wrapper: I18nTestProvider,
  })
}

describe('AlsoSeenOn', () => {
  beforeEach(async () => {
    vi.mocked(openOriginalPosting).mockClear()
    sourcesHook.mockReset()
    sourcesHook.mockReturnValue(idleContinuation() as never)
    await loadCatalog('uk')
  })

  it('renders nothing when the vacancy has no source besides the primary one', () => {
    const { container } = renderBlock()
    expect(container).toBeEmptyDOMElement()
  })

  it('lists the other sources by name and never repeats the primary source', () => {
    renderBlock(
      cardFixture({
        sources: {
          items: [PRIMARY, source(1), source(2, { sourceType: 'WWR_RSS' })],
          totalCount: 3,
          nextCursor: null,
        },
      }),
    )
    const block = screen.getByTestId('job-queue-also-seen')
    expect(within(block).getByRole('heading', { name: 'Також опубліковано на:' })).toBeVisible()
    expect(within(block).getByRole('button', { name: /Djinni/ })).toBeVisible()
    expect(within(block).getByRole('button', { name: /We Work Remotely/ })).toBeVisible()
    expect(within(block).queryByText('DOU')).toBeNull()
    expect(screen.queryByTestId(`job-queue-source-${PRIMARY.sourceRecordId}`)).toBeNull()
    // every source is listed, so there is no «Показано … із …» line
    expect(screen.queryByTestId('job-queue-also-seen-shown')).toBeNull()
  })

  // UX-L-2 / QA-LOW-5: one row per source, its type and where it points, so two postings on the
  // same board are told apart
  it('lists each source as a row with its type and the url host and path', () => {
    const root = source(2, { url: 'https://remote.example/' })
    renderBlock(
      cardFixture({
        sources: { items: [PRIMARY, source(1), root], totalCount: 3, nextCursor: null },
      }),
    )
    const list = screen.getByRole('list')
    expect(list).toHaveClass(
      'flex',
      'flex-col',
      'divide-y',
      'overflow-hidden',
      'rounded-lg',
      'border',
    )
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    const row = screen.getByTestId(`job-queue-source-${source(1).sourceRecordId}`)
    expect(within(row).getByText('Djinni')).toHaveClass('shrink-0', 'font-medium')
    expect(within(row).getByText('djinni.co/jobs/1')).toHaveClass(
      'min-w-0',
      'flex-1',
      'truncate',
      'text-muted-foreground',
    )
    expect(row).toHaveClass(
      'flex',
      'min-h-11',
      'w-full',
      'items-center',
      'gap-2',
      'px-3',
      'text-left',
    )
    // a bare host has no path to show
    expect(
      within(screen.getByTestId(`job-queue-source-${root.sourceRecordId}`)).getByText(
        'remote.example',
      ),
    ).toBeVisible()
  })

  it('an unsafe url stays inert text in its row, still saying where it points', () => {
    const bad = source(1, { url: 'not a url' })
    renderBlock(
      cardFixture({ sources: { items: [PRIMARY, bad], totalCount: 2, nextCursor: null } }),
    )
    const row = screen.getByTestId(`job-queue-source-${bad.sourceRecordId}`)
    expect(row.tagName).toBe('SPAN')
    expect(row).toHaveClass('flex', 'min-h-11', 'items-center', 'gap-2', 'text-muted-foreground')
    expect(within(row).getByText('not a url')).toHaveClass('truncate')
    expect(within(row).getByText('Djinni')).toHaveClass('shrink-0')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens a source through openOriginalPosting with its exact url', async () => {
    const s = source(1)
    renderBlock(cardFixture({ sources: { items: [PRIMARY, s], totalCount: 2, nextCursor: null } }))
    await userEvent.click(screen.getByTestId(`job-queue-source-${s.sourceRecordId}`))
    expect(openOriginalPosting).toHaveBeenCalledTimes(1)
    expect(openOriginalPosting).toHaveBeenCalledWith(s.url)
  })

  it('a non-https source is plain text, never a control that opens it', () => {
    const s = source(1, { url: 'http://insecure.example/x' })
    renderBlock(cardFixture({ sources: { items: [PRIMARY, s], totalCount: 2, nextCursor: null } }))
    const row = screen.getByTestId(`job-queue-source-${s.sourceRecordId}`)
    expect(row.tagName).toBe('SPAN')
    expect(row).toHaveTextContent('Djinni')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the totals without the primary source and continues by the preview cursor', async () => {
    const items = [PRIMARY, source(1), source(2), source(3)]
    const fetchNextPage = vi.fn()
    renderBlock(cardFixture({ sources: { items, totalCount: 35, nextCursor: 'c-1' } }))
    expect(sourcesHook).toHaveBeenLastCalledWith(SCOPE, OPP, null)
    expect(screen.getByTestId('job-queue-also-seen-shown')).toHaveTextContent('Показано 3 із 34')
    const more = screen.getByRole('button', { name: 'Показати ще (20)' })

    sourcesHook.mockReturnValue(
      idleContinuation([{ items: [source(4), source(5)], totalCount: 35, nextCursor: 'c-2' }], {
        hasNextPage: true,
        fetchNextPage,
      }) as never,
    )
    await userEvent.click(more)
    expect(sourcesHook).toHaveBeenLastCalledWith(SCOPE, OPP, 'c-1')
    expect(fetchNextPage).not.toHaveBeenCalled()
    expect(screen.getByTestId(`job-queue-source-${source(5).sourceRecordId}`)).toBeVisible()
    expect(screen.getByTestId('job-queue-also-seen-shown')).toHaveTextContent('Показано 5 із 34')

    await userEvent.click(screen.getByRole('button', { name: 'Показати ще (20)' }))
    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  })

  it('UX-M-2 / QA-LOW-2: the last page by keyboard hands focus to the first new source, not the dialog', async () => {
    renderBlock(
      cardFixture({ sources: { items: [PRIMARY, source(1)], totalCount: 3, nextCursor: 'c-1' } }),
    )
    sourcesHook.mockReturnValue(
      idleContinuation([{ items: [source(2)], totalCount: 3, nextCursor: null }]) as never,
    )
    screen.getByRole('button', { name: 'Показати ще (1)' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('button', { name: /Показати ще/ })).toBeNull()
    const first = screen.getByTestId(`job-queue-source-row-${source(2).sourceRecordId}`)
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute('tabindex', '-1')
    expect(first).toHaveClass(
      'min-w-0',
      'focus-visible:outline-none',
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-inset',
    )
  })

  it('a focus moved away before the last page lands is not taken back', async () => {
    const card = cardFixture({
      sources: { items: [PRIMARY, source(1)], totalCount: 3, nextCursor: 'c-1' },
    })
    const { rerender } = renderBlock(card)
    screen.getByRole('button', { name: 'Показати ще (1)' }).focus()
    await userEvent.keyboard('{Enter}')
    // still loading, so the control stays; the user moves on to the first source
    const elsewhere = screen.getByTestId(`job-queue-source-${source(1).sourceRecordId}`)
    elsewhere.focus()
    sourcesHook.mockReturnValue(
      idleContinuation([{ items: [source(2)], totalCount: 3, nextCursor: null }]) as never,
    )
    rerender(<AlsoSeenOn scope={SCOPE} card={card} onAccessLost={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Показати ще/ })).toBeNull()
    expect(elsewhere).toHaveFocus()
  })

  it('the last continuation step offers only what is left', () => {
    const items = [PRIMARY, ...Array.from({ length: 19 }, (_, i) => source(i + 1))]
    renderBlock(cardFixture({ sources: { items, totalCount: 26, nextCursor: 'c-1' } }))
    expect(screen.getByTestId('job-queue-also-seen-shown')).toHaveTextContent('Показано 19 із 25')
    expect(screen.getByRole('button', { name: 'Показати ще (6)' })).toBeVisible()
  })

  it('a manual vacancy (no primary source) counts every source', () => {
    renderBlock(
      cardFixture({
        primarySource: null,
        sources: { items: [source(1)], totalCount: 2, nextCursor: 'c-1' },
      }),
    )
    expect(screen.getByTestId('job-queue-also-seen-shown')).toHaveTextContent('Показано 1 із 2')
  })
})
