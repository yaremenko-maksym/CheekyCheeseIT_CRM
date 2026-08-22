import { useEffect, useMemo, useState } from 'react'

export interface SortConfig<K extends string> {
  key: K
  dir: 'asc' | 'desc'
}

// Exported (task-finance-sort-date-and-jump round 2, M-1's neighbour, H-1):
// `sort.test.ts`'s pagination-regression tests slice against this exact
// constant instead of a hand-copied `50`, so the test and the real page size
// can't silently drift apart.
export const DEFAULT_PAGE_SIZE = 50

export function usePaginatedFilter<T, _K extends string>(
  items: T[],
  filter: (item: T) => boolean,
  sort: (a: T, b: T) => number,
) {
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => items.filter(filter), [items, filter])
  const sorted = useMemo(() => [...filtered].sort(sort), [filtered, sort])
  const totalPages = Math.max(1, Math.ceil(sorted.length / DEFAULT_PAGE_SIZE))

  // Clamp page when filters shrink total pages
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [totalPages, page])

  // Reset to page 1 when the filter OR the sort changes (task-finance-sort-
  // date-and-jump round 2, M-1): `items.length` (via `filteredLen`) is a
  // proxy for "the filter changed", but it says nothing about sort — without
  // this, toggling "Дата"/"Сумма" or flipping direction while parked on page
  // 3 leaves the user on page 3 of a NEW ordering, looking at rows that have
  // nothing to do with what was there before. `sort` is the right dependency
  // to key this off, not a raw `sortKey`/`sortDir` pair: the caller already
  // memoizes it with exactly those two as deps (`FinancePage`'s
  // `useCallback(..., [sortKey, sortDir])`), so its identity changes on
  // EITHER one changing and stays stable otherwise — one dependency instead
  // of duplicating the caller's memoization contract here.
  const filteredLen = filtered.length
  useEffect(() => {
    setPage(1)
  }, [filteredLen, sort])

  const paged = useMemo(
    () => sorted.slice((page - 1) * DEFAULT_PAGE_SIZE, page * DEFAULT_PAGE_SIZE),
    [sorted, page],
  )

  return {
    paged,
    page,
    setPage,
    totalPages,
    totalItems: filtered.length,
    pageSize: DEFAULT_PAGE_SIZE,
  }
}
