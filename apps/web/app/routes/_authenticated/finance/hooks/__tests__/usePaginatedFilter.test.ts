import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PAGE_SIZE, usePaginatedFilter } from '../usePaginatedFilter'

const items = Array.from({ length: DEFAULT_PAGE_SIZE + 5 }, (_, i) => i)
const noFilter = () => true
const byValueAsc = (a: number, b: number) => a - b
const byValueDesc = (a: number, b: number) => b - a

describe('usePaginatedFilter', () => {
  it('paginates at DEFAULT_PAGE_SIZE and exposes totalPages/totalItems', () => {
    const { result } = renderHook(() => usePaginatedFilter(items, noFilter, byValueAsc))
    expect(result.current.paged).toHaveLength(DEFAULT_PAGE_SIZE)
    expect(result.current.totalItems).toBe(items.length)
    expect(result.current.totalPages).toBe(2)
  })

  it('resets to page 1 when the sort comparator changes (task-finance-sort-date-and-jump round 2, M-1)', () => {
    // Reproduces the finance page's own wiring: `sort` is a NEW function
    // identity each time the caller's sortKey/sortDir change (it's built
    // with `useCallback(..., [sortKey, sortDir])` there) — this test passes
    // a literally different function reference between renders, exactly
    // like that memoization does, without pulling in FinancePage's full
    // TanStack Router/Query stack.
    const { result, rerender } = renderHook(
      ({ sort }: { sort: (a: number, b: number) => number }) =>
        usePaginatedFilter(items, noFilter, sort),
      { initialProps: { sort: byValueAsc } },
    )

    act(() => result.current.setPage(2))
    expect(result.current.page).toBe(2)

    // Same items, same filter — only the sort direction (a new comparator
    // identity) changes, as a real "Дата"/"Сумма" toggle would produce.
    rerender({ sort: byValueDesc })

    expect(result.current.page).toBe(1)
  })

  it('does NOT reset the page when re-rendered with the same sort/filter (no spurious resets)', () => {
    const { result, rerender } = renderHook(
      ({ sort }: { sort: (a: number, b: number) => number }) =>
        usePaginatedFilter(items, noFilter, sort),
      { initialProps: { sort: byValueAsc } },
    )

    act(() => result.current.setPage(2))
    expect(result.current.page).toBe(2)

    // Re-render with the SAME memoized comparator (identity unchanged) —
    // simulates an unrelated parent re-render, not a sort change.
    rerender({ sort: byValueAsc })

    expect(result.current.page).toBe(2)
  })
})
