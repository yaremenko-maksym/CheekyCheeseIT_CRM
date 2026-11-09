/** r5 Task 7.3 — the vacancy card dialog (spec §5.1, §5.7, §11). */
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import type { JobQueueCardResponseDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { useJobQueueCard, useJobQueueSeniors, useJobQueueSources } from '@/hooks/use-job-queue'
import { JobQueueCard } from '../JobQueueCard'
import { cardFixture, idleContinuation, OPP, PRIMARY, senior, source } from './card-fixtures'

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

function renderCard(onClose = vi.fn()) {
  render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={onClose} />, {
    wrapper: I18nTestProvider,
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
    expect(close).toHaveFocus()
    await userEvent.tab()
    expect(first).toHaveFocus()
    await userEvent.tab()
    expect(second).toHaveFocus()
    await userEvent.tab()
    expect(close).toHaveFocus()
    await userEvent.tab({ shift: true })
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
    render(<Harness />, { wrapper: I18nTestProvider })
    const opener = screen.getByRole('button', { name: 'open-row' })
    await userEvent.click(opener)
    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('header badges: triage, seniority and «Закрита» for a closed or expired vacancy', () => {
    withCard(cardFixture({ eligibility: 'TRIAGE', availability: 'CLOSED', seniority: 'LEAD' }))
    renderCard()
    const header = screen.getByTestId('job-queue-card-badges')
    expect(within(header).getByText('Потребує розгляду')).toBeVisible()
    expect(within(header).getByText('Лід')).toBeVisible()
    expect(within(header).getByText('Закрита')).toBeVisible()
  })

  it('an expired vacancy is «Закрита» too; an open one has no status chip', () => {
    withCard(cardFixture({ availability: 'EXPIRED' }))
    const first = render(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={vi.fn()} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByTestId('job-queue-card-closed')).toHaveTextContent('Закрита')
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
      wrapper: I18nTestProvider,
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

  it('«Збіг стеку»: the matched stack as hit chips', () => {
    renderCard()
    const stack = screen.getByTestId('job-queue-card-stack')
    expect(within(stack).getByRole('heading', { name: 'Збіг стеку' })).toBeVisible()
    expect(within(stack).getByText('TypeScript')).toHaveClass('bg-yellow-subtle', 'text-primary')
  })

  it('no matched stack: no «Збіг стеку» block', () => {
    withCard(cardFixture({ matchedKeywords: [] }))
    renderCard()
    expect(screen.queryByTestId('job-queue-card-stack')).toBeNull()
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
      wrapper: I18nTestProvider,
    })
    view.rerender(<JobQueueCard scope={SCOPE} opportunityId={OPP} onClose={() => onClose()} />)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Цю вакансію не знайдено')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Олена Коваль')).toBeNull()
  })

  it('loading: a busy dialog with a status line', () => {
    cardHook.mockReturnValue(cardResult({ data: undefined, isPending: true }))
    renderCard()
    const dialog = screen.getByRole('dialog', { name: 'Завантажуємо вакансію…' })
    expect(dialog).toHaveAttribute('aria-busy', 'true')
  })

  it('another error: says so and retries', async () => {
    const refetch = vi.fn()
    cardHook.mockReturnValue(cardResult({ data: undefined, isError: true, refetch }))
    renderCard()
    expect(screen.getByRole('dialog', { name: 'Не вдалося завантажити вакансію' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('footer and per-senior action slots (Task 7.4 seams) render when given', () => {
    render(
      <JobQueueCard
        scope={SCOPE}
        opportunityId={OPP}
        onClose={vi.fn()}
        footer={<span>footer-slot</span>}
        renderSeniorAction={(s) => <span>action-{s.displayName}</span>}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByText('footer-slot')).toBeVisible()
    expect(screen.getByText('action-Олена Коваль')).toBeVisible()
  })
})
