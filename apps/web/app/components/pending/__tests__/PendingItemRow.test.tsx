/**
 * task-pending-screen design spec §6. `PendingItemRow` is the switch on
 * `item.kind` — tested in isolation from the real action components (each
 * has its own test file: ProjectApprovalActions.test.tsx,
 * SeniorShareApprovalActions.test.tsx, cancel-pending-share.test.tsx), so
 * these tests mock them as thin stand-ins and assert WHICH one gets
 * rendered with WHICH props, plus the title/meta text this file itself
 * owns (§6.1-6.5).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingItem } from '@crm/shared'
import { PendingItemRow } from '../PendingItemRow'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@/components/projects/ProjectApprovalActions', () => ({
  ProjectApprovalActions: (props: { projectId: string; companyName: string }) => (
    <div data-testid="stub-project-approval-actions">
      {props.projectId}:{props.companyName}
    </div>
  ),
}))

vi.mock('@/components/pending/SeniorShareApprovalActions', () => ({
  SeniorShareApprovalActions: (props: { scope: string; id: string }) => (
    <div data-testid="stub-senior-share-approval-actions">
      {props.scope}:{props.id}
    </div>
  ),
}))

vi.mock('@/components/pending-share/cancel-pending-share', () => ({
  CancelPendingShareButton: (props: { scope: string; id: string; pendingPercent: number }) => (
    <div data-testid="stub-cancel-pending-share">
      {props.scope}:{props.id}:{props.pendingPercent}
    </div>
  ),
}))

// SR-L-3 (PR #667 fix-round 2): `pendingItemSchema` is now a
// `z.discriminatedUnion('kind', ...)` — `Partial<PendingItem>` (a union)
// distributes over the three variants and rejects an override object that
// mixes fields from more than one (e.g. `{ kind: 'SHARE_APPROVAL',
// pendingPercent: 30 }` alone). This fixture helper deliberately stays
// permissive (every field from every variant, all optional) and the
// returned object is cast at the end — it is a test double for "some
// PendingItem shape", not a compile-time proof that every combination of
// overrides is a valid PendingItem (the real schema tests, pending.spec.ts,
// own that job).
interface ItemOverrides {
  kind?: PendingItem['kind']
  subjectType?: PendingItem['subjectType']
  subjectId?: string
  title?: string
  proposedBy?: string
  waitingFor?: string[]
  createdAt?: string
  actions?: PendingItem['actions']
  link?: string
  approvalId?: string
  viewerSharePercent?: number | null
  seniorName?: string | null
  currentPercent?: number
  pendingPercent?: number
}

function item(overrides: ItemOverrides): PendingItem {
  return {
    kind: 'PROJECT_APPROVAL',
    subjectType: 'PROJECT',
    subjectId: 'subj-1',
    title: 'Acme Corp',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // ~2 days ago
    actions: ['approve', 'reject', 'open'],
    link: '/projects/subj-1',
    approvalId: '00000000-0000-4000-8000-0000000000a1',
    viewerSharePercent: null,
    seniorName: null,
    ...overrides,
  } as unknown as PendingItem
}

/**
 * COPY-M-5 (fix-round 3): the meta is no longer one flat `<p>` — a
 * `proposedByMe` share row renders TWO lines, and the segments that must not
 * break mid-phrase («26% → предложено 30%», «1 день назад») sit in their own
 * `whitespace-nowrap` spans. RTL's `getByText` reads only an element's DIRECT
 * text children, so a per-line regex would silently stop matching once the
 * text moved into spans — this reads the whole meta block instead.
 */
function metaText(subjectId = 'subj-1'): string {
  return screen.getByTestId(`pending-item-meta-${subjectId}`).textContent ?? ''
}

function metaLines(subjectId = 'subj-1'): string[] {
  return Array.from(screen.getByTestId(`pending-item-meta-${subjectId}`).querySelectorAll('p')).map(
    (p) => (p.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

describe('PendingItemRow — PROJECT_APPROVAL', () => {
  it('mine: title + "Предлагает X · давность", renders ProjectApprovalActions', () => {
    render(
      <PendingItemRow
        item={item({ proposedBy: 'Олексій Коваленко' })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    // COPY-H-1: present tense — `proposedBy` is a displayName with no
    // gender attached, and «Предложил Ірина Савенко» is wrong for half the
    // names the field can hold. Same form #648 settled on («Подтверждает X»).
    expect(metaText()).toMatch(/^Предлагает Олексій Коваленко ·/)
    expect(screen.getByTestId('stub-project-approval-actions')).toHaveTextContent(
      'subj-1:Acme Corp',
    )
  })

  it('mine, no proposedBy (fail-safe): renders only давность, no "Предлагает"', () => {
    // `exactOptionalPropertyTypes` rejects `{ proposedBy: undefined }` (an
    // explicit undefined value differs from the key being absent) —
    // destructuring it off is what actually omits the key.
    const { proposedBy: _unused, ...withoutProposedBy } = item({})
    render(<PendingItemRow item={withoutProposedBy} zone="mine" onActed={vi.fn()} />)
    expect(metaText()).not.toMatch(/Предлагает/)
    expect(metaText()).toMatch(/назад$/)
  })

  it('proposedByMe: "Ждём: X · давность", renders only Открыть (no revoke endpoint for a project draft)', () => {
    render(
      <PendingItemRow
        item={item({ waitingFor: ['Ірина Савенко'], actions: ['open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).toMatch(/^Ждём: Ірина Савенко ·/)
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId(`pending-item-open-subj-1`)).toBeInTheDocument()
  })

  it('actions missing approve/reject falls back to Открыть-only, even in `mine`', () => {
    render(<PendingItemRow item={item({ actions: ['open'] })} zone="mine" onActed={vi.fn()} />)
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })

  it('proposedByMe with no waitingFor at all (defensive — should not happen): давность only, no "Ждём:"', () => {
    render(
      <PendingItemRow item={item({ actions: ['open'] })} zone="proposedByMe" onActed={vi.fn()} />,
    )
    expect(metaText()).not.toMatch(/Ждём:/)
  })

  it('multiple names in waitingFor are joined with ", " — not concatenated bare', () => {
    render(
      <PendingItemRow
        item={item({ waitingFor: ['Ірина Савенко', 'Олексій Коваленко'], actions: ['open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).toMatch(/^Ждём: Ірина Савенко, Олексій Коваленко ·/)
  })

  it('has approve but not reject: still falls back to Открыть-only (both are required, not either)', () => {
    render(
      <PendingItemRow
        item={item({ actions: ['approve', 'open'] })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })

  it('has BOTH approve and reject but is in the WRONG zone (proposedByMe): still falls back to Открыть-only', () => {
    // Complements the "approve but not reject" case above — together they
    // pin BOTH `&&` links of `zone==='mine' && has('approve') && has('reject')`
    // against being widened to `||` at either position.
    render(
      <PendingItemRow
        item={item({ actions: ['approve', 'reject', 'open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })
})

describe('PendingItemRow — SHARE_APPROVAL', () => {
  it('mine, with currentPercent: "Сейчас X% → предлагают Y% · давность", renders SeniorShareApprovalActions', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          title: 'Доля по умолчанию',
          currentPercent: 26,
          pendingPercent: 30,
          subjectType: 'USER',
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    // COPY-M-3: «предлагают» stays in `mine` — there somebody really is
    // proposing something TO the reader (the wording `PendingBaseShareBanner`
    // already uses).
    expect(metaText()).toMatch(/^Сейчас 26% → предлагают 30% ·/)
    expect(screen.getByTestId('stub-senior-share-approval-actions')).toHaveTextContent(
      'user:subj-1',
    )
  })

  it('mine, currentPercent absent (defensive): "Предлагают Y% · давность", no "Сейчас … →"', () => {
    const shareItem = item({
      kind: 'SHARE_APPROVAL',
      pendingPercent: 30,
    }) as Extract<PendingItem, { kind: 'SHARE_APPROVAL' }>
    const { currentPercent: _unused, ...withoutCurrentPercent } = shareItem
    render(
      <PendingItemRow
        item={withoutCurrentPercent as unknown as PendingItem}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).toMatch(/^Предлагают 30% ·/)
    expect(metaText()).not.toMatch(/Сейчас/)
  })

  it('subjectType PROJECT maps to scope="project"', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          pendingPercent: 30,
          subjectType: 'PROJECT',
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('stub-senior-share-approval-actions')).toHaveTextContent(
      'project:subj-1',
    )
  })

  it('proposedByMe: two lines — "Сейчас X% → предложено Y%" then "Ждём: NAME · давность" — renders CancelPendingShareButton with the resolved percent', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          currentPercent: 26,
          pendingPercent: 30,
          waitingFor: ['Олексій Коваленко'],
          actions: ['cancel'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    // COPY-M-3: the ADMIN reading this zone proposed it himself — «предлагают»
    // spoke about his own action in an impersonal third person.
    // COPY-M-5: and it is two lines now, which is what keeps the longest
    // string on the screen from breaking mid-phrase at 320px.
    expect(metaLines()).toEqual([
      'Сейчас 26% → предложено 30%',
      expect.stringMatching(/^Ждём: Олексій Коваленко · .+назад$/),
    ])
    expect(screen.getByTestId('stub-cancel-pending-share')).toHaveTextContent('project:subj-1:30')
  })

  it('proposedByMe with no waitingFor at all (defensive): "Сейчас X% → предлагают Y% · давность", no "ждём:" segment', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          currentPercent: 26,
          pendingPercent: 30,
          actions: ['cancel'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).not.toMatch(/ждём:|Ждём:/)
    expect(metaLines()).toEqual(['Сейчас 26% → предложено 30%', expect.stringMatching(/^.+назад$/)])
  })

  it('multiple names in waitingFor are joined with ", "', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          pendingPercent: 30,
          waitingFor: ['Олексій Коваленко', 'Ірина Савенко'],
          actions: ['cancel'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).toMatch(/Ждём: Олексій Коваленко, Ірина Савенко ·/)
  })

  it('zone "mine" never enters the proposedByMe branch, even when waitingFor happens to be set', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          pendingPercent: 30,
          waitingFor: ['Should be ignored in mine'],
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).not.toMatch(/ждём:|Ждём:/)
    expect(metaText()).toMatch(/^Предлагают 30% ·/)
  })

  it('has approve but not reject: still falls back to Открыть-only', () => {
    render(
      <PendingItemRow
        item={item({ kind: 'SHARE_APPROVAL', pendingPercent: 30, actions: ['approve', 'open'] })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('stub-senior-share-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })

  it('has BOTH approve and reject but is in the WRONG zone (proposedByMe): still falls back to Открыть-only', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          pendingPercent: 30,
          actions: ['approve', 'reject', 'open'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('stub-senior-share-approval-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })

  it('has cancel but is in the WRONG zone (mine): falls back to Открыть-only, does not render CancelPendingShareButton', () => {
    render(
      <PendingItemRow
        item={item({ kind: 'SHARE_APPROVAL', pendingPercent: 30, actions: ['cancel', 'open'] })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('stub-cancel-pending-share')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
  })
})

describe('PendingItemRow — CONTRACT_TO_SIGN', () => {
  it('title + "Готов к подписанию" badge as SEPARATE flex items, meta is давность only, single primary Открыть, no approve/reject', () => {
    render(
      <PendingItemRow
        item={item({ kind: 'CONTRACT_TO_SIGN', title: 'Ваш контракт', actions: ['open'] })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Ваш контракт')).toBeInTheDocument()
    // COPY-M-2: same capitalisation as the same status in `ContractTab`
    // («Готов к подписанию») — one status, one spelling.
    expect(screen.getByText('Готов к подписанию')).toBeInTheDocument()
    expect(metaText()).not.toMatch(/Предлагает/)
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-project-approval-actions')).not.toBeInTheDocument()
  })

  it('meta is давность ONLY — never enters the SHARE_APPROVAL "Предлагают X%" branch', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'CONTRACT_TO_SIGN',
          title: 'Ваш контракт',
          actions: ['open'],
          createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).toBe('5 минут назад')
    expect(metaText()).not.toMatch(/Предлагают/)
  })

  it('neither PROJECT_APPROVAL nor SHARE_APPROVAL ever shows the CONTRACT_TO_SIGN "Готов к подписанию" badge', () => {
    const { unmount } = render(<PendingItemRow item={item({})} zone="mine" onActed={vi.fn()} />)
    expect(screen.queryByText('Готов к подписанию')).not.toBeInTheDocument()
    unmount()

    render(
      <PendingItemRow
        item={item({ kind: 'SHARE_APPROVAL', pendingPercent: 30 })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByText('Готов к подписанию')).not.toBeInTheDocument()
  })
})

describe('PendingItemRow — OpenLink (Открыть) navigation', () => {
  afterEach(() => {
    mockNavigate.mockReset()
  })

  it('clicking Открыть navigates to item.link via the typed router', () => {
    render(
      <PendingItemRow
        item={item({ waitingFor: ['Ірина Савенко'], actions: ['open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('pending-item-open-subj-1'))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/projects/subj-1' })
  })

  it('when navigate() throws (item.link is server data, not a route literal the router validated), falls back to a hard navigation', () => {
    const assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    mockNavigate.mockImplementation(() => {
      throw new Error('not a route this build knows about')
    })
    render(
      <PendingItemRow
        item={item({ waitingFor: ['Ірина Савенко'], actions: ['open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('pending-item-open-subj-1'))
    expect(assignSpy).toHaveBeenCalledWith('/projects/subj-1')
    assignSpy.mockRestore()
  })

  it('CONTRACT_TO_SIGN renders Открыть as the PRIMARY (filled) button; every other kind renders it secondary (ghost)', () => {
    const { unmount } = render(
      <PendingItemRow
        item={item({ kind: 'CONTRACT_TO_SIGN', actions: ['open'] })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('pending-item-open-subj-1')).toHaveClass('bg-primary')
    unmount()

    render(
      <PendingItemRow
        item={item({ waitingFor: ['X'], actions: ['open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByTestId('pending-item-open-subj-1')).not.toHaveClass('bg-primary')
  })
})

describe('PendingItemRow — fmtRelative fallback', () => {
  it('an unparsable createdAt renders the raw string instead of "Invalid Date" or crashing', () => {
    render(
      <PendingItemRow
        item={item({ createdAt: 'not-a-real-date' })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText(/not-a-real-date$/)).toBeInTheDocument()
  })

  it('a valid createdAt renders in RUSSIAN with the "ago" suffix — both the locale AND addSuffix option are load-bearing', () => {
    // date-fns fact, verified directly: formatDistanceToNow(5-min-ago date)
    // is "5 минут назад" with {addSuffix:true, locale:ru}, "5 минут" with
    // addSuffix dropped, and "5 minutes ago" (English) with locale dropped —
    // three genuinely different strings, so a fixed interval pins all of it
    // in one assertion.
    render(
      <PendingItemRow
        item={item({ createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText(/5 минут назад$/)).toBeInTheDocument()
  })
})

describe('PendingItemRow — AC6: unknown kind never crashes', () => {
  it('renders a generic row (title or fallback text, давность, Открыть if offered) instead of throwing', () => {
    const weirdItem = {
      ...item({ actions: ['open'] }),
      kind: 'SOMETHING_NEW',
    } as unknown as PendingItem
    expect(() =>
      render(<PendingItemRow item={weirdItem} zone="mine" onActed={vi.fn()} />),
    ).not.toThrow()
    expect(screen.getByTestId('pending-item-open-subj-1')).toBeInTheDocument()
    // An unrecognized kind never gets the CONTRACT_TO_SIGN branch's PRIMARY
    // (filled) button — only CONTRACT_TO_SIGN itself is `primary`.
    expect(screen.getByTestId('pending-item-open-subj-1')).not.toHaveClass('bg-primary')
  })

  it('unknown kind with no actions renders no action at all (does not guess)', () => {
    const weirdItem = {
      ...item({ actions: [] }),
      kind: 'SOMETHING_NEW',
    } as unknown as PendingItem
    render(<PendingItemRow item={weirdItem} zone="mine" onActed={vi.fn()} />)
    expect(screen.queryByTestId('pending-item-open-subj-1')).not.toBeInTheDocument()
  })
})

describe('PendingItemRow — row wrapper: shared base classes, zone-specific classes, tabIndex', () => {
  it('mine zone: base layout classes present AND the mine-specific border/bg classes (not just "no amber")', () => {
    render(<PendingItemRow item={item({})} zone="mine" onActed={vi.fn()} />)
    const row = screen.getByTestId('pending-item-row-PROJECT_APPROVAL-subj-1')
    expect(row).toHaveClass('flex', 'rounded-md', 'border')
    expect(row).toHaveClass('border-border/40', 'bg-muted/20')
  })

  it('the row itself is tabIndex=-1 (focusable programmatically, not in the Tab order — design spec §12)', () => {
    render(<PendingItemRow item={item({})} zone="mine" onActed={vi.fn()} />)
    expect(screen.getByTestId('pending-item-row-PROJECT_APPROVAL-subj-1')).toHaveAttribute(
      'tabindex',
      '-1',
    )
  })
})

describe('PendingItemRow — COPY-M-4: a USER-scope share in `proposedByMe` does not repeat the name', () => {
  it('drops the «Ждём: …» segment — the title already names the senior («Доля по умолчанию — Имя»)', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'USER',
          title: 'Доля по умолчанию — Олексій Коваленко',
          currentPercent: 26,
          pendingPercent: 30,
          waitingFor: ['Олексій Коваленко'],
          actions: ['cancel'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Доля по умолчанию — Олексій Коваленко')).toBeInTheDocument()
    expect(metaText()).not.toMatch(/Ждём/)
    expect(metaLines()).toEqual(['Сейчас 26% → предложено 30%', expect.stringMatching(/^.+назад$/)])
  })

  it('a PROJECT-scope share in the same zone DOES keep «Ждём: …» — nothing else names the approver there', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'PROJECT',
          title: 'Доля по проекту «TechFlow»',
          currentPercent: 26,
          pendingPercent: 30,
          waitingFor: ['Олексій Коваленко'],
          actions: ['cancel'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(metaText()).toMatch(/Ждём: Олексій Коваленко/)
  })

  it('a USER-scope share in `mine` is untouched — that zone never printed «Ждём» at all', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'USER',
          title: 'Доля по умолчанию',
          currentPercent: 26,
          pendingPercent: 30,
          actions: ['approve', 'reject'],
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(metaLines()).toEqual([expect.stringMatching(/^Сейчас 26% → предлагают 30% · .+назад$/)])
  })
})

describe('PendingItemRow — COPY-M-5: the segments that must not break mid-phrase', () => {
  it('wraps the relative-time segment in whitespace-nowrap («меньше минуты назад» broke across lines at 320px)', () => {
    render(<PendingItemRow item={item({ proposedBy: 'Maksym' })} zone="mine" onActed={vi.fn()} />)

    // The phrase is its own element precisely so that it can carry the class
    // — `getByText` lands on that element, not on the paragraph around it.
    expect(screen.getByText('2 дня назад')).toHaveClass('whitespace-nowrap')
  })

  it('wraps the «X% → Y%» pair too — the other break point on the longest row of the screen', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'PROJECT',
          currentPercent: 26,
          pendingPercent: 30,
          waitingFor: ['Олексій Коваленко'],
          actions: ['cancel'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )

    expect(screen.getByText('Сейчас 26% → предложено 30%')).toHaveClass('whitespace-nowrap')
  })

  it('the name in «Ждём: …» is NOT nowrapped — a long list of names still has to wrap somewhere', () => {
    render(
      <PendingItemRow
        item={item({
          waitingFor: ['Ірина Савенко', 'Олексій Коваленко'],
          actions: ['open'],
        })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )

    expect(screen.getByText('Ждём: Ірина Савенко, Олексій Коваленко')).not.toHaveClass(
      'whitespace-nowrap',
    )
  })
})

describe('PendingItemRow — COPY-L-4: an unknown kind never renders a mute row', () => {
  it('falls back to «Запрос на действие» when the server sent no title', () => {
    render(
      <PendingItemRow
        item={item({ kind: 'SOMETHING_NEW' as PendingItem['kind'], title: '', actions: ['open'] })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Запрос на действие')).toBeInTheDocument()
  })

  it('uses the real title when there is one — the fallback is a fallback, not a replacement', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SOMETHING_NEW' as PendingItem['kind'],
          title: 'Согласование отпуска',
          actions: ['open'],
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Согласование отпуска')).toBeInTheDocument()
    expect(screen.queryByText('Запрос на действие')).not.toBeInTheDocument()
  })
})

describe('PendingItemRow — UX-H-1: the share line on a PROJECT_APPROVAL row of `mine`', () => {
  it('DROP sees their share and who they would work under — the one number needed to answer «да» here', () => {
    render(
      <PendingItemRow
        item={item({
          proposedBy: 'Maksym Yaremenko',
          viewerSharePercent: 9,
          seniorName: 'Oleksiy Kovalenko',
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    // Verbatim the widget's own line (PendingProjectApprovalsPanel) — the
    // two surfaces are one click apart, so one wording, not two.
    expect(screen.getByText(/^Ваша доля: 9% · синьор: Oleksiy Kovalenko$/)).toBeInTheDocument()
  })

  it('SENIOR sees the percent without a «синьор:» tail — they are the senior', () => {
    render(
      <PendingItemRow
        item={item({ proposedBy: 'Maksym Yaremenko', viewerSharePercent: 12, seniorName: null })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Ваша доля: 12%')).toBeInTheDocument()
    expect(screen.queryByText(/синьор:/)).not.toBeInTheDocument()
  })

  it('ADMIN (viewerSharePercent null) gets no share line at all — they are party to neither side', () => {
    render(
      <PendingItemRow
        item={item({ proposedBy: 'Maksym Yaremenko', viewerSharePercent: null })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByText(/Ваша доля/)).not.toBeInTheDocument()
  })

  it('the observer zone never shows it — the widget never did either', () => {
    render(
      <PendingItemRow
        item={item({ viewerSharePercent: 12, seniorName: 'Oleksiy Kovalenko', actions: ['open'] })}
        zone="proposedByMe"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByText(/Ваша доля/)).not.toBeInTheDocument()
  })

  it('a SHARE_APPROVAL row never shows it — there the percent IS the decision, not context for one', () => {
    render(
      <PendingItemRow
        item={item({
          kind: 'SHARE_APPROVAL',
          subjectType: 'PROJECT',
          currentPercent: 26,
          pendingPercent: 30,
          viewerSharePercent: 12,
        })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.queryByText(/Ваша доля/)).not.toBeInTheDocument()
  })

  it('0% is a real answer and must be shown, not swallowed as falsy', () => {
    render(
      <PendingItemRow
        item={item({ proposedBy: 'Maksym Yaremenko', viewerSharePercent: 0 })}
        zone="mine"
        onActed={vi.fn()}
      />,
    )
    expect(screen.getByText('Ваша доля: 0%')).toBeInTheDocument()
  })
})
