/**
 * task-pending-screen (position 7c). `/pending` — AC6 (states) + the parts
 * of AC4 that belong to the PAGE itself (grouping by kind, local-dismiss,
 * the two zones' independent visibility per design spec §3). Individual
 * action components (ProjectApprovalActions, SeniorShareApprovalActions,
 * CancelPendingShareButton) have their own test files — this one mounts
 * them for REAL (under a QueryClient) to prove the page wires kind → row →
 * action correctly, without re-testing each action's own mutation mechanics.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PendingItem } from '@crm/shared'
import { api } from '@/lib/axios'
import { PendingPage, focusSelectorsAfterActing } from '../index'

const mockPost = api.post as ReturnType<typeof vi.fn>

const mockNavigate = vi.fn()
// Captures every `createFileRoute(path)(options)` call this module makes at
// import time, while still delegating to the REAL implementation — the
// route registration itself (path string + `{ component }`) is otherwise
// never read by anything in this file (mutation gate: line 22 of ../index).
// `vi.hoisted` (not a plain `const`): `createFileRoute(...)(...)` runs
// SYNCHRONOUSLY as part of evaluating `../index`'s own module body — which
// happens while resolving THIS file's `import { PendingPage } from
// '../index'`, i.e. before any of this file's own top-level `const`
// statements would otherwise have run. A plain `const` here is a genuine
// TDZ crash (verified live), not just a style preference.
const { capturedRouteRegistrations } = vi.hoisted(() => ({
  capturedRouteRegistrations: [] as Array<{ path: string | undefined; options: unknown }>,
}))
vi.mock('@tanstack/react-router', async (orig) => {
  const real = await orig<typeof import('@tanstack/react-router')>()
  return {
    ...real,
    useNavigate: () => mockNavigate,
    Link: real.Link,
    createFileRoute: ((path: Parameters<typeof real.createFileRoute>[0]) => {
      const factory = real.createFileRoute(path)
      return (options: Parameters<typeof factory>[0]) => {
        capturedRouteRegistrations.push({ path, options })
        return factory(options)
      }
    }) as typeof real.createFileRoute,
  }
})

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

let mockState: {
  mine: PendingItem[]
  proposedByMe: PendingItem[]
  isLoading: boolean
  isError: boolean
  dataUpdatedAt: number
  refetch: () => void
} = {
  mine: [],
  proposedByMe: [],
  isLoading: false,
  isError: false,
  dataUpdatedAt: 0,
  refetch: vi.fn(),
}

vi.mock('@/hooks/use-pending-items', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-pending-items')>()
  return { ...real, usePendingItems: () => mockState }
})

function item(overrides: Partial<PendingItem>): PendingItem {
  return {
    kind: 'PROJECT_APPROVAL',
    subjectType: 'PROJECT',
    subjectId: 'subj-1',
    title: 'Acme Corp',
    proposedBy: 'Admin One',
    createdAt: new Date().toISOString(),
    actions: ['approve', 'reject', 'open'],
    link: '/projects/subj-1',
    ...overrides,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PendingPage />
    </QueryClientProvider>,
  )
}

const refetchSpy = vi.fn()

beforeEach(() => {
  mockState = {
    mine: [],
    proposedByMe: [],
    isLoading: false,
    isError: false,
    dataUpdatedAt: 0,
    refetch: refetchSpy,
  }
  refetchSpy.mockReset()
})

describe('/pending — route registration', () => {
  it('registers exactly at /_authenticated/pending/ with PendingPage as the component', () => {
    expect(capturedRouteRegistrations).toHaveLength(1)
    expect(capturedRouteRegistrations[0]).toEqual({
      path: '/_authenticated/pending/',
      options: { component: PendingPage },
    })
  })
})

describe('/pending — focusSelectorsAfterActing (pure function, direct)', () => {
  const p1 = item({ subjectId: 'p1' })
  const p2 = item({ subjectId: 'p2' })

  it('acted item has a next row in the same section: candidate list starts with that row', () => {
    expect(focusSelectorsAfterActing([p1, p2], p1, 'mine')).toEqual([
      '[data-testid="pending-item-row-PROJECT_APPROVAL-p2"]',
      '[data-testid="pending-kind-heading-mine-Проекты"]',
      '#pending-mine-heading',
      '[data-testid="pending-page"]',
    ])
  })

  it('acted item is the LAST one in the section: no next-row candidate at all', () => {
    expect(focusSelectorsAfterActing([p1], p1, 'mine')).toEqual([
      '[data-testid="pending-kind-heading-mine-Проекты"]',
      '#pending-mine-heading',
      '[data-testid="pending-page"]',
    ])
  })

  it('acted item is not even IN the given section (defensive): same as "no next", not section[0]', () => {
    // `section` here holds a DIFFERENT item than `acted` — `index` is -1.
    // A wrong "not found" check would fall through to `section[index + 1]`
    // and incorrectly surface p2 as the "next" row.
    expect(focusSelectorsAfterActing([p2], p1, 'mine')).toEqual([
      '[data-testid="pending-kind-heading-mine-Проекты"]',
      '#pending-mine-heading',
      '[data-testid="pending-page"]',
    ])
  })

  it('zone "proposedByMe" points at the OTHERS heading, not the mine one', () => {
    expect(focusSelectorsAfterActing([p1], p1, 'proposedByMe')).toEqual([
      '[data-testid="pending-kind-heading-proposedByMe-Проекты"]',
      '#pending-others-heading',
      '[data-testid="pending-page"]',
    ])
  })

  it('an unrecognized kind does not throw (sectionTitleOf falls back safely, not `.find(...).title`)', () => {
    const weird = { ...p1, kind: 'SOMETHING_NEW' } as unknown as PendingItem
    expect(() => focusSelectorsAfterActing([weird], weird, 'mine')).not.toThrow()
    expect(focusSelectorsAfterActing([weird], weird, 'mine')[0]).toBe(
      '[data-testid="pending-kind-heading-mine-Другое"]',
    )
  })
})

describe('/pending — AC6 states', () => {
  it('loading: shows the skeleton, not the page content', () => {
    mockState = { ...mockState, isLoading: true }
    renderPage()
    expect(screen.getByTestId('pending-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-empty')).not.toBeInTheDocument()
  })

  it('error: shows the message + Повторить, which calls refetch', () => {
    mockState = { ...mockState, isError: true }
    renderPage()
    expect(screen.getByTestId('pending-error')).toBeInTheDocument()
    // Accessible name is the `aria-label` ("Повторить загрузку" — same
    // DropBalanceCard.tsx precedent), not the shorter visible text.
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }))
    expect(refetchSpy).toHaveBeenCalledTimes(1)
  })

  it('both zones empty: shows the global empty state with the exact copy', () => {
    renderPage()
    expect(screen.getByTestId('pending-empty')).toBeInTheDocument()
    expect(screen.getByText('Ничего не ждёт вашего решения')).toBeInTheDocument()
  })

  it('mine empty but proposedByMe non-empty (ADMIN with nothing of their own): shows ONLY «Ждут решения других», not the global empty state', () => {
    mockState = {
      ...mockState,
      proposedByMe: [
        item({
          kind: 'SHARE_APPROVAL',
          waitingFor: ['Some Senior'],
          pendingPercent: 30,
          actions: ['cancel'],
        }),
      ],
    }
    renderPage()
    expect(screen.queryByTestId('pending-empty')).not.toBeInTheDocument()
    expect(screen.getByText('Ждут решения других')).toBeInTheDocument()
    expect(screen.queryByText('Ждут вашего решения')).not.toBeInTheDocument()
  })

  it('every §12 focus target renders tabIndex=-1: loading root, error root, main root, both zone headings', () => {
    mockState = { ...mockState, isLoading: true }
    const { unmount: unmountLoading } = renderPage()
    expect(screen.getByTestId('pending-page')).toHaveAttribute('tabindex', '-1')
    unmountLoading()

    mockState = { ...mockState, isLoading: false, isError: true }
    const { unmount: unmountError } = renderPage()
    expect(screen.getByTestId('pending-page')).toHaveAttribute('tabindex', '-1')
    unmountError()

    mockState = {
      ...mockState,
      isError: false,
      mine: [item({ subjectId: 'p1' })],
      proposedByMe: [item({ kind: 'SHARE_APPROVAL', pendingPercent: 30, actions: ['cancel'] })],
    }
    renderPage()
    expect(screen.getByTestId('pending-page')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('heading', { name: 'Ждут вашего решения' })).toHaveAttribute(
      'tabindex',
      '-1',
    )
    expect(screen.getByRole('heading', { name: 'Ждут решения других' })).toHaveAttribute(
      'tabindex',
      '-1',
    )
  })
})

describe('/pending — grouping by kind', () => {
  it('mine with all three kinds: sections render in Проекты → Доли → Контракты order', () => {
    mockState = {
      ...mockState,
      mine: [
        item({
          kind: 'CONTRACT_TO_SIGN',
          subjectId: 'c1',
          title: 'Контракт сотрудника',
          actions: ['open'],
        }),
        item({
          kind: 'SHARE_APPROVAL',
          subjectId: 's1',
          title: 'Доля по умолчанию',
          pendingPercent: 30,
        }),
        item({ kind: 'PROJECT_APPROVAL', subjectId: 'p1', title: 'Acme Corp' }),
      ],
    }
    renderPage()
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(['Проекты', 'Доли', 'Контракты'])
  })

  it('an item whose kind matches none of the three known kinds renders under a «Другое» fallback section, not silently dropped', () => {
    mockState = {
      ...mockState,
      mine: [{ ...item({}), kind: 'SOMETHING_NEW' } as unknown as PendingItem],
    }
    renderPage()
    expect(screen.getByText('Другое')).toBeInTheDocument()
  })
})

describe('/pending — AC4: end-to-end local dismiss through a REAL action component', () => {
  it('confirming a project from the page removes the row without waiting for a refetch', async () => {
    const user = userEvent.setup()
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: { status: 'ACTIVE' } })
    mockState = { ...mockState, mine: [item({ subjectId: 'p1', title: 'Acme Corp' })] }
    renderPage()

    expect(screen.getByText('Acme Corp')).toBeInTheDocument()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })

    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Design spec §12 / integration decision 3 (2026-09-11): the row the user was
// standing on disappears under them, so focus must land on the next logical
// element rather than falling back to <body> — the same obligation a modal
// has on close, except here the trigger left with the row.
// ---------------------------------------------------------------------------
describe('/pending — §12: focus after a row disappears', () => {
  beforeEach(() => {
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: { status: 'ACTIVE' } })
  })

  it('moves focus to the NEXT row of the same section', async () => {
    const user = userEvent.setup()
    mockState = {
      ...mockState,
      mine: [
        item({ subjectId: 'p1', title: 'Acme Corp' }),
        item({ subjectId: 'p2', title: 'Globex' }),
      ],
      proposedByMe: [],
    }
    renderPage()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })

    expect(screen.getByTestId('pending-item-row-PROJECT_APPROVAL-p2')).toHaveFocus()
  })

  it('moves focus to the section heading when the acted row was the last one of its section but others remain', async () => {
    const user = userEvent.setup()
    mockState = {
      ...mockState,
      mine: [
        item({ subjectId: 'p1', title: 'Acme Corp' }),
        item({ subjectId: 'p2', title: 'Globex' }),
      ],
      proposedByMe: [],
    }
    renderPage()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p2'))
    })

    expect(screen.getByTestId('pending-kind-heading-mine-Проекты')).toHaveFocus()
  })

  it('falls back to the zone heading when the whole section went away but the zone did not', async () => {
    const user = userEvent.setup()
    mockState = {
      ...mockState,
      mine: [
        item({ subjectId: 'p1', title: 'Acme Corp' }),
        item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'USER',
          subjectId: 'u1',
          title: 'Ваша базовая доля',
          currentPercent: 26,
          pendingPercent: 30,
          link: '/profile',
        }),
      ],
      proposedByMe: [],
    }
    renderPage()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })

    expect(screen.getByRole('heading', { name: 'Ждут вашего решения' })).toHaveFocus()
  })

  it('falls back to the page root when nothing at all is left to focus', async () => {
    const user = userEvent.setup()
    mockState = {
      ...mockState,
      mine: [item({ subjectId: 'p1', title: 'Acme Corp' })],
      proposedByMe: [],
    }
    renderPage()

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })

    expect(screen.getByTestId('pending-page')).toHaveFocus()
  })
})

describe('/pending — dismissal pruning on a fresh fetch', () => {
  it('does NOT prune a dismissal for an item that is STILL in `mine` — only a VANISHED id should be pruned', async () => {
    const user = userEvent.setup()
    mockState = {
      ...mockState,
      mine: [
        item({ subjectId: 'p1', title: 'Acme Corp' }),
        item({ subjectId: 'p2', title: 'Globex' }),
      ],
      dataUpdatedAt: 1,
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PendingPage />
      </QueryClientProvider>,
    )

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()

    // A fresh fetch lands — p1 is STILL in `mine` (waiting on the OTHER
    // invited approver, say). The dismissal must survive: p1 stays hidden.
    mockState = { ...mockState, dataUpdatedAt: 2 }
    rerender(
      <QueryClientProvider client={qc}>
        <PendingPage />
      </QueryClientProvider>,
    )
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()
    expect(screen.getByText('Globex')).toBeInTheDocument()
  })

  it('DOES prune a dismissal once the item has actually vanished from `mine` — a later re-proposal is visible again', async () => {
    const user = userEvent.setup()
    mockState = {
      ...mockState,
      mine: [item({ subjectId: 'p1', title: 'Acme Corp' })],
      dataUpdatedAt: 1,
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PendingPage />
      </QueryClientProvider>,
    )

    await act(async () => {
      await user.click(screen.getByTestId('project-approval-approve-p1'))
    })
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()

    // p1 vanishes from a fresh fetch (server resolved it) — dismissal is
    // pruned. It then comes back under a NEW id-colliding proposal.
    mockState = { ...mockState, mine: [], dataUpdatedAt: 2 }
    rerender(
      <QueryClientProvider client={qc}>
        <PendingPage />
      </QueryClientProvider>,
    )
    mockState = {
      ...mockState,
      mine: [item({ subjectId: 'p1', title: 'Acme Corp' })],
      dataUpdatedAt: 3,
    }
    rerender(
      <QueryClientProvider client={qc}>
        <PendingPage />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })
})

describe('/pending — proposedByMe (ADMIN) dismiss + focus', () => {
  it('cancelling a share from «Ждут решения других» removes ONLY that row and moves focus to the NEXT row in the SAME section', async () => {
    const user = userEvent.setup()
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: {} })
    mockState = {
      ...mockState,
      proposedByMe: [
        // Two SHARE_APPROVAL rows on purpose — this is what actually
        // exercises `handleActed`'s `zone === 'mine' ? visibleMine :
        // visibleOther` choice: with a wrong (mine, empty) list, `section`
        // comes back empty and focus falls to the heading instead of s2's
        // row. Different `subjectType` (→ different `scope`) keeps their
        // `CancelPendingShareButton` trigger testids
        // (`cancel-pending-share-user`/`-project`) from colliding.
        item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'USER',
          subjectId: 's1',
          title: 'Доля 1',
          pendingPercent: 30,
          actions: ['cancel'],
        }),
        item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'PROJECT',
          subjectId: 's2',
          title: 'Доля 2',
          pendingPercent: 20,
          actions: ['cancel'],
        }),
      ],
    }
    renderPage()

    // Same shape as cancel-pending-share.test.tsx's own `withdraw()` helper:
    // the confirm button needs `findByTestId` (retries), not `getByTestId`
    // — the AlertDialog's portal content is not synchronously present the
    // instant the trigger click's state update commits.
    await user.click(screen.getByTestId('cancel-pending-share-user'))
    await act(async () => {
      await user.click(await screen.findByTestId('cancel-pending-share-confirm-button-user'))
    })

    // Removed from `visibleOther` specifically (not left over from `visibleMine`,
    // which a `.filter(proposedByMe)` → `mine`-shaped mutant would produce).
    expect(screen.queryByText('Доля 1')).not.toBeInTheDocument()
    expect(screen.getByText('Доля 2')).toBeInTheDocument()
    expect(screen.getByTestId('pending-item-row-SHARE_APPROVAL-s2')).toHaveFocus()
  })

  it('cancelling the LAST row of a still-non-empty proposedByMe section moves focus to that section’s OWN (correctly zoned) heading', async () => {
    // The complementary case to the one above: acting on the SECOND of two
    // same-section rows has no "next" row, so `focusSelectorsAfterActing`
    // falls through to the zone-interpolated heading selector
    // (`pending-kind-heading-${zone}-...`) — the one candidate that is
    // actually sensitive to the STRING VALUE of the `zone` argument
    // `handleActed` is called with, not just whether it equals 'mine'.
    const user = userEvent.setup()
    mockPost.mockReset()
    mockPost.mockResolvedValue({ data: {} })
    mockState = {
      ...mockState,
      proposedByMe: [
        item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'USER',
          subjectId: 's1',
          title: 'Доля 1',
          pendingPercent: 30,
          actions: ['cancel'],
        }),
        item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'PROJECT',
          subjectId: 's2',
          title: 'Доля 2',
          pendingPercent: 20,
          actions: ['cancel'],
        }),
      ],
    }
    renderPage()

    await user.click(screen.getByTestId('cancel-pending-share-project'))
    await act(async () => {
      await user.click(await screen.findByTestId('cancel-pending-share-confirm-button-project'))
    })

    expect(screen.queryByText('Доля 2')).not.toBeInTheDocument()
    expect(screen.getByText('Доля 1')).toBeInTheDocument()
    expect(screen.getByTestId('pending-kind-heading-proposedByMe-Доли')).toHaveFocus()
  })
})

describe('/pending — visibleOther gate', () => {
  it('mine non-empty, proposedByMe empty: shows «Ждут вашего решения» only, not «Ждут решения других»', () => {
    mockState = {
      ...mockState,
      mine: [item({ subjectId: 'p1', title: 'Acme Corp' })],
      proposedByMe: [],
    }
    renderPage()
    expect(screen.getByText('Ждут вашего решения')).toBeInTheDocument()
    expect(screen.queryByText('Ждут решения других')).not.toBeInTheDocument()
  })
})

describe('/pending — proposedByMe grouping across kinds', () => {
  it('groups by Проекты → Доли, skips Контракты entirely, and buckets an unknown kind under Другое', () => {
    mockState = {
      ...mockState,
      proposedByMe: [
        item({ subjectId: 'proj-1', title: 'Acme Corp', actions: ['open'] }),
        item({
          kind: 'SHARE_APPROVAL',
          subjectId: 'share-1',
          title: 'Доля по умолчанию',
          pendingPercent: 30,
          actions: ['cancel'],
        }),
        {
          ...item({ subjectId: 'weird-1', title: 'Mystery item' }),
          kind: 'SOMETHING_NEW',
        } as unknown as PendingItem,
        // Defensive: §2 says this can never actually happen (a contract is
        // not an `approvals` row), but the filter that excludes it is real
        // product code and deserves its own proof, not a proof-by-absence
        // that would hold even with the filter deleted (an empty `items`
        // array already renders nothing, filter or not — see
        // PendingKindSection's own "renders nothing when empty").
        item({
          kind: 'CONTRACT_TO_SIGN',
          subjectId: 'contract-1',
          title: 'Контракт сотрудника — should never render here',
          actions: ['open'],
        }),
      ],
    }
    renderPage()

    // Zone-scoped testids (`pending-kind-heading-proposedByMe-*`) rather
    // than a bare role/text query — this section alone has three headings
    // and their exact zone-qualified identity is the point being tested.
    expect(screen.getByTestId('pending-kind-heading-proposedByMe-Проекты')).toBeInTheDocument()
    expect(screen.getByTestId('pending-kind-heading-proposedByMe-Доли')).toBeInTheDocument()
    expect(screen.getByTestId('pending-kind-heading-proposedByMe-Другое')).toBeInTheDocument()
    expect(
      screen.queryByTestId('pending-kind-heading-proposedByMe-Контракты'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Контракт сотрудника — should never render here'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Доля по умолчанию')).toBeInTheDocument()
    expect(screen.getByText('Mystery item')).toBeInTheDocument()
  })

  it('a known-kind item never leaks into the proposedByMe Другое bucket', () => {
    mockState = {
      ...mockState,
      proposedByMe: [item({ subjectId: 'proj-1', title: 'Acme Corp', actions: ['open'] })],
    }
    renderPage()
    expect(screen.getByTestId('pending-kind-heading-proposedByMe-Проекты')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-kind-heading-proposedByMe-Другое')).not.toBeInTheDocument()
  })

  it('visibleOther feeds the proposedByMe sections — a mine-zone item of the SAME kind never leaks across zones', () => {
    mockState = {
      ...mockState,
      mine: [item({ subjectId: 'mine-1', title: 'Mine Corp' })],
      proposedByMe: [item({ subjectId: 'other-1', title: 'Other Corp', actions: ['open'] })],
    }
    renderPage()

    // `<section aria-labelledby>` maps to the ARIA "region" role, named by
    // the referenced heading — a role query stays within Testing Library's
    // API (no raw `.closest()` node access).
    const mineSection = screen.getByRole('region', { name: 'Ждут вашего решения' })
    const othersSection = screen.getByRole('region', { name: 'Ждут решения других' })
    expect(within(mineSection).getByText('Mine Corp')).toBeInTheDocument()
    expect(within(mineSection).queryByText('Other Corp')).not.toBeInTheDocument()
    expect(within(othersSection).getByText('Other Corp')).toBeInTheDocument()
    expect(within(othersSection).queryByText('Mine Corp')).not.toBeInTheDocument()
  })
})
