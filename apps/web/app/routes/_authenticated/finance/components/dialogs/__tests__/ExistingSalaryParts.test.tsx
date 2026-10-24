/**
 * SR-795-M-1 / owner decision D-3 (task-retro-salary-ledger-integrity), the web
 * half. Several salary parts per employee and month are legal by design, so the
 * server cannot refuse a second one — and the measured defect leaned on exactly
 * that: nothing told the operator a part already existed, so hitting the
 * idempotency conflict and reopening the dialog (which mints a fresh key)
 * produced a second and then a third row.
 *
 * `financeApi` is mocked because the question here is what the operator SEES
 * given an answer, not how the answer is fetched; the endpoint's own behaviour
 * is pinned against a real database in `salary-month-gap.integration.spec.ts`.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const getSalaryPartsMock = vi.fn()
vi.mock('../../../api', () => ({
  financeApi: {
    getSalaryParts: (...args: unknown[]) => getSalaryPartsMock(...args),
  },
}))

import { ExistingSalaryParts } from '../create-transaction/ExistingSalaryParts'

const RECEIVER = '11111111-1111-4111-8111-111111111111'

function renderPanel(props: { receiverId?: string; salaryMonth?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ExistingSalaryParts
        receiverId={props.receiverId ?? RECEIVER}
        salaryMonth={props.salaryMonth ?? '2026-09'}
      />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  getSalaryPartsMock.mockReset()
})

describe('ExistingSalaryParts (SR-795-M-1)', () => {
  it('lists every part already on the ledger for that receiver and month', async () => {
    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [
        {
          id: 'p1',
          amount: 1500,
          currency: 'USD',
          status: 'PAID',
          salaryOrigin: 'CRON',
          txDate: null,
          notes: null,
        },
        {
          id: 'p2',
          amount: 250.5,
          currency: 'EUR',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: null,
          notes: null,
        },
      ],
    })

    renderPanel()

    const rows = await screen.findAllByTestId('create-transaction-existing-salary-part')
    expect(rows).toHaveLength(2)
    // COPY-M-2: formatted through the shared `formatMoney` in the active (uk)
    // locale, which forces exactly two decimals and joins amount + currency —
    // "1 500,00 USD", not "1 500 USD". Whitespace normalised because uk groups
    // with a narrow no-break space.
    const amount0 = (rows[0]!.textContent ?? '').replace(/\s+/g, ' ')
    expect(amount0).toContain('1 500,00 USD')
    // The localized status wording the finance table uses, not the raw code.
    expect(rows[0]).toHaveTextContent('Оплачено')
    expect(rows[1]).toHaveTextContent('Очікує валідації')
    const amount1 = (rows[1]!.textContent ?? '').replace(/\s+/g, ' ')
    expect(amount1).toContain('250,50 EUR')
    expect(getSalaryPartsMock).toHaveBeenCalledWith(RECEIVER, '2026-09')
  })

  it('says nothing at all when the month is empty — an empty month is the normal case', async () => {
    getSalaryPartsMock.mockResolvedValue({ receiverId: RECEIVER, month: '2026-09', parts: [] })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={qc}>
        <ExistingSalaryParts receiverId={RECEIVER} salaryMonth="2026-09" />
      </QueryClientProvider>,
      { wrapper: I18nTestProvider },
    )

    // Waiting for the query to SETTLE, not merely to be issued: asserting while
    // it is still in flight observes the loading path and says nothing about
    // the empty-list one, which is the guard this case is here for.
    await waitFor(() =>
      expect(qc.getQueryState(['finance', 'salary-parts', RECEIVER, '2026-09'])?.status).toBe(
        'success',
      ),
    )
    expect(screen.queryByTestId('create-transaction-existing-salary-parts')).toBeNull()
  })

  it('does not ask before there is a receiver and a well-formed month', async () => {
    renderPanel({ receiverId: '' })
    await waitFor(() => expect(getSalaryPartsMock).not.toHaveBeenCalled())

    // 2026-13 is the shape the server's own regex refuses; asking would be a
    // guaranteed 400.
    renderPanel({ salaryMonth: '2026-13' })
    await waitFor(() => expect(getSalaryPartsMock).not.toHaveBeenCalled())

    // And the control: a well-formed pair DOES ask, so the two assertions above
    // are about the guard rather than about a component that never fetches.
    getSalaryPartsMock.mockResolvedValue({ receiverId: RECEIVER, month: '2026-12', parts: [] })
    renderPanel({ salaryMonth: '2026-12' })
    await waitFor(() => expect(getSalaryPartsMock).toHaveBeenCalledWith(RECEIVER, '2026-12'))
  })

  // The cases below exist because the mutation gate reported each of these
  // lines as changeable with every test still passing (CR-H-2 / SR-M-2). Each
  // one names the behaviour the mutant would have taken away.
  it('asks with the receiver and month it was given, under a key scoped to both', async () => {
    getSalaryPartsMock.mockResolvedValue({ receiverId: RECEIVER, month: '2026-09', parts: [] })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={qc}>
        <ExistingSalaryParts receiverId={RECEIVER} salaryMonth="2026-09" />
      </QueryClientProvider>,
      { wrapper: I18nTestProvider },
    )

    await waitFor(() => expect(getSalaryPartsMock).toHaveBeenCalledWith(RECEIVER, '2026-09'))
    // A key missing the receiver or the month would serve one employee's parts
    // for another's, which is the cache bug this spells out.
    expect(
      qc
        .getQueryCache()
        .findAll()
        .map((q) => q.queryKey),
    ).toEqual([['finance', 'salary-parts', RECEIVER, '2026-09']])
  })

  it('anchors the month pattern at both ends', async () => {
    // Unanchored, '12026-09' and '2026-09-31' would both look like months and
    // the component would ask the server for something it rejects.
    for (const salaryMonth of ['12026-09', '2026-09-31', 'x2026-09']) {
      renderPanel({ salaryMonth })
      await waitFor(() => expect(getSalaryPartsMock).not.toHaveBeenCalled())
    }
  })

  it('shows nothing while the answer is still in flight', async () => {
    // Rendering the panel before the answer arrives would flash an empty amber
    // box on every receiver change.
    let resolve: (v: unknown) => void = () => {}
    getSalaryPartsMock.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )

    renderPanel()
    await waitFor(() => expect(getSalaryPartsMock).toHaveBeenCalled())
    expect(screen.queryByTestId('create-transaction-existing-salary-parts')).toBeNull()

    resolve({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [
        {
          id: 'p1',
          amount: 1,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: null,
          notes: null,
        },
      ],
    })
    await screen.findByTestId('create-transaction-existing-salary-parts')
  })

  // COPY-H-1 — Ukrainian is a one/few/many language, so a 1-vs-everything-else
  // branch is grammatically wrong for 2–4 and for 5+. These counts are chosen
  // to hit every form, INCLUDING the ones only correct under proper CLDR rules:
  //   1  → one   "1 частина"   (and the trap: 21 is ALSO one, "21 частина")
  //   2  → few   "2 частини"
  //   5  → many  "5 частин"
  //   21 → one   "21 частина"  — the old branch would have shown "21 частини"
  // The heading also names the STATE ("Вже внесено за цей місяць" — already
  // recorded, COPY-M-1), not just a bare count.
  it.each([
    [1, '1 частина зарплати'],
    [2, '2 частини зарплати'],
    [5, '5 частин зарплати'],
    [21, '21 частина зарплати'],
  ])('uk heading: %i parts → the right plural form', async (count, expectedCount) => {
    const parts = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      amount: 10,
      currency: 'USD' as const,
      status: 'PENDING' as const,
      salaryOrigin: 'MANUAL' as const,
      txDate: null,
      notes: null,
    }))
    getSalaryPartsMock.mockResolvedValue({ receiverId: RECEIVER, month: '2026-09', parts })

    const { unmount } = renderPanel()
    const panel = await screen.findByTestId('create-transaction-existing-salary-parts')
    // The heading text is split across nodes by `Trans` + `Plural`, so read the
    // whole heading and normalise whitespace rather than match a single node.
    const heading = (
      within(panel).getByTestId('create-transaction-existing-salary-parts-heading').textContent ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
    expect(heading).toBe(`Вже внесено за цей місяць: ${expectedCount}`)
    unmount()
  })

  it('formats the amount for a reader — grouped, and never more than two decimals', async () => {
    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [
        {
          id: 'p1',
          amount: 1234567.891,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: null,
          notes: null,
        },
      ],
    })

    renderPanel()

    const row = await screen.findByTestId('create-transaction-existing-salary-part')
    const text = (row.textContent ?? '').replace(/ | /g, ' ')
    // Hand-written expectation: uk-UA groups with a narrow no-break space and
    // rounds to two decimals — 1 234 567,89 USD.
    expect(text).toContain('1 234 567,89 USD')
    // And NOT three, which is what `toLocaleString` does when the options are
    // dropped. `toContain('1 234 567,89')` alone cannot say this: it is a
    // prefix of '1 234 567,891', so the weaker assertion passed either way —
    // which is precisely how the mutation gate caught it. The third decimal is
    // the whole difference, so the assertion has to name it.
    expect(text).not.toContain(',891')
  })

  it('labels a MANUAL part as entered by hand', async () => {
    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [
        {
          id: 'p1',
          amount: 1000,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: null,
          notes: null,
        },
      ],
    })

    renderPanel()

    const row = await screen.findByTestId('create-transaction-existing-salary-part')
    expect(row).toHaveTextContent('вручну')
    expect(row).not.toHaveTextContent('автоматично')
  })

  it('reads a legacy NULL origin as automatic, the way every server predicate does', async () => {
    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [
        {
          id: 'p1',
          amount: 1000,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: null,
          txDate: null,
          notes: null,
        },
      ],
    })

    renderPanel()

    const row = await screen.findByTestId('create-transaction-existing-salary-part')
    expect(row).toHaveTextContent('автоматично')
    expect(row).not.toHaveTextContent('вручну')
  })

  // QA-LOW-2 — the panel exists so an operator can RECOGNISE a part they already
  // recorded before creating a duplicate; QA found two parts in one month
  // differed only by the origin label. The business date is what distinguishes
  // them, formatted with the same locale-aware `formatDate`/`shortYY` the finance
  // table's date column uses. A legacy row may carry no date — then it is simply
  // omitted, never rendered as "Invalid Date".
  it('shows each part its business date (shortYY), and omits it when absent', async () => {
    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [
        {
          id: 'p1',
          amount: 1000,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: '2026-09-30T00:00:00.000Z',
          notes: null,
        },
        {
          id: 'p2',
          amount: 1000,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: null,
          notes: null,
        },
      ],
    })

    renderPanel()

    const rows = await screen.findAllByTestId('create-transaction-existing-salary-part')
    // uk shortYY: day.month.2-digit-year, UTC.
    expect(rows[0]).toHaveTextContent('30.09.26')
    // The dateless row renders without a date and without "Invalid Date".
    expect(rows[1]).not.toHaveTextContent('30.09.26')
    expect(rows[1]).not.toHaveTextContent(/invalid/i)
  })

  // COPY-M-2 — the whole point of the finding is that the en screen must NOT
  // show Ukrainian separators. Every other case loads uk, so a hardcoded
  // 'uk-UA' would pass them all; this one loads en and asserts the en forms, so
  // the two together prove the formatter follows the active locale rather than a
  // literal. It also exercises the en plural ("other") and the en heading.
  it('en locale: en number separators, the en heading, and the en plural form', async () => {
    await loadCatalog('en')
    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [
        {
          id: 'p1',
          amount: 1234.5,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: null,
          notes: null,
        },
        {
          id: 'p2',
          amount: 2,
          currency: 'USD',
          status: 'PENDING',
          salaryOrigin: 'MANUAL',
          txDate: null,
          notes: null,
        },
      ],
    })

    const panel = await (async () => {
      renderPanel()
      return screen.findByTestId('create-transaction-existing-salary-parts')
    })()

    const heading = (
      within(panel).getByTestId('create-transaction-existing-salary-parts-heading').textContent ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
    expect(heading).toBe('Already recorded for this month: 2 salary parts')

    const rows = await screen.findAllByTestId('create-transaction-existing-salary-part')
    const amount = (rows[0]!.textContent ?? '').replace(/\s+/g, ' ')
    // en: comma thousands, dot decimal — "1,234.50 USD", the opposite of uk.
    expect(amount).toContain('1,234.50 USD')
    expect(amount).not.toContain('1 234,50')
  })
})
