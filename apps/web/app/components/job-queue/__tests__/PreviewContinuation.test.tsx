/** r5 Task 7.3 fix round 1 — the card-preview continuation row (spec §5.1 item 5; SO-1). */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { PreviewContinuation, type Continuation } from '../PreviewContinuation'

function more(over: Partial<Continuation> = {}): Continuation {
  return {
    data: undefined,
    hasNextPage: false,
    isError: false,
    isFetching: false,
    accessLost: false,
    fetchNextPage: vi.fn(() => Promise.resolve()),
    ...over,
  }
}

type Props = Parameters<typeof PreviewContinuation>[0]

function props(over: Partial<Props> = {}): Props {
  return {
    testId: 'block',
    shown: 3,
    total: 34,
    pageSize: 20,
    more: more(),
    started: false,
    previewCursor: 'c-1',
    list: { current: null },
    onStart: vi.fn(),
    onAccessLost: vi.fn(),
    ...over,
  }
}

function renderRow(p: Props) {
  return render(<PreviewContinuation {...p} />, { wrapper: I18nTestProvider })
}

const fetched = { pages: [] }

describe('PreviewContinuation', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('before the first fetch: the totals and «Показати ще (n)» from the preview cursor', async () => {
    const p = props()
    renderRow(p)
    expect(screen.getByTestId('block-shown')).toHaveTextContent('Показано 3 із 34')
    const button = screen.getByRole('button', { name: 'Показати ще (20)' })
    expect(button).not.toHaveAttribute('aria-disabled')
    await userEvent.click(button)
    expect(p.onStart).toHaveBeenCalledTimes(1)
    expect(p.more.fetchNextPage).not.toHaveBeenCalled()
  })

  it('once started, a click asks for the next page and does not restart', async () => {
    const p = props({ started: true, more: more({ data: fetched, hasNextPage: true }) })
    renderRow(p)
    await userEvent.click(screen.getByRole('button', { name: 'Показати ще (20)' }))
    expect(p.more.fetchNextPage).toHaveBeenCalledTimes(1)
    expect(p.onStart).not.toHaveBeenCalled()
  })

  it('while a fetch runs the button stays mounted, marked busy, and ignores clicks', async () => {
    const p = props({
      started: true,
      more: more({ data: fetched, hasNextPage: true, isFetching: true }),
    })
    renderRow(p)
    const button = screen.getByRole('button', { name: 'Показати ще (20)' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(button)
    expect(p.more.fetchNextPage).not.toHaveBeenCalled()
    expect(p.onStart).not.toHaveBeenCalled()
  })

  it('SO-1c: a fetched continuation with no next page shows no button, whatever the total says', () => {
    const { container } = renderRow(
      props({ started: true, more: more({ data: fetched, hasNextPage: false }) }),
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('SO-1c: a preview without a cursor shows no button either', () => {
    const { container } = renderRow(props({ previewCursor: null }))
    expect(container).toBeEmptyDOMElement()
  })

  it('everything shown: nothing, even with a cursor left', () => {
    const { container } = renderRow(props({ shown: 34, total: 34 }))
    expect(container).toBeEmptyDOMElement()
  })

  it('the last step offers only what is left', () => {
    renderRow(props({ shown: 28, total: 34 }))
    expect(screen.getByRole('button', { name: 'Показати ще (6)' })).toBeVisible()
  })

  it('SO-1b: a failed fetch says so inline and retries the same page', async () => {
    const p = props({
      started: true,
      more: more({ data: fetched, hasNextPage: true, isError: true }),
    })
    renderRow(p)
    expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося завантажити ще')
    expect(screen.queryByTestId('block-shown')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(p.more.fetchNextPage).toHaveBeenCalledTimes(1)
    expect(p.onAccessLost).not.toHaveBeenCalled()
  })

  it('SO-1b: a failed first page (nothing fetched yet) retries from the preview cursor', async () => {
    const p = props({ started: true, more: more({ isError: true }) })
    renderRow(p)
    expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося завантажити ще')
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(p.more.fetchNextPage).toHaveBeenCalledTimes(1)
    expect(p.onStart).not.toHaveBeenCalled()
  })

  it('SO-1a: a lost access goes to the card path once, not to the inline error', () => {
    const onAccessLost = vi.fn()
    const p = props({
      started: true,
      onAccessLost,
      more: more({ data: fetched, hasNextPage: true }),
    })
    const view = renderRow(p)
    expect(onAccessLost).not.toHaveBeenCalled()
    view.rerender(
      <PreviewContinuation
        {...p}
        more={more({ hasNextPage: true, isError: true, accessLost: true })}
      />,
    )
    expect(onAccessLost).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Спробувати ще раз' })).toBeNull()
  })
})
