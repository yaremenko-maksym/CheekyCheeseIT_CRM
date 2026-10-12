/**
 * FromTo.test.tsx — pins every arm of the sender -> receiver cell that was
 * lifted out of TransactionRow.tsx into transaction-row/FromTo.tsx.
 *
 * Expected values are hand-written literals (never derived from the component):
 * which side is a clickable profile link vs. a plain alias, and which fallback
 * label each transaction type uses when the backend sends none.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import type { TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeAll(async () => {
  await loadCatalog('uk')
})

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: { children: React.ReactNode; to: string; params: unknown } & Record<string, unknown>) => (
    <a data-to={to} data-params={JSON.stringify(params)} {...props}>
      {children}
    </a>
  ),
}))

import { FromTo, Party } from '../transaction-row/FromTo'

const S_ID = '11111111-1111-4111-8111-111111111111'
const R_ID = '22222222-2222-4222-8222-222222222222'

function makeTx(overrides: Partial<TransactionDto>): TransactionDto {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    type: 'SALARY',
    status: 'PAID',
    amount: '1',
    currency: 'USD',
    senderId: null,
    senderLabel: null,
    senderName: null,
    receiverId: null,
    receiverLabel: null,
    receiverName: null,
    projectId: null,
    projectName: null,
    payoutRequestId: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    txFromAddress: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    recipientId: null,
    createdBy: S_ID,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  }
}

type Side = { text: string; link: 'user' | null }

function renderSides(tx: TransactionDto): Side[] | 'dash-only' {
  const { container } = render(<FromTo tx={tx} />, { wrapper: I18nTestProvider })
  // Positional (sender vs receiver) structure is the contract here; the two
  // sides can carry identical text («—»), so text queries cannot tell them apart.
  // eslint-disable-next-line testing-library/no-node-access
  const root = container.firstElementChild as HTMLElement
  if (root.tagName === 'SPAN') return 'dash-only'
  // eslint-disable-next-line testing-library/no-node-access
  const parts = Array.from(root.children)
  expect(parts).toHaveLength(3) // sender, arrow, receiver
  const [left, , right] = parts as [Element, Element, Element]
  return [left, right].map((el) => ({
    text: el.textContent ?? '',
    link: el.tagName === 'A' ? 'user' : null,
  }))
}

const FULL = {
  senderId: S_ID,
  senderName: 'Sender N',
  senderLabel: 'Sender L',
  receiverId: R_ID,
  receiverName: 'Recv N',
  receiverLabel: 'Recv L',
}

const U = (text: string): Side => ({ text, link: 'user' })
const A = (text: string): Side => ({ text, link: null })

describe('FromTo — fully populated row', () => {
  const cases: Array<[TransactionDto['type'], Side, Side]> = [
    ['ADMIN_INCOME', A('Sender L'), U('Recv N')],
    ['SENIOR_INCOME', A('Sender L'), U('Recv N')],
    ['EXPENSE', U('Sender N'), A('Recv L')],
    ['SALARY', U('Sender N'), U('Recv N')],
    ['ADMIN_TRANSFER', U('Sender N'), U('Recv N')],
    ['PAYOUT', U('Sender N'), A('Recv L')],
    ['PAYOUT_ADMIN', U('Sender N'), U('Recv N')],
    ['PAYOUT_CONFIRMED', U('Sender N'), U('Recv N')],
    ['SENIOR_PENDING_PAYOUT', A('Sender L'), U('Recv N')],
    ['DROP_PENDING_PAYOUT', A('Sender L'), U('Recv N')],
    ['DROP_INCOME', U('Sender N'), U('Recv N')],
    ['PAYOUT_DROP', U('Sender N'), U('Recv N')],
    ['COMPANY_DEPOSIT', U('Sender N'), A('Recv L')],
    ['DIVIDEND_TO_ADMIN', A('Sender L'), U('Recv N')],
  ]
  it.each(cases)('%s', (type, left, right) => {
    expect(renderSides(makeTx({ type, ...FULL }))).toEqual([left, right])
  })
})

describe('FromTo — empty row (fallback labels)', () => {
  const D = '—'
  const BRAND = 'CheekyCheeseIT'
  const COMPANY = 'Рахунок компанії'
  const cases: Array<[TransactionDto['type'], string, string]> = [
    ['ADMIN_INCOME', D, D],
    ['SENIOR_INCOME', D, D],
    ['EXPENSE', D, D],
    ['SALARY', BRAND, D],
    ['ADMIN_TRANSFER', D, D],
    ['PAYOUT', D, BRAND],
    ['PAYOUT_ADMIN', D, D],
    ['PAYOUT_CONFIRMED', D, D],
    ['SENIOR_PENDING_PAYOUT', BRAND, D],
    ['DROP_PENDING_PAYOUT', BRAND, D],
    ['DROP_INCOME', D, D],
    ['PAYOUT_DROP', BRAND, D],
    ['COMPANY_DEPOSIT', D, COMPANY],
    ['DIVIDEND_TO_ADMIN', COMPANY, D],
  ]
  it.each(cases)('%s', (type, left, right) => {
    expect(renderSides(makeTx({ type }))).toEqual([A(left), A(right)])
  })

  it('ADMIN_INCOME / SENIOR_INCOME fall back to the project name when senderLabel is absent', () => {
    for (const type of ['ADMIN_INCOME', 'SENIOR_INCOME'] as const) {
      const sides = renderSides(makeTx({ type, projectName: 'Acme' }))
      expect(sides).toEqual([A('Acme'), A('—')])
    }
  })

  it('ADMIN_INCOME prefers senderLabel over the project name', () => {
    expect(
      renderSides(makeTx({ type: 'ADMIN_INCOME', senderLabel: 'Client', projectName: 'Acme' })),
    ).toEqual([A('Client'), A('—')])
  })

  it('a placeholder type renders a lone dash, no arrow', () => {
    expect(renderSides(makeTx({ type: 'TOV_INCOME' }))).toBe('dash-only')
  })
})

describe('FromTo — company code localization', () => {
  it('maps the raw COMPANY code to the localized alias on both sides', () => {
    expect(
      renderSides(
        makeTx({ type: 'ADMIN_TRANSFER', senderLabel: 'COMPANY', receiverLabel: 'COMPANY' }),
      ),
    ).toEqual([A('Рахунок компанії'), A('Рахунок компанії')])
  })
})

describe('Party', () => {
  function renderParty(props: React.ComponentProps<typeof Party>) {
    const onParentClick = vi.fn()
    const { container } = render(
      <div onClick={onParentClick}>
        <Party {...props} />
      </div>,
      { wrapper: I18nTestProvider },
    )
    // Party has no role/text unique to it (label varies per case) — take the node positionally.
    // eslint-disable-next-line testing-library/no-node-access
    const el = container.firstElementChild!.firstElementChild as HTMLElement
    return { el, onParentClick }
  }

  it('user with id + name links to the profile route with the id param', () => {
    const { el } = renderParty({ id: S_ID, name: 'N', label: 'L', type: 'user' })
    expect(el.tagName).toBe('A')
    expect(el.getAttribute('data-to')).toBe('/profile/$userId')
    expect(el.getAttribute('data-params')).toBe(JSON.stringify({ userId: S_ID }))
    expect(el.textContent).toBe('N')
    expect(el.getAttribute('title')).toBe('N')
  })

  it('project with id + name links to the project route with the id param', () => {
    const { el } = renderParty({ id: S_ID, name: 'Proj', label: null, type: 'project' })
    expect(el.tagName).toBe('A')
    expect(el.getAttribute('data-to')).toBe('/projects/$projectId')
    expect(el.getAttribute('data-params')).toBe(JSON.stringify({ projectId: S_ID }))
  })

  it('clicking a link does not bubble to the row', () => {
    for (const type of ['user', 'project'] as const) {
      const { el, onParentClick } = renderParty({ id: S_ID, name: 'N', label: null, type })
      el.click()
      expect(onParentClick).not.toHaveBeenCalled()
    }
  })

  it('id without a name is a plain alias showing the label', () => {
    const { el } = renderParty({ id: S_ID, name: null, label: 'L', type: 'user' })
    expect(el.tagName).toBe('SPAN')
    expect(el.textContent).toBe('L')
    expect(el.getAttribute('title')).toBe('L')
  })

  it('name without an id is a plain alias showing the name', () => {
    const { el } = renderParty({ id: null, name: 'N', label: 'L', type: 'user' })
    expect(el.tagName).toBe('SPAN')
    expect(el.textContent).toBe('N')
  })

  it('nothing at all renders a dash', () => {
    const { el } = renderParty({ id: null, name: null, label: null, type: 'user' })
    expect(el.tagName).toBe('SPAN')
    expect(el.textContent).toBe('—')
  })
})
