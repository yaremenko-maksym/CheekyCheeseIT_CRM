/** r5 Task 7.3 — «Сеньйори зі збігом» (spec §5.2–§5.6, visibility §3). */
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JobQueueCardResponseDto } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { useJobQueueSeniors } from '@/hooks/use-job-queue'
import { MatchedSeniors } from '../MatchedSeniors'
import { cardFixture, idleContinuation, OPP, senior, submission } from './card-fixtures'

vi.mock('@/hooks/use-job-queue', async (orig) => ({
  ...(await orig<typeof import('@/hooks/use-job-queue')>()),
  useJobQueueSeniors: vi.fn(),
}))

const HR = { actorId: 'actor', role: 'HR' as const, teamId: null }
const ADMIN = { actorId: 'actor', role: 'ADMIN' as const, teamId: null }
const seniorsHook = vi.mocked(useJobQueueSeniors)

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const S3 = 'aaaaaaaa-0000-4000-8000-000000000003'

function renderBlock(
  card: JobQueueCardResponseDto = cardFixture(),
  scope: typeof HR | typeof ADMIN = HR,
  renderAction?: Parameters<typeof MatchedSeniors>[0]['renderAction'],
  notice?: ReactNode,
) {
  return render(
    <MatchedSeniors
      scope={scope}
      card={card}
      renderAction={renderAction}
      notice={notice}
      onAccessLost={onAccessLost}
    />,
    { wrapper: I18nTestProvider },
  )
}

const none = { items: [], totalCount: 0, nextCursor: null }
const onAccessLost = vi.fn()

describe('MatchedSeniors', () => {
  beforeEach(async () => {
    seniorsHook.mockReset()
    seniorsHook.mockReturnValue(idleContinuation() as never)
    await loadCatalog('uk')
  })

  it('one block per own senior: name, «Збіг за:» chips in the hit style', () => {
    renderBlock(
      cardFixture({
        seniors: {
          items: [senior({ matchedKeywords: ['React', 'Node.js'] })],
          totalCount: 1,
          nextCursor: null,
        },
      }),
    )
    const heading = screen.getByRole('heading', { name: 'Сеньйори зі збігом 1' })
    expect(heading).toBeVisible()
    expect(heading).toHaveClass('flex', 'items-baseline', 'gap-2', 'text-sm', 'font-semibold')
    // UX-L-4: one bordered list, rows split by dividers rather than a box per senior
    expect(screen.getByTestId('job-queue-seniors-list')).toHaveClass(
      'divide-y',
      'rounded-lg',
      'border',
      'bg-card',
    )
    const block = screen.getByTestId(`job-queue-senior-${S1}`)
    expect(block).not.toHaveClass('border')
    expect(within(block).getByText('Олена Коваль')).toBeVisible()
    expect(within(block).getByText('Збіг за:')).toBeVisible()
    const chip = within(block).getByText('Node.js')
    expect(chip).toHaveClass('bg-yellow-subtle', 'text-primary')
    expect(within(block).getByText('React')).toHaveClass('bg-yellow-subtle')
    expect(chip).toHaveClass('max-w-full', 'truncate')
    expect(chip).toHaveAttribute('title', 'Node.js')
    expect(within(block).queryByText('Збіг неточний')).toBeNull()
  })

  it.each([3, 5, 21])(
    'SPEC-L-4: the label stays, a muted count follows; it counts every matched senior: %i',
    (totalCount) => {
      renderBlock(cardFixture({ seniors: { items: [senior()], totalCount, nextCursor: 's-1' } }))
      const heading = screen.getByRole('heading', { name: `Сеньйори зі збігом ${totalCount}` })
      const count = within(heading).getByText(String(totalCount))
      expect(count).toHaveClass('text-muted-foreground', 'tabular-nums')
      expect(count.tagName).toBe('SPAN')
    },
  )

  it('UX-L-6: the count sits at the right end of the heading row (spec §5.1)', () => {
    renderBlock(cardFixture({ seniors: { items: [senior()], totalCount: 3, nextCursor: 's-1' } }))
    const heading = screen.getByRole('heading', { name: 'Сеньйори зі збігом 3' })
    expect(heading).toHaveClass('flex', 'items-baseline')
    expect(within(heading).getByText('3')).toHaveClass(
      'ml-auto',
      'text-muted-foreground',
      'tabular-nums',
    )
  })

  it('UX-L-5: a triage card with TRIAGE-outcome matches shows no count, since no list renders', () => {
    renderBlock(
      cardFixture({
        eligibility: 'TRIAGE',
        seniors: { items: [senior()], totalCount: 1, nextCursor: null },
      }),
    )
    expect(screen.getByTestId('job-queue-seniors-triage')).toBeVisible()
    expect(screen.queryByTestId('job-queue-seniors-list')).toBeNull()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(/^Сеньйори зі збігом$/)
  })

  it('UX-L-5: no count over the stop-all state either', () => {
    renderBlock(cardFixture({ stopListedSeniorCount: 2, seniors: { ...none, totalCount: 2 } }))
    expect(screen.getByTestId('job-queue-seniors-stop-all')).toBeVisible()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(/^Сеньйори зі збігом$/)
  })

  it('the notice slot (apply-first) sits between the heading and the first senior, only over a list', () => {
    const view = renderBlock(cardFixture(), HR, undefined, <p data-testid="notice-slot">n</p>)
    const heading = screen.getByRole('heading', { level: 3 })
    const notice = screen.getByTestId('notice-slot')
    const list = screen.getByTestId('job-queue-seniors-list')
    expect(heading.compareDocumentPosition(notice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(notice.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    view.unmount()
    renderBlock(
      cardFixture({ eligibility: 'TRIAGE', seniors: none }),
      HR,
      undefined,
      <p data-testid="notice-slot">n</p>,
    )
    expect(screen.queryByTestId('notice-slot')).toBeNull()
  })

  it('UX-L-4: with no matched senior the heading carries no count', () => {
    renderBlock(
      cardFixture({
        eligibility: 'TRIAGE',
        seniors: { items: [], totalCount: 0, nextCursor: null },
      }),
    )
    expect(screen.getByRole('heading', { name: 'Сеньйори зі збігом' })).toBeVisible()
  })

  it.each([
    ['two words', 'Олена Коваль', 'ОК'],
    ['one word', 'Ігор', 'І'],
    ['three words, lower case, extra whitespace', '  ivan   petro  kovalenko ', 'IP'],
  ])('the avatar shows initials: %s', (_case, displayName, expected) => {
    renderBlock(
      cardFixture({
        seniors: { items: [senior({ displayName })], totalCount: 1, nextCursor: null },
      }),
    )
    const avatar = within(screen.getByTestId(`job-queue-senior-${S1}`)).getByText(expected)
    expect(avatar).toHaveAttribute('aria-hidden', 'true')
    expect(avatar.textContent).toBe(expected)
  })

  it('a senior with no matched tokens has no «Збіг за:» line', () => {
    renderBlock(
      cardFixture({
        seniors: { items: [senior({ matchedKeywords: [] })], totalCount: 1, nextCursor: null },
      }),
    )
    expect(screen.queryByText('Збіг за:')).toBeNull()
  })

  it('an approximate match says so in text, not colour alone', () => {
    renderBlock(
      cardFixture({
        seniors: { items: [senior({ matchApproximate: true })], totalCount: 1, nextCursor: null },
      }),
    )
    expect(
      within(screen.getByTestId(`job-queue-senior-${S1}`)).getByText('Збіг неточний'),
    ).toBeVisible()
  })

  it('an own submission shows «Подано · …», with the submitter when the API names one', () => {
    renderBlock(
      cardFixture({
        seniors: {
          items: [
            senior({ submission: submission() }),
            senior({
              seniorId: S2,
              displayName: 'Ігор',
              submission: submission({ seniorId: S2, submittedByName: 'Ірина' }),
            }),
          ],
          totalCount: 2,
          nextCursor: null,
        },
      }),
    )
    expect(screen.getByTestId(`job-queue-senior-submitted-${S1}`)).toHaveTextContent(
      /^Подано · 2 год(ини)? тому$/,
    )
    expect(screen.getByTestId(`job-queue-senior-submitted-${S2}`)).toHaveTextContent(
      /^Подано: Ірина · 2 год(ини)? тому$/,
    )
  })

  it('a released submission reads as not submitted', () => {
    renderBlock(
      cardFixture({
        seniors: {
          items: [senior({ submission: submission({ state: 'RELEASED' }) })],
          totalCount: 1,
          nextCursor: null,
        },
      }),
    )
    expect(screen.queryByTestId(`job-queue-senior-submitted-${S1}`)).toBeNull()
    expect(screen.queryByText(/Подано/)).toBeNull()
  })

  // QA-LOW-1. Plan r5 (Task 6.x, A3 option (a)): "a submission is a fact about the senior: it is
  // shown to every team the senior belongs to, without a name". Design §3's «submitted by another
  // team» row is about a vacancy, not a shared senior, so the marker is shown, with nothing more.
  it('a shared senior submitted by another team (bare marker) reads «Подано», with no name, time or place', () => {
    renderBlock(
      cardFixture({
        seniors: {
          items: [senior({ submission: { submittedElsewhere: true } })],
          totalCount: 1,
          nextCursor: null,
        },
      }),
    )
    const state = screen.getByTestId(`job-queue-senior-submitted-${S1}`)
    expect(state.textContent).toBe('Подано')
    // §3 leak pattern: no team, actor, time or vacancy appears next to the marker
    expect(screen.getByTestId(`job-queue-senior-${S1}`)).not.toHaveTextContent(
      /команд|тому|зараз|Подано:|·/,
    )
  })

  it('the action slot (Task 7.4 seam) renders inside each senior block with that senior', () => {
    const renderAction = vi.fn((s: { seniorId: string }) => <span>slot-{s.seniorId}</span>)
    renderBlock(cardFixture(), HR, renderAction)
    expect(
      within(screen.getByTestId(`job-queue-senior-${S1}`)).getByText(`slot-${S1}`),
    ).toBeVisible()
  })

  it('partial stop-list: the count and the reason under the list, never a name', () => {
    renderBlock(cardFixture({ stopListedSeniorCount: 2 }))
    const note = screen.getByTestId('job-queue-stop-some')
    expect(note).toHaveTextContent(
      'Виключено за стоп-листом: 2Ці сеньйори внесли компанію до власного стоп-листа, тому вакансія їм не пропонується.',
    )
    expect(screen.getByTestId(`job-queue-senior-${S1}`)).toBeVisible()
  })

  it('all stop-listed (HR): the scoped empty state, no list', () => {
    renderBlock(cardFixture({ matchedSeniorCount: 0, stopListedSeniorCount: 3, seniors: none }))
    const empty = screen.getByTestId('job-queue-seniors-stop-all')
    expect(empty).toHaveTextContent(
      'Усі сеньйори вашої команди зі збігом внесли компанію до стоп-листаСтек збігається, проте вакансію їм не пропонують.',
    )
    expect(screen.queryByTestId('job-queue-stop-some')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(empty).toHaveClass('rounded-lg', 'border', 'p-4')
    expect(empty).not.toHaveClass('border-dashed')
    expect(empty).not.toHaveClass('border-yellow-muted')
  })

  it('all stop-listed (ADMIN): the studio sentence', () => {
    renderBlock(
      cardFixture({ matchedSeniorCount: 0, stopListedSeniorCount: 3, seniors: none }),
      ADMIN,
    )
    expect(screen.getByTestId('job-queue-seniors-stop-all')).toHaveTextContent(
      /^Усі сеньйори зі збігом внесли компанію до стоп-листа/,
    )
  })

  it('QA-MED-1: all stop-listed in the shape the API sends (TRIAGE, 0 seniors) is the stop-all state, not triage', () => {
    renderBlock(
      cardFixture({
        eligibility: 'TRIAGE',
        matchedSeniorCount: 0,
        stopListedSeniorCount: 2,
        seniors: none,
      }),
    )
    expect(screen.getByTestId('job-queue-seniors-stop-all')).toHaveTextContent(
      'Усі сеньйори вашої команди зі збігом внесли компанію до стоп-листаСтек збігається, проте вакансію їм не пропонують.',
    )
    expect(screen.queryByTestId('job-queue-seniors-triage')).toBeNull()
    expect(screen.queryByText('Сеньйорів не підібрано автоматично')).toBeNull()
  })

  it('zero matches (HR / ADMIN): a different headline and scoped body', () => {
    const hr = renderBlock(cardFixture({ matchedSeniorCount: 0, seniors: none }))
    expect(screen.getByTestId('job-queue-seniors-none')).toHaveTextContent(
      'Немає сеньйорів зі збігом стекуВакансія лишається в черзі, але жоден сеньйор із вашої команди не збігається за стеком.',
    )
    hr.unmount()
    renderBlock(cardFixture({ matchedSeniorCount: 0, seniors: none }), ADMIN)
    expect(screen.getByTestId('job-queue-seniors-none')).toHaveTextContent(
      'Немає сеньйорів зі збігом стекуВакансія лишається в черзі, але жоден сеньйор не збігається за стеком.',
    )
  })

  it('triage: the manual-review empty state, no names, no team wording', () => {
    renderBlock(cardFixture({ eligibility: 'TRIAGE', matchedSeniorCount: 0, seniors: none }))
    const empty = screen.getByTestId('job-queue-seniors-triage')
    expect(empty).toHaveClass('rounded-lg', 'border', 'border-dashed', 'border-yellow-muted')
    expect(empty).toHaveTextContent(
      'Сеньйорів не підібрано автоматичноРоботодавця не вдалося підтвердити, тому система не пропонує цю вакансію конкретним сеньйорам. Оцініть її вручну за описом.',
    )
    expect(screen.queryByTestId('job-queue-seniors-none')).toBeNull()
    expect(screen.queryByTestId('job-queue-seniors-stop-all')).toBeNull()
  })

  it('continues past the preview by its cursor, then page by page', async () => {
    const fetchNextPage = vi.fn()
    renderBlock(cardFixture({ seniors: { items: [senior()], totalCount: 3, nextCursor: 's-1' } }))
    expect(seniorsHook).toHaveBeenLastCalledWith(HR, OPP, null)
    expect(screen.getByTestId('job-queue-seniors-shown')).toHaveTextContent('Показано 1 із 3')

    seniorsHook.mockReturnValue(
      idleContinuation(
        [
          {
            items: [senior({ seniorId: S2, displayName: 'Ігор' })],
            totalCount: 3,
            nextCursor: 's-2',
          },
        ],
        { hasNextPage: true, fetchNextPage },
      ) as never,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Показати ще (2)' }))
    expect(seniorsHook).toHaveBeenLastCalledWith(HR, OPP, 's-1')
    expect(screen.getByTestId(`job-queue-senior-${S2}`)).toBeVisible()
    expect(screen.getByTestId('job-queue-seniors-shown')).toHaveTextContent('Показано 2 із 3')
    expect(fetchNextPage).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Показати ще (1)' }))
    expect(fetchNextPage).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId(`job-queue-senior-${S3}`)).toBeNull()
  })

  it('UX-M-2 / QA-LOW-2: the last page by keyboard hands focus to the first new senior, not the dialog', async () => {
    renderBlock(cardFixture({ seniors: { items: [senior()], totalCount: 2, nextCursor: 's-1' } }))
    seniorsHook.mockReturnValue(
      idleContinuation([
        { items: [senior({ seniorId: S2, displayName: 'Ігор' })], totalCount: 2, nextCursor: null },
      ]) as never,
    )
    screen.getByRole('button', { name: 'Показати ще (1)' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('button')).toBeNull()
    const first = screen.getByTestId(`job-queue-senior-${S2}`)
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute('tabindex', '-1')
    expect(first).toHaveClass(
      'flex',
      'flex-col',
      'gap-2',
      'p-3',
      'focus-visible:outline-none',
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-inset',
    )
  })

  it('focus handed to the new senior is not taken again on a later render', async () => {
    const card = cardFixture({ seniors: { items: [senior()], totalCount: 2, nextCursor: 's-1' } })
    const { rerender } = renderBlock(card)
    seniorsHook.mockReturnValue(
      idleContinuation([
        { items: [senior({ seniorId: S2, displayName: 'Ігор' })], totalCount: 2, nextCursor: null },
      ]) as never,
    )
    screen.getByRole('button', { name: 'Показати ще (1)' }).focus()
    await userEvent.keyboard('{Enter}')
    const own = screen.getByTestId(`job-queue-senior-${S1}`)
    own.focus()
    rerender(<MatchedSeniors scope={HR} card={card} onAccessLost={onAccessLost} />)
    expect(own).toHaveFocus()
  })

  it('a last page with nothing new leaves focus to the browser without an error', async () => {
    renderBlock(cardFixture({ seniors: { items: [senior()], totalCount: 2, nextCursor: 's-1' } }))
    seniorsHook.mockReturnValue(
      idleContinuation([{ items: [], totalCount: 2, nextCursor: null }]) as never,
    )
    screen.getByRole('button', { name: 'Показати ще (1)' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.body).toHaveFocus()
  })

  it('everything listed: no totals line and no continuation button', () => {
    renderBlock()
    expect(screen.queryByTestId('job-queue-seniors-shown')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    // no stop-listed senior: no stop-list note under the list
    expect(screen.queryByTestId('job-queue-stop-some')).toBeNull()
  })

  it('SO-1: the continuation reports a lost access to the card and offers a retry on any other failure', async () => {
    onAccessLost.mockClear()
    const fetchNextPage = vi.fn()
    seniorsHook.mockReturnValue(idleContinuation([], { isError: true, fetchNextPage }) as never)
    renderBlock(cardFixture({ seniors: { items: [senior()], totalCount: 3, nextCursor: 's-1' } }))
    expect(screen.getByTestId(`job-queue-senior-${S1}`)).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося завантажити ще')
    expect(onAccessLost).not.toHaveBeenCalled()

    seniorsHook.mockReturnValue(idleContinuation([], { isError: true, accessLost: true }) as never)
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(onAccessLost).toHaveBeenCalledTimes(1)
  })
})
