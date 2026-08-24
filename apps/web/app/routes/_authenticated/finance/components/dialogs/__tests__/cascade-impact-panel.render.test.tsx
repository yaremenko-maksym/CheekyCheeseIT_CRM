/**
 * task-cascade-preview-ui (task 5) — `CascadeImpactPanel` rendered directly,
 * every branch, both layouts.
 *
 * WHY A SECOND FILE. `cascade-impact-panel.test.tsx` drives the panel through
 * the dialog and asks whether the LOOP works (request → plan → token → 409).
 * This one asks what the panel SHOWS, which is a different question and needs
 * different fixtures: a derivative with no share snapshot, one whose settle is
 * in another currency, one with several warnings at once.
 *
 * BOTH LAYOUTS, ALWAYS. The component renders a table row and a card from the
 * same data and hides one with a Tailwind breakpoint. jsdom applies no CSS, so
 * BOTH are in the DOM here — which is precisely why every assertion names which
 * one it is reading. Testing only the desktop half would leave the entire
 * mobile branch unverified while looking complete; that is what the mutation
 * gate reported before this file existed (74 surviving mutants in one
 * component, nearly all of them in the untested half).
 *
 * The responsive behaviour ITSELF — which layout is actually visible at 320 vs
 * 1440 — is not assertable here for the same reason (no CSS). It was verified
 * by measuring `scrollWidth`/`getBoundingClientRect` in a real Chromium at
 * 320/375/768/1024/1280/1440/1920; see the PR body. The class assertions below
 * pin the two `hidden`/`sm:` switches that carry that behaviour, so the
 * breakpoint cannot be silently changed without this file going red.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { CascadeDerivativePlan, CascadeEditPreviewResponse } from '@crm/shared'

import { CascadeImpactPanel } from '../CascadeImpactPanel'

function derivative(over: Partial<CascadeDerivativePlan> = {}): CascadeDerivativePlan {
  return {
    id: 'd1',
    type: 'SENIOR_PENDING_PAYOUT',
    oldAmount: 8000,
    newAmount: 10000,
    sharePercent: 40,
    currency: 'USDT',
    settledAmount: 0,
    settledCurrency: null,
    remainingToPay: 10000,
    needsReconfirm: false,
    warnings: [],
    ...over,
  }
}

function preview(
  derivatives: CascadeDerivativePlan[],
  over: Partial<NonNullable<CascadeEditPreviewResponse['plan']>> = {},
): CascadeEditPreviewResponse {
  return {
    editable: true,
    blockedReason: null,
    plan: {
      sourceId: 's1',
      sourceAmountChanged: true,
      oldSourceAmount: 20000,
      newSourceAmount: 25000,
      sourceCurrency: 'USDT',
      derivatives,
      sourceWarnings: [],
      ...over,
    },
    version: 'v1',
  }
}

function renderPanel(props: Partial<Parameters<typeof CascadeImpactPanel>[0]> = {}) {
  const onRetry = vi.fn()
  const result = render(
    <CascadeImpactPanel
      preview={preview([derivative()])}
      isLoading={false}
      isNetworkError={false}
      onRetry={onRetry}
      staleMessage={null}
      sourceReceiverName="Иван Петров"
      {...props}
    />,
  )
  return { ...result, onRetry }
}

const desktop = () => screen.getByTestId('cascade-derivative-d1')
const mobile = () => screen.getByTestId('cascade-derivative-mobile-d1')
const digits = (el: HTMLElement) => (el.textContent ?? '').replace(/[^\d]/g, '')

describe('CascadeImpactPanel — the source line', () => {
  it('PR-1. shows the amount before and after, in the source currency', () => {
    renderPanel()

    const line = screen.getByTestId('cascade-source-amount')

    expect(digits(line)).toContain('20000')
    expect(digits(line)).toContain('25000')
    expect(line.textContent).toContain('USDT')
  })

  it('PR-2. a warning about the SOURCE row is rendered verbatim, above the table', () => {
    renderPanel({
      preview: preview([derivative()], {
        sourceWarnings: [
          { code: 'SOURCE_SIGNED_INVOICE', message: 'По этой строке уже есть подписанный инвойс' },
        ],
      }),
    })

    expect(
      screen.getByTestId('cascade-source-warning-SOURCE_SIGNED_INVOICE').textContent,
    ).toContain('По этой строке уже есть подписанный инвойс')
  })
})

describe('CascadeImpactPanel — one derivative, both layouts', () => {
  it('PR-3. the senior share reuses the source receiver — the same person', () => {
    renderPanel()

    expect(desktop().textContent).toContain('Синьору Иван Петров')
    expect(mobile().textContent).toContain('Синьору Иван Петров')
  })

  it('PR-4. a drop share is labelled without a name — none is available, and a wrong one is worse', () => {
    renderPanel({ preview: preview([derivative({ type: 'DROP_PENDING_PAYOUT' })]) })

    expect(desktop().textContent).toContain('Доля дропа')
    expect(desktop().textContent).not.toContain('Иван Петров')
    expect(mobile().textContent).toContain('Доля дропа')
    expect(mobile().textContent).not.toContain('Иван Петров')
  })

  it('PR-5. a senior share with no receiver name shows the type alone, not «Синьору undefined»', () => {
    renderPanel({ sourceReceiverName: null })

    expect(desktop().textContent).not.toContain('Синьору')
    expect(desktop().textContent).not.toContain('undefined')
    // And NOT the drop label either: a senior share is not a drop share, and
    // "some label is better than none" is how a receiver gets misattributed.
    expect(desktop().textContent).not.toContain('Доля дропа')
    expect(mobile().textContent).not.toContain('undefined')
  })

  it('PR-6. both figures of the transition are shown', () => {
    renderPanel()

    expect(digits(desktop())).toContain('8000')
    expect(digits(desktop())).toContain('10000')
    expect(digits(mobile())).toContain('8000')
    expect(digits(mobile())).toContain('10000')
  })

  it('PR-7. no share snapshot ⇒ a dash where the new amount would be, in both layouts', () => {
    renderPanel({
      preview: preview([
        derivative({
          newAmount: null,
          sharePercent: null,
          remainingToPay: null,
          warnings: [{ code: 'NO_SHARE_SNAPSHOT', message: 'Нет снимка процента доли' }],
        }),
      ]),
    })

    // «10 000» must be gone: there is no recomputed figure, and printing the
    // old one twice would read as "nothing changes".
    expect(digits(desktop())).not.toContain('10000')
    // The dash has to be in the «Было → Стало» CELL. «К доплате» is also a dash
    // on this fixture, so a row-wide assertion passes even when the transition
    // cell prints a fabricated figure instead.
    const cells = within(desktop()).getAllByRole('cell')
    expect(cells[1]?.textContent).toContain('—')
    expect(mobile().textContent).toContain('—')
  })

  it('PR-8. «Выплачено» appears only when something was actually paid', () => {
    renderPanel()

    expect(within(mobile()).queryByText('Выплачено')).toBeNull()

    renderPanel({
      preview: preview([
        derivative({ settledAmount: 5000, settledCurrency: 'USDT', remainingToPay: 5000 }),
      ]),
    })

    const cards = screen.getAllByTestId('cascade-derivative-mobile-d1')
    const withSettle = cards[cards.length - 1]!
    expect(within(withSettle).getByText('Выплачено')).toBeTruthy()
    expect(digits(withSettle)).toContain('5000')
  })

  it('PR-9. a settle in another currency shows ITS currency, and refuses a remainder', () => {
    renderPanel({
      preview: preview([
        derivative({
          settledAmount: 2000,
          settledCurrency: 'UAH',
          remainingToPay: null,
          warnings: [{ code: 'NON_USDT_CURRENCY', message: 'Выплата учтена в UAH' }],
        }),
      ]),
    })

    // The paid figure is real and belongs on screen; the difference is not
    // computable and must not be invented.
    expect(desktop().textContent).toContain('UAH')
    expect(desktop().textContent).toContain('—')
    expect(mobile().textContent).toContain('UAH')
  })

  it('PR-10. «вернётся в ожидание выплаты» is shown once per layout, never shared', () => {
    renderPanel({ preview: preview([derivative({ needsReconfirm: true })]) })

    // Two nodes, two ids. One id on two nodes is a strict-mode violation in
    // Playwright and an ambiguous query here — the failure this suffix exists
    // to prevent.
    expect(screen.getByTestId('cascade-derivative-reconfirm-d1')).toBeTruthy()
    expect(screen.getByTestId('cascade-derivative-reconfirm-d1-mobile')).toBeTruthy()
  })

  it('PR-11. a row that is NOT reverting says nothing about reverting', () => {
    renderPanel()

    expect(screen.queryByTestId('cascade-derivative-reconfirm-d1')).toBeNull()
    expect(screen.queryByTestId('cascade-derivative-reconfirm-d1-mobile')).toBeNull()
  })

  it('PR-12. every warning is rendered verbatim in BOTH layouts, under its own id', () => {
    renderPanel({
      preview: preview([
        derivative({
          warnings: [
            { code: 'OVERPAYMENT', message: 'Уже выплачено 5000 — строка остаётся оплаченной' },
            { code: 'SIGNED_INVOICE', message: 'Инвойс уже подписан контрагентом' },
          ],
        }),
      ]),
    })

    expect(screen.getByTestId('cascade-derivative-warning-d1-OVERPAYMENT').textContent).toContain(
      'Уже выплачено 5000 — строка остаётся оплаченной',
    )
    expect(
      screen.getByTestId('cascade-derivative-warning-d1-SIGNED_INVOICE-mobile').textContent,
    ).toContain('Инвойс уже подписан контрагентом')
  })

  it('PR-13. the mobile card holds no warning block at all when there is nothing to say', () => {
    renderPanel()

    expect(within(mobile()).queryByTestId(/warning/)).toBeNull()
  })

  it('PR-14. several derivatives each get their own row and card', () => {
    renderPanel({
      preview: preview([
        derivative({ id: 'd1' }),
        derivative({ id: 'd2', type: 'DROP_PENDING_PAYOUT' }),
      ]),
    })

    expect(screen.getByTestId('cascade-derivative-d2')).toBeTruthy()
    expect(screen.getByTestId('cascade-derivative-mobile-d2')).toBeTruthy()
  })
})

describe('CascadeImpactPanel — the figures, exactly', () => {
  it('PR-26. a settle with no recorded currency is shown in the row currency, not blank', () => {
    renderPanel({
      preview: preview([derivative({ settledAmount: 5000, settledCurrency: null })]),
    })

    // Read the «Выплачено» CELL, not the whole row: every other cell in it
    // already says USDT, so a row-wide assertion would pass even if this one
    // figure lost its unit.
    const paidCell = within(desktop()).getAllByRole('cell')[2]
    expect(paidCell?.textContent).toContain('USDT')
    expect(paidCell?.textContent).not.toContain('undefined')
  })

  it('PR-27. «К доплате» prints the remainder, and it is not one of the other two figures', () => {
    renderPanel({
      preview: preview([
        derivative({ settledAmount: 5000, settledCurrency: 'USDT', remainingToPay: 4321 }),
      ]),
    })

    // Deliberately a figure that appears nowhere else in the row: if the cell
    // printed the new amount, or a dash, this is what notices.
    expect(digits(desktop())).toContain('4321')
    expect(digits(mobile())).toContain('4321')
  })

  it('PR-28. nothing settled ⇒ the desktop «Выплачено» cell is a dash, not empty', () => {
    renderPanel()

    const cells = within(desktop()).getAllByRole('cell')
    // An empty cell reads as "no data available"; a dash reads as "nothing was
    // paid", which is the fact.
    expect(cells[2]?.textContent).toBe('—')
  })

  it("PR-29. each layout carries ITS OWN badge id — not the other one's", () => {
    renderPanel({ preview: preview([derivative({ needsReconfirm: true })]) })

    // Swapping the two suffixes would leave both ids present and both queries
    // green, while every mobile assertion silently read the desktop node.
    expect(within(desktop()).getByTestId('cascade-derivative-reconfirm-d1')).toBeTruthy()
    expect(within(mobile()).getByTestId('cascade-derivative-reconfirm-d1-mobile')).toBeTruthy()
  })

  it('PR-30. a warning line lives in the layout whose id it carries', () => {
    renderPanel({
      preview: preview([
        derivative({ warnings: [{ code: 'OVERPAYMENT', message: 'Уже выплачено 5000' }] }),
      ]),
    })

    expect(within(desktop()).getByTestId('cascade-derivative-warning-d1-OVERPAYMENT')).toBeTruthy()
    expect(
      within(mobile()).getByTestId('cascade-derivative-warning-d1-OVERPAYMENT-mobile'),
    ).toBeTruthy()
  })

  it('PR-31. a stale plan is not interactive — it is a record, not a control', () => {
    renderPanel({ staleMessage: 'Данные изменились' })

    // `pointer-events-none` is the behaviour, not the dimming: the plan below a
    // stale banner must not accept a click that would act on a dead figure.
    const dimmed = screen.getByTestId('cascade-plan-body')
    expect(dimmed.className).toContain('pointer-events-none')
  })

  it('PR-32. a fresh plan IS interactive', () => {
    renderPanel()

    expect(screen.getByTestId('cascade-plan-body').className).not.toContain('pointer-events-none')
  })

  it('PR-33. loading wins over a blocked answer — one state at a time', () => {
    renderPanel({
      isLoading: true,
      preview: { editable: false, blockedReason: 'ONCHAIN_DEPOSIT', plan: null, version: null },
    })

    // Showing a refusal for the PREVIOUS amount while the next one is still
    // being computed tells the operator something that is not (yet) true.
    expect(screen.queryByTestId('cascade-blocked-banner')).toBeNull()
    expect(screen.getByTestId('cascade-preview-loading')).toBeTruthy()
  })
})

describe('CascadeImpactPanel — severity is visible, not just present', () => {
  it('PR-34. a blocking warning reads as destructive; a weighable one as a caution', () => {
    renderPanel({
      preview: preview([
        derivative({
          newAmount: null,
          warnings: [
            { code: 'NO_SHARE_SNAPSHOT', message: 'Нет снимка процента доли' },
            { code: 'OVERPAYMENT', message: 'Уже выплачено 5000' },
          ],
        }),
      ]),
    })

    // The two are different kinds of news — one stops the save, the other asks
    // the operator to think — and a single colour for both erases that.
    const blocking = screen.getByTestId('cascade-derivative-warning-d1-NO_SHARE_SNAPSHOT')
    const weighable = screen.getByTestId('cascade-derivative-warning-d1-OVERPAYMENT')
    expect(blocking.className).toContain('text-destructive')
    expect(weighable.className).toContain('text-amber-400')
  })

  it('PR-34b. an obligation-currency mismatch is destructive too — it blocks the save', () => {
    renderPanel({
      preview: preview([
        derivative({
          warnings: [
            {
              code: 'OBLIGATION_CURRENCY_MISMATCH',
              message: 'Обязательство учтено в другой валюте',
            },
          ],
        }),
      ]),
    })

    // The second member of the blocking set. Written out because a set with one
    // member reads as complete while silently down-grading the other refusal to
    // a caution the operator may dismiss.
    expect(
      screen.getByTestId('cascade-derivative-warning-d1-OBLIGATION_CURRENCY_MISMATCH').className,
    ).toContain('text-destructive')
  })

  it('PR-36. the reverting card is accented too, not only the table row', () => {
    renderPanel({ preview: preview([derivative({ needsReconfirm: true })]) })

    // Mobile is not a lesser rendering: the one accent this screen has must
    // survive the layout the operator most often reads it in.
    expect(mobile().className).toContain('border-amber-500/30')
  })

  it('PR-35. the row that will revert is the one marked — the single accent on the screen', () => {
    renderPanel({
      preview: preview([
        derivative({ id: 'd1', needsReconfirm: true }),
        derivative({ id: 'd2', needsReconfirm: false }),
      ]),
    })

    expect(screen.getByTestId('cascade-derivative-d1').className).toContain('border-l-amber-500')
    expect(screen.getByTestId('cascade-derivative-d2').className).not.toContain(
      'border-l-amber-500',
    )
  })
})

describe('CascadeImpactPanel — which layout is which', () => {
  it('PR-15. the table row is hidden below 640px and the card above it', () => {
    renderPanel()

    // The ONE place classes are asserted, and deliberately so: this pair IS the
    // responsive contract (measured in a real browser at seven widths, see the
    // PR). Everything else in this file reads text.
    expect(desktop().className).toContain('hidden')
    expect(desktop().className).toContain('sm:table-row')
    expect(screen.getByTestId('cascade-derivative-mobile-row-d1').className).toContain('sm:hidden')
  })

  it('PR-16. the table header is hidden on mobile too — a header over cards is noise', () => {
    renderPanel()

    const thead = screen.getByTestId('cascade-table-head')
    expect(thead.className).toContain('hidden')
    expect(thead.className).toContain('sm:table-header-group')
  })

  it('PR-17. every column header is a real <th scope="col">', () => {
    renderPanel()

    const headers = screen.getAllByRole('columnheader')
    expect(headers.map((h) => h.textContent)).toEqual([
      'Получатель',
      'Было → Стало',
      'Выплачено',
      'К доплате',
      'Статус',
    ])
    expect(headers.every((h) => h.getAttribute('scope') === 'col')).toBe(true)
  })
})

describe('CascadeImpactPanel — the states that are not a plan', () => {
  it('PR-18. loading says what is being recomputed, and no plan is shown', () => {
    renderPanel({ isLoading: true })

    expect(screen.getByTestId('cascade-preview-loading').textContent).toContain(
      'Пересчитываем связанные выплаты',
    )
    expect(screen.queryByTestId('cascade-derivative-d1')).toBeNull()
  })

  it('PR-19. a network failure is named, and retrying calls back', () => {
    const { onRetry } = renderPanel({ isNetworkError: true, preview: undefined })

    expect(screen.getByTestId('cascade-preview-error').textContent).toContain(
      'проверьте соединение',
    )
    fireEvent.click(screen.getByTestId('cascade-preview-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('PR-20. a blocked answer replaces the panel with the server sentence', () => {
    renderPanel({
      preview: {
        editable: false,
        blockedReason: 'LINKED_TO_PAYOUT_REQUEST',
        plan: null,
        version: null,
      },
    })

    expect(screen.getByTestId('cascade-blocked-banner').textContent).toContain(
      'включена в оформленную заявку на выплату',
    )
    expect(screen.queryByTestId('cascade-derivative-d1')).toBeNull()
  })

  it('PR-20b. a payout row is refused with the payout sentence, not the payout-request one', () => {
    renderPanel({
      preview: { editable: false, blockedReason: 'PAYOUT_FAMILY', plan: null, version: null },
    })

    // The two refusals written for this screen sit next to each other in one
    // `Record`; a wrong key returns the WRONG sentence, and both are plausible
    // enough that nobody would notice on a screenshot.
    expect(screen.getByTestId('cascade-blocked-banner').textContent).toContain(
      'подтверждена исполненным переводом',
    )
  })

  it('PR-21. a blocked answer with NO reason still says something, not «undefined»', () => {
    renderPanel({
      preview: { editable: false, blockedReason: null, plan: null, version: null },
    })

    const banner = screen.getByTestId('cascade-blocked-banner')
    expect(banner.textContent).toContain('Правка суммы для этой строки недоступна')
    expect(banner.textContent).not.toContain('undefined')
  })

  it('PR-22. an empty plan says there is nothing to recompute', () => {
    renderPanel({ preview: preview([]) })

    expect(screen.getByTestId('cascade-preview-empty').textContent).toContain(
      'не связана с выплатами',
    )
  })

  it('PR-23. a stale plan stays on screen, dimmed, with one way forward', () => {
    const { onRetry } = renderPanel({ staleMessage: 'Данные изменились с момента предпросмотра' })

    expect(screen.getByTestId('cascade-stale-banner').textContent).toContain('Данные изменились')
    // Still visible — the operator has to see WHAT went out of date.
    expect(screen.getByTestId('cascade-derivative-d1')).toBeTruthy()
    fireEvent.click(screen.getByTestId('cascade-refresh-preview'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('PR-24. a fresh plan carries no stale banner', () => {
    renderPanel()

    expect(screen.queryByTestId('cascade-stale-banner')).toBeNull()
  })

  it('PR-25. the status line for a screen reader is polite and atomic, not the whole table', () => {
    renderPanel({ isLoading: true })

    const live = screen.getByTestId('cascade-preview-status')
    // Announcing the entire table on every keystroke is worse than announcing
    // nothing — the live region is the one-line status, never the plan.
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.getAttribute('aria-atomic')).toBe('true')
    expect(live.textContent).toContain('Пересчитываем')
  })

  it('PR-37. once the plan is in, the status line says so — silence reads as "still working"', () => {
    renderPanel()

    // A live region that announces the start and never the end leaves a
    // screen-reader user waiting for an update that already happened.
    expect(screen.getByTestId('cascade-preview-status').textContent).toBe('Предпросмотр обновлён')
  })

  it('PR-38. with nothing requested at all the status line is empty, not stale', () => {
    renderPanel({ preview: undefined })

    expect(screen.getByTestId('cascade-preview-status').textContent).toBe('')
  })
})
