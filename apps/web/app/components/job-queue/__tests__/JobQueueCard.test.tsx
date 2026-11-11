/** r5 Task 7.3 — the vacancy card dialog (spec §5.1, §5.7, §11). */
import { useRef, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import type { JobQueueCardResponseDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { useJobQueueCard, useJobQueueSeniors, useJobQueueSources } from '@/hooks/use-job-queue'
import { JobQueueCard } from '../JobQueueCard'
import { cardFixture, idleContinuation, OPP, PRIMARY, senior, source } from './card-fixtures'

// the card mounts its own write actions, which need a query client
function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={client}>
      <I18nTestProvider>{children}</I18nTestProvider>
    </QueryClientProvider>
  )
}

vi.mock('@/hooks/use-job-queue', async (orig) => ({
  ...(await orig<typeof import('@/hooks/use-job-queue')>()),
  useJobQueueCard: vi.fn(),
  useJobQueueSeniors: vi.fn(),
  useJobQueueSources: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const SCOPE = { actorId: 'actor', role: 'HR' as const, teamId: null }
const cardHook = vi.mocked(useJobQueueCard)

function cardResult(over: Record<string, unknown> = {}) {
  return {
    data: cardFixture(),
    accessLost: false,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    ...over,
  } as never
}

function withCard(card: JobQueueCardResponseDto) {
  cardHook.mockReturnValue(cardResult({ data: card }))
}

/** One card, rendered: a fresh mount per call, so a test can unmount and show another. */
function show(card: JobQueueCardResponseDto) {
  withCard(card)
  return render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={vi.fn()} />, {
    wrapper: Wrapper,
  })
}

function renderCard(onClose = vi.fn()) {
  render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={onClose} />, {
    wrapper: Wrapper,
  })
  return onClose
}

describe('JobQueueCard', () => {
  beforeEach(async () => {
    vi.mocked(toast.error).mockClear()
    cardHook.mockReset()
    cardHook.mockReturnValue(cardResult())
    vi.mocked(useJobQueueSeniors).mockReturnValue(idleContinuation() as never)
    vi.mocked(useJobQueueSources).mockReturnValue(idleContinuation() as never)
    await loadCatalog('uk')
  })

  it('is a modal dialog named by its h2 title, for the requested vacancy', () => {
    renderCard()
    expect(cardHook).toHaveBeenCalledWith(SCOPE, OPP)
    const dialog = screen.getByRole('dialog', { name: 'Senior React Engineer' })
    expect(
      within(dialog).getByRole('heading', { level: 2, name: 'Senior React Engineer' }),
    ).toBeVisible()
    expect(dialog).toHaveAttribute(
      'aria-labelledby',
      within(dialog).getByRole('heading', { level: 2 }).id,
    )
  })

  it('the title wraps fully and the dialog goes full-screen below 640 px', () => {
    renderCard()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveClass(
      '[overflow-wrap:anywhere]',
    )
    expect(within(dialog).getByRole('heading', { level: 2 })).not.toHaveClass('line-clamp-2')
    expect(dialog).toHaveClass('inset-0', 'h-dvh', 'sm:h-auto', 'sm:max-w-2xl')
    // UX-L-3 / SPEC-L-3: the shadcn dialog's enter/exit set; the fade always (opacity only under
    // reduced motion), the zoom only when motion is safe
    expect(dialog).toHaveClass(
      'duration-150',
      'data-[state=open]:animate-in',
      'data-[state=closed]:animate-out',
      'data-[state=open]:fade-in-0',
      'data-[state=closed]:fade-out-0',
      'sm:motion-safe:data-[state=open]:zoom-in-95',
      'sm:motion-safe:data-[state=closed]:zoom-out-95',
    )
    expect(dialog.className).not.toMatch(/motion-safe:data-\[state=(open|closed)\]:(animate|fade)-/)
    expect(dialog.className).not.toMatch(/(^| )(sm:)?data-\[state=(open|closed)\]:zoom-/)
  })

  it('the close button is 44×44, labelled «Закрити», and closes', async () => {
    const onClose = renderCard()
    const close = screen.getByRole('button', { name: 'Закрити' })
    expect(close).toHaveClass('size-11')
    await userEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes', async () => {
    const onClose = renderCard()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traps focus inside the dialog', async () => {
    const [s1, s2] = [source(1), source(2)]
    withCard(
      cardFixture({ sources: { items: [PRIMARY, s1, s2], totalCount: 3, nextCursor: null } }),
    )
    renderCard()
    const close = screen.getByRole('button', { name: 'Закрити' })
    const first = screen.getByTestId(`job-queue-source-${s1.sourceRecordId}`)
    const second = screen.getByTestId(`job-queue-source-${s2.sourceRecordId}`)
    // the last control is the footer's «Приховати» (HR has no admin menu); Tab wraps both ways
    const last = screen.getByRole('button', { name: 'Приховати' })
    expect(close).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(last).toHaveFocus()
    await userEvent.tab()
    expect(close).toHaveFocus()
    act(() => first.focus())
    await userEvent.tab()
    expect(second).toHaveFocus()
  })

  it('returns focus to the control that opened it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open-row
          </button>
          {open && (
            <JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={() => setOpen(false)} />
          )}
        </>
      )
    }
    render(<Harness />, { wrapper: Wrapper })
    const opener = screen.getByRole('button', { name: 'open-row' })
    await userEvent.click(opener)
    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  describe('CR-L-1: focus on close when the opening row is gone or about to go', () => {
    let lose: () => void = () => {}
    function Harness({ dropOpener = false }: { dropOpener?: boolean }) {
      const [open, setOpen] = useState(false)
      const [opener, setOpener] = useState(true)
      const [, rerender] = useState(0)
      const park = useRef<HTMLDivElement>(null)
      lose = () => rerender((n) => n + 1)
      return (
        <div ref={park} tabIndex={-1} data-testid="park">
          {opener && (
            <button type="button" onClick={() => setOpen(true)}>
              open-row
            </button>
          )}
          {open && (
            <JobQueueCard
              scope={SCOPE}
              opportunityId={OPP}
              focusFallback={park}
              onClose={() => {
                setOpen(false)
                if (dropOpener) setOpener(false)
              }}
            />
          )}
        </div>
      )
    }

    it('an ordinary close still returns to a connected opener, not the fallback', async () => {
      render(<Harness />, { wrapper: Wrapper })
      const opener = screen.getByRole('button', { name: 'open-row' })
      await userEvent.click(opener)
      await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))
      await waitFor(() => expect(opener).toHaveFocus())
    })

    it('an opener no longer in the document: focus goes to the fallback, not <body>', async () => {
      render(<Harness dropOpener />, { wrapper: Wrapper })
      await userEvent.click(screen.getByRole('button', { name: 'open-row' }))
      await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))
      expect(screen.queryByRole('button', { name: 'open-row' })).toBeNull()
      await waitFor(() => expect(screen.getByTestId('park')).toHaveFocus())
    })

    it('QA-LOW-3: a card opened by URL (no opener, <body> active) closes onto the fallback, not <body>', async () => {
      function DeepLink() {
        const [open, setOpen] = useState(true)
        const park = useRef<HTMLDivElement>(null)
        return (
          <div ref={park} tabIndex={-1} data-testid="park">
            {open && (
              <JobQueueCard
                scope={SCOPE}
                opportunityId={OPP}
                focusFallback={park}
                onClose={() => setOpen(false)}
              />
            )}
          </div>
        )
      }
      expect(document.body).toHaveFocus()
      render(<DeepLink />, { wrapper: Wrapper })
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).toBeNull()
      await waitFor(() => expect(screen.getByTestId('park')).toHaveFocus())
    })

    it.each([
      [
        'the card',
        () =>
          cardHook.mockReturnValue(
            cardResult({ data: undefined, accessLost: true, isError: true }),
          ),
      ],
      [
        'a continuation',
        () =>
          vi
            .mocked(useJobQueueSeniors)
            .mockReturnValue(idleContinuation([], { isError: true, accessLost: true }) as never),
      ],
    ] as const)(
      'a loss on %s: focus goes to the fallback, though the row is still there',
      async (_what, fail) => {
        withCard(
          cardFixture({ seniors: { items: [senior()], totalCount: 300, nextCursor: 's-1' } }),
        )
        render(<Harness />, { wrapper: Wrapper })
        const opener = screen.getByRole('button', { name: 'open-row' })
        await userEvent.click(opener)
        fail()
        act(() => lose())
        expect(screen.queryByRole('dialog')).toBeNull()
        await waitFor(() => expect(screen.getByTestId('park')).toHaveFocus())
        expect(opener).toBeInTheDocument()
        expect(opener).not.toHaveFocus()
      },
    )
  })

  it('header badges: triage, seniority and «Закрита» for a closed or expired vacancy', () => {
    withCard(cardFixture({ eligibility: 'TRIAGE', availability: 'CLOSED', seniority: 'LEAD' }))
    renderCard()
    const header = screen.getByTestId('job-queue-card-badges')
    const triage = within(header).getByText('Потребує розгляду')
    const seniority = within(header).getByText('Лід')
    const closed = within(header).getByText('Закрита')
    for (const chip of [triage, seniority, closed]) {
      expect(chip).toHaveClass('inline-flex', 'rounded-md', 'border', 'text-xs')
    }
    expect(triage).toHaveClass('border-dashed', 'border-yellow-muted', 'text-muted-foreground')
    expect(triage).not.toHaveClass('font-medium')
    expect(seniority).toHaveClass('font-medium')
    expect(seniority).not.toHaveClass('border-dashed')
    expect(closed).toHaveClass('border-destructive', 'text-destructive')
  })

  it.each([
    ['seniority alone', { seniority: 'SENIOR' as const }, ['Сеньйор']],
    [
      'triage alone',
      { eligibility: 'TRIAGE' as const, seniority: 'UNKNOWN' as const },
      ['Потребує розгляду'],
    ],
    [
      'closed alone',
      { availability: 'CLOSED' as const, seniority: 'UNKNOWN' as const },
      ['Закрита'],
    ],
  ])('the badge row shows for %s', (_name, over, texts) => {
    withCard(cardFixture(over))
    renderCard()
    const header = screen.getByTestId('job-queue-card-badges')
    expect(header).toHaveTextContent(texts.join(''))
  })

  it('an expired vacancy reads «Прострочена», not «Закрита»; an open one has no status chip', () => {
    withCard(cardFixture({ availability: 'EXPIRED' }))
    const first = render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={vi.fn()} />, {
      wrapper: Wrapper,
    })
    expect(screen.getByTestId('job-queue-card-closed')).toHaveTextContent(/^Прострочена$/)
    first.unmount()
    withCard(cardFixture({ availability: 'UNKNOWN', seniority: 'UNKNOWN' }))
    renderCard()
    expect(screen.queryByTestId('job-queue-card-closed')).toBeNull()
    expect(screen.queryByTestId('job-queue-card-badges')).toBeNull()
  })

  it('company and meta: a missing company and an unknown publication date are said in words', () => {
    withCard(cardFixture({ companyName: null, publishedAt: null }))
    renderCard()
    expect(screen.getByText('Компанію не вказано')).toBeVisible()
    expect(screen.getByTestId('job-queue-card-meta')).toHaveTextContent(
      /^Дата публікації невідома · вперше побачено /,
    )
  })

  it('shows the informational note only when the card is newer than the list', () => {
    withCard(cardFixture({ newerThanList: true }))
    const first = render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={vi.fn()} />, {
      wrapper: Wrapper,
    })
    expect(screen.getByTestId('job-queue-card-updated')).toHaveTextContent(
      'Вакансію оновлено після побудови спискуНижче — актуальні дані.',
    )
    first.unmount()
    withCard(cardFixture())
    renderCard()
    expect(screen.queryByTestId('job-queue-card-updated')).toBeNull()
  })

  it('renders the untrusted description inert', () => {
    withCard(
      cardFixture({
        descriptionMd: ['<script>alert(1)</script>', '[x](javascript:alert(1)) **ok**'].join(
          '\n\n',
        ),
      }),
    )
    renderCard()
    const desc = screen.getByTestId('job-queue-card-description')
    expect(screen.getByRole('heading', { name: 'Опис' })).toBeVisible()
    expect(desc.innerHTML).not.toMatch(/<script/i)
    expect(within(desc).queryByRole('link')).toBeNull()
    expect(within(desc).getByText('ok', { selector: 'strong' })).toBeVisible()
  })

  it('«Збіг стеку»: the vacancy stack, hit style on the matched tokens only', () => {
    withCard(cardFixture({ stackKeywords: ['react', 'TypeScript', 'GraphQL'] }))
    renderCard()
    const stack = screen.getByTestId('job-queue-card-stack')
    expect(within(stack).getByRole('heading', { name: 'Збіг стеку' })).toBeVisible()
    const chips = within(stack).getAllByTestId('job-queue-card-stack-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['react', 'TypeScript', 'GraphQL'])
    const hit = within(stack).getByText('TypeScript')
    expect(hit).toHaveClass(
      'bg-yellow-subtle',
      'text-primary',
      'max-w-full',
      '[overflow-wrap:anywhere]',
    )
    expect(hit).toHaveAttribute('title', 'TypeScript')
    expect(hit).toHaveAttribute('data-hit', 'true')
    // matched case-insensitively: the API lowercases the vacancy stack, not the senior's tokens
    expect(within(stack).getByText('react')).toHaveAttribute('data-hit', 'true')
    const plain = within(stack).getByText('GraphQL')
    expect(plain).toHaveAttribute('data-hit', 'false')
    expect(plain).not.toHaveClass('bg-yellow-subtle')
    expect(plain).toHaveClass(
      'rounded-md',
      'border',
      'px-1.5',
      'py-0.5',
      'text-xs',
      'text-muted-foreground',
      'max-w-full',
      '[overflow-wrap:anywhere]',
    )
    // a hit is not told by its style alone: a screen reader hears it after the token (SC 1.4.1)
    expect(stack).toHaveTextContent(/react, збігаєтьсяTypeScript, збігаєтьсяGraphQL$/)
    const marks = within(stack).getAllByText(', збігається')
    expect(marks).toHaveLength(2)
    for (const mark of marks) expect(mark).toHaveClass('sr-only')
  })

  it('UX-M-1: a matched stack chip carries a decorative check, a plain one does not (SC 1.4.1)', () => {
    withCard(cardFixture({ stackKeywords: ['react', 'GraphQL'] }))
    renderCard()
    const stack = screen.getByTestId('job-queue-card-stack')
    // exactly one check, on the matched chip: it sits inside it, not on the plain one
    const icon = within(stack).getByTestId('job-queue-card-stack-hit-icon')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(within(stack).getByText('react')).toContainElement(icon)
    expect(within(stack).getByText('GraphQL')).not.toContainElement(icon)
    // the check and the token share one line: a flex row, centred, with a gap
    expect(within(stack).getByText('react')).toHaveClass('inline-flex', 'items-center', 'gap-1')
    expect(within(stack).getByText('GraphQL')).not.toHaveClass('inline-flex')
  })

  it('UX-L-5: a long stack token wraps inside the chip instead of an ellipsis', () => {
    withCard(
      cardFixture({
        matchedKeywords: [],
        stackKeywords: ['averyveryverylongstacktokenwithoutanybreakpointswhatsoever'],
      }),
    )
    renderCard()
    const chip = screen.getByTestId('job-queue-card-stack-chip')
    expect(chip).toHaveClass('max-w-full', '[overflow-wrap:anywhere]')
    expect(chip).not.toHaveClass('truncate')
  })

  it('no stack at all: no «Збіг стеку» block; a stack with no hit still shows', () => {
    const first = show(cardFixture({ matchedKeywords: [], stackKeywords: [] }))
    expect(screen.queryByTestId('job-queue-card-stack')).toBeNull()
    first.unmount()
    show(cardFixture({ matchedKeywords: [], stackKeywords: ['Go'] }))
    expect(screen.getByText('Go')).toHaveAttribute('data-hit', 'false')
  })

  it('a pre-7.3b row with no stored stack falls back to the matched tokens', () => {
    show(cardFixture({ stackKeywords: [] }))
    const chips = screen.getAllByTestId('job-queue-card-stack-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['React', 'TypeScript'])
  })

  it('meta: «востаннє бачили» always, however recent (SPEC-L-1: the design has no threshold)', () => {
    const now = Date.now()
    const old = show(cardFixture({ lastSeenAt: new Date(now - 3 * 86_400_000).toISOString() }))
    expect(screen.getByTestId('job-queue-card-meta')).toHaveTextContent(/ · востаннє бачили /)
    old.unmount()
    show(cardFixture({ lastSeenAt: new Date(now - 60_000).toISOString() }))
    expect(screen.getByTestId('job-queue-card-meta')).toHaveTextContent(/ · востаннє бачили /)
  })

  it('terms: «Форма співпраці» names B2B or employment, and «Не вказано» when none is stated', () => {
    const b2b = show(cardFixture({ engagementForm: 'B2B' }))
    expect(screen.getByTestId('job-queue-terms')).toHaveTextContent('Форма співпраці: B2B')
    b2b.unmount()
    const emp = show(cardFixture({ engagementForm: 'EMPLOYMENT' }))
    expect(screen.getByTestId('job-queue-terms')).toHaveTextContent(
      'Форма співпраці: Трудовий договір',
    )
    emp.unmount()
    // design §5.1: the engagement form stays visible even when the posting states none
    show(cardFixture({ engagementForm: null }))
    expect(screen.getByTestId('job-queue-terms')).toHaveTextContent('Форма співпраці: Не вказано')
  })

  it.each([
    ['B2B', 'B2B' as const, 'B2B'],
    ['employment', 'EMPLOYMENT' as const, 'Трудовий договір'],
    ['none stated', null, 'Не вказано'],
  ])('UX-L-1: terms value stands out, the label stays muted (%s)', (_name, form, value) => {
    show(cardFixture({ engagementForm: form }))
    const terms = screen.getByTestId('job-queue-terms')
    expect(terms).toHaveClass('text-muted-foreground')
    expect(within(terms).getByText(value)).toHaveClass('text-foreground')
  })

  it('UX-L-1: the terms line reads in English with the value still emphasised', async () => {
    await loadCatalog('en')
    show(cardFixture({ engagementForm: 'EMPLOYMENT' }))
    const terms = screen.getByTestId('job-queue-terms')
    expect(terms).toHaveTextContent(/^Contract type: Employment contract$/)
    expect(within(terms).getByText('Employment contract')).toHaveClass('text-foreground')
  })

  it('UX-M-2: an excluded vacancy has no «Потребує розгляду» badge; a triage one does', () => {
    const excluded = show(
      cardFixture({ eligibility: 'TRIAGE', noMatchReason: 'EXCLUDED', seniority: 'UNKNOWN' }),
    )
    expect(screen.queryByTestId('job-queue-card-badges')).toBeNull()
    excluded.unmount()
    const withRank = show(
      cardFixture({ eligibility: 'TRIAGE', noMatchReason: 'EXCLUDED', seniority: 'SENIOR' }),
    )
    expect(screen.getByTestId('job-queue-card-badges')).not.toHaveTextContent('Потребує розгляду')
    expect(screen.getByTestId('job-queue-card-badges')).toHaveTextContent('Сеньйор')
    withRank.unmount()
    show(cardFixture({ eligibility: 'TRIAGE', noMatchReason: 'TRIAGE', seniority: 'UNKNOWN' }))
    expect(screen.getByTestId('job-queue-card-badges')).toHaveTextContent('Потребує розгляду')
  })

  it('UX-L-2 / QA-LOW-3: the meta phrases are inline runs that never break inside themselves', () => {
    const known = show(cardFixture())
    const meta = screen.getByTestId('job-queue-card-meta')
    // no flex box around the text: a flex wrapper moved it off the line's baseline
    expect(within(meta).getByText(/^Опубліковано /).className).not.toMatch(/flex/)
    expect(within(meta).getByText(/^Опубліковано /)).toHaveClass('whitespace-nowrap')
    expect(within(meta).getByText(/^· востаннє бачили /)).toHaveClass('whitespace-nowrap')
    expect(within(meta).getByText(/^Опубліковано /).textContent).toMatch(/^\S.*\S$/)
    expect(within(meta).getByText(/^· востаннє бачили /).textContent).toMatch(/^\S.*\S$/)
    // QA4-MED-1: the line breaks between phrases, so the space before each «·» is outside the
    // nowrap spans, in the paragraph's own text
    expect(meta.textContent).toMatch(/\S · востаннє/)
    known.unmount()
    show(cardFixture({ publishedAt: null }))
    const unknown = screen.getByTestId('job-queue-card-meta')
    const date = within(unknown).getByText(/^Дата публікації невідома/)
    expect(date).toHaveClass('whitespace-nowrap')
    expect(date.className).not.toMatch(/flex/)
    expect(date).toContainElement(within(unknown).getByTestId('job-queue-card-meta-icon'))
    expect(within(unknown).getByText(/^· вперше побачено /)).toHaveClass('whitespace-nowrap')
    expect(within(unknown).getByText(/^· востаннє бачили /)).toHaveClass('whitespace-nowrap')
    for (const phrase of [
      /^Дата публікації невідома/,
      /^· вперше побачено /,
      /^· востаннє бачили /,
    ]) {
      expect(within(unknown).getByText(phrase).textContent).toMatch(/^\S.*\S$/)
    }
    expect(unknown.textContent).toMatch(/невідома · вперше побачено .*\S · востаннє/)
    const icon = within(unknown).getByTestId('job-queue-card-meta-icon')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveClass('inline-block')
  })

  it('the seniors come before the description (the decision surface first)', () => {
    renderCard()
    const seniors = screen.getByTestId(`job-queue-senior-${senior().seniorId}`)
    const desc = screen.getByTestId('job-queue-card-description')
    expect(seniors.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('403/404: closes once, toasts the one neutral text, shows no stale data', () => {
    cardHook.mockReturnValue(cardResult({ data: undefined, accessLost: true, isError: true }))
    const onClose = vi.fn()
    const view = render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={onClose} />, {
      wrapper: Wrapper,
    })
    view.rerender(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={() => onClose()} />)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Цю вакансію не знайдено')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Олена Коваль')).toBeNull()
  })

  it('403/404 arriving after the card opened: the latest onClose runs once, with the one toast', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const view = render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={first} />, {
      wrapper: Wrapper,
    })
    expect(toast.error).not.toHaveBeenCalled()
    cardHook.mockReturnValue(cardResult({ data: undefined, accessLost: true, isError: true }))
    view.rerender(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={latest} />)
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Цю вакансію не знайдено')
  })

  it.each([
    ['seniors', useJobQueueSeniors],
    ['sources', useJobQueueSources],
  ] as const)(
    'SO-1a: a 403/404 on the %s continuation takes the card path: one toast, one close',
    (_part, hook) => {
      withCard(
        cardFixture({
          seniors: { items: [senior()], totalCount: 300, nextCursor: 's-1' },
          sources: { items: [PRIMARY, source(1)], totalCount: 30, nextCursor: 'c-1' },
        }),
      )
      const onClose = vi.fn()
      const view = render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={onClose} />, {
        wrapper: Wrapper,
      })
      expect(onClose).not.toHaveBeenCalled()
      vi.mocked(hook).mockReturnValue(
        idleContinuation([], { isError: true, accessLost: true }) as never,
      )
      view.rerender(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={() => onClose()} />)
      view.rerender(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={() => onClose()} />)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(toast.error).toHaveBeenCalledWith('Цю вакансію не знайдено')
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it('does not move focus back to an opener that is not an HTML element', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <svg data-testid="svg-opener" tabIndex={0} onKeyDown={() => setOpen(true)} />
          {open && (
            <JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={() => setOpen(false)} />
          )}
        </>
      )
    }
    render(<Harness />, { wrapper: Wrapper })
    const opener = screen.getByTestId('svg-opener')
    opener.focus()
    expect(opener).toHaveFocus()
    fireEvent.keyDown(opener, { key: 'Enter' })
    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).not.toHaveFocus()
  })

  it('loading: a busy dialog with a status line', () => {
    cardHook.mockReturnValue(cardResult({ data: undefined, isPending: true }))
    renderCard()
    const dialog = screen.getByRole('dialog', { name: 'Завантажуємо вакансію…' })
    expect(dialog).toHaveAttribute('aria-busy', 'true')
  })

  it('loaded: not busy', () => {
    renderCard()
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-busy')
  })

  it('another error: says so and retries', async () => {
    const refetch = vi.fn()
    cardHook.mockReturnValue(cardResult({ data: undefined, isError: true, refetch }))
    renderCard()
    expect(screen.getByRole('dialog', { name: 'Не вдалося завантажити вакансію' })).toBeVisible()
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-busy')
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('mounts the vacancy actions in the footer and «Записати подачу» per untouched senior', () => {
    renderCard()
    const footer = screen.getByTestId('job-queue-card-footer')
    expect(within(footer).getByRole('button', { name: 'Відкрити оригінал' })).toBeVisible()
    expect(within(footer).getByRole('button', { name: 'Приховати' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Записати подачу: Олена Коваль' })).toBeVisible()
  })

  it('the footer waits for the card: none while it loads', () => {
    cardHook.mockReturnValue(cardResult({ data: undefined, isPending: true }))
    renderCard()
    expect(screen.queryByTestId('job-queue-card-footer')).toBeNull()
  })
})
