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

    renderPanel()

    await waitFor(() => expect(getSalaryPartsMock).toHaveBeenCalled())
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
