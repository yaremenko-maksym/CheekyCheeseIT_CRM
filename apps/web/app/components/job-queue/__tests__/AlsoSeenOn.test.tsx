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
  return render(<AlsoSeenOn scope={SCOPE} card={card} />, { wrapper: I18nTestProvider })
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
