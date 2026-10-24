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
import { render, screen, waitFor } from '@testing-library/react'
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
    expect(rows[0]).toHaveTextContent('1 500')
    expect(rows[0]).toHaveTextContent('USD')
    // The localized status wording the finance table uses, not the raw code.
    expect(rows[0]).toHaveTextContent('Оплачено')
    expect(rows[1]).toHaveTextContent('Очікує валідації')
    expect(rows[1]).toHaveTextContent('250,5')
    expect(rows[1]).toHaveTextContent('EUR')
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

  it('counts the parts in the heading — singular for one, the number for more', async () => {
    const part = (id: string) => ({
      id,
      amount: 10,
      currency: 'USD' as const,
      status: 'PENDING' as const,
      salaryOrigin: 'MANUAL' as const,
      txDate: null,
      notes: null,
    })

    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [part('p1')],
    })
    renderPanel()
    expect(await screen.findByText('Цей місяць уже має 1 частину зарплати')).toBeInTheDocument()

    getSalaryPartsMock.mockResolvedValue({
      receiverId: RECEIVER,
      month: '2026-09',
      parts: [part('p1'), part('p2'), part('p3')],
    })
    renderPanel()
    expect(await screen.findByText('Цей місяць уже має 3 частини зарплати')).toBeInTheDocument()
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
    // Hand-written expectation: uk-UA groups with a narrow no-break space and
    // rounds to 1 234 567,89 — not the raw 1234567.891.
    expect(row.textContent?.replace(/ | /g, ' ')).toContain('1 234 567,89')
    expect(row).not.toHaveTextContent('1234567.891')
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
})
