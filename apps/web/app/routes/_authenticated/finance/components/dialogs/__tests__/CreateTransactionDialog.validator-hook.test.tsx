/**
 * `useCreateTransactionValidator` (extracted verbatim from `CreateTransactionDialog`):
 * the form-level validation that runs before any create request is fired — amount,
 * project, receipt, receiver and the dividend balance cap. Expected messages are the
 * `uk` source-catalog literals.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import type { ReceiptState } from '../../ReceiptInput'
import { useCreateTransactionValidator } from '../create-transaction/useCreateTransactionValidator'

const FILE_RECEIPT: ReceiptState = {
  mode: 'file',
  documentId: 'doc-1',
  externalUrl: '',
  fileName: '',
  previewUrl: null,
  mimeType: '',
}
const EXPLORER_URL = 'https://tronscan.org/#/transaction/abc123'

type Args = Parameters<typeof useCreateTransactionValidator>[0]

function validate(over: Partial<Args> = {}): Record<string, string> {
  const args: Args = {
    amount: '100',
    receipt: FILE_RECEIPT,
    type: 'SENIOR_INCOME',
    projectId: 'proj-1',
    showReceipt: true,
    effectiveCurrency: 'EUR',
    isAdmin: true,
    receiverId: 'rcv-1',
    transferReceiverId: 'adm-2',
    dividendReceiverId: 'adm-2',
    companyBalance: 500,
    ...over,
  }
  const { result } = renderHook(() => useCreateTransactionValidator(args), {
    wrapper: I18nTestProvider,
  })
  return result.current()
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('amount', () => {
  it('a fully valid form has no errors', () => {
    expect(validate()).toEqual({})
  })

  it.each(['', 'abc', '0', '-5', '1,5'])('"%s" is rejected', (amount) => {
    expect(validate({ amount }).amount).toBe('Вкажіть коректну суму')
  })

  it('the smallest positive amount is accepted', () => {
    expect(validate({ amount: '0.01' }).amount).toBeUndefined()
  })
})

describe('project', () => {
  it.each(['ADMIN_INCOME', 'SENIOR_INCOME', 'DROP_INCOME'] as const)(
    '%s requires a project',
    (type) => {
      expect(validate({ type, projectId: '' }).project).toBe('Виберіть проєкт')
    },
  )

  it('EXPENSE does not carry a project', () => {
    expect(validate({ type: 'EXPENSE', projectId: '' }).project).toBeUndefined()
  })
})

describe('receipt', () => {
  it('is mandatory when the type carries one, and the message is translated (not a raw zod key)', () => {
    const empty: ReceiptState = { ...FILE_RECEIPT, documentId: null }
    const msg = validate({ receipt: empty }).receipt
    expect(msg).toBeTruthy()
    expect(msg).not.toMatch(/^zod\./)
  })

  it('is not checked when the type carries no receipt', () => {
    const empty: ReceiptState = { ...FILE_RECEIPT, documentId: null }
    expect(validate({ receipt: empty, showReceipt: false }).receipt).toBeUndefined()
  })

  it('an uploaded file is fine for a non-USDT currency', () => {
    expect(validate({ effectiveCurrency: 'EUR' }).receipt).toBeUndefined()
  })

  it('a file mode ignores a stale link left over from url mode', () => {
    const stale: ReceiptState = { ...FILE_RECEIPT, externalUrl: 'https://stale.test/r' }
    expect(validate({ receipt: stale }).receipt).toBeUndefined()
  })

  it('url mode with a link is fine for a non-USDT currency', () => {
    const url: ReceiptState = {
      ...FILE_RECEIPT,
      mode: 'url',
      documentId: null,
      externalUrl: 'https://x.test/r',
    }
    expect(validate({ receipt: url }).receipt).toBeUndefined()
  })

  it('url mode ignores a stale document id left over from file mode', () => {
    const url: ReceiptState = {
      ...FILE_RECEIPT,
      mode: 'url',
      documentId: 'doc-stale',
      externalUrl: 'https://x.test/r',
    }
    expect(validate({ receipt: url }).receipt).toBeUndefined()
  })

  it('url mode with an empty link is missing', () => {
    const url: ReceiptState = { ...FILE_RECEIPT, mode: 'url', documentId: null, externalUrl: '' }
    expect(validate({ receipt: url }).receipt).toBeTruthy()
  })

  it('USDT accepts only a blockchain-explorer link', () => {
    const explorer: ReceiptState = {
      ...FILE_RECEIPT,
      mode: 'url',
      documentId: null,
      externalUrl: EXPLORER_URL,
    }
    expect(validate({ effectiveCurrency: 'USDT', receipt: explorer }).receipt).toBeUndefined()
    expect(validate({ effectiveCurrency: 'USDT' }).receipt).toBeTruthy() // uploaded file
  })
})

describe('receiver', () => {
  it('ADMIN_INCOME by an ADMIN needs an explicit receiver', () => {
    expect(validate({ type: 'ADMIN_INCOME', receiverId: '' }).receiver).toBe('Виберіть отримувача')
  })

  it('ADMIN_INCOME by an ACCOUNTANT has no receiver picker, so nothing to validate', () => {
    expect(
      validate({ type: 'ADMIN_INCOME', receiverId: '', isAdmin: false }).receiver,
    ).toBeUndefined()
  })

  it('an ADMIN who picked a receiver is fine', () => {
    expect(validate({ type: 'ADMIN_INCOME', receiverId: 'adm-2' }).receiver).toBeUndefined()
  })

  it('SALARY needs an employee', () => {
    expect(validate({ type: 'SALARY', receiverId: '' }).receiver).toBe('Виберіть співробітника')
    expect(validate({ type: 'SALARY', receiverId: 'emp-1' }).receiver).toBeUndefined()
  })

  it('ADMIN_TRANSFER needs a resolved receiver', () => {
    expect(validate({ type: 'ADMIN_TRANSFER', transferReceiverId: '' }).receiver).toBe(
      'Виберіть отримувача',
    )
    expect(
      validate({ type: 'ADMIN_TRANSFER', transferReceiverId: 'adm-2' }).receiver,
    ).toBeUndefined()
  })

  it('other types never inspect the transfer receiver', () => {
    expect(validate({ type: 'EXPENSE', transferReceiverId: '' }).receiver).toBeUndefined()
  })

  it('other types never inspect the dividend receiver', () => {
    expect(validate({ type: 'EXPENSE', dividendReceiverId: '' }).receiver).toBeUndefined()
  })
})

describe('DIVIDEND', () => {
  const dividend = { type: 'DIVIDEND', effectiveCurrency: 'USDT', receipt: urlReceipt() } as const

  function urlReceipt(): ReceiptState {
    return { ...FILE_RECEIPT, mode: 'url', documentId: null, externalUrl: EXPLORER_URL }
  }

  it('needs a partner receiver', () => {
    expect(validate({ ...dividend, dividendReceiverId: '' }).receiver).toBe(
      'Виберіть отримувача-партнера',
    )
    expect(validate({ ...dividend }).receiver).toBeUndefined()
  })

  it('cannot exceed the company-account balance', () => {
    expect(validate({ ...dividend, amount: '500.01' }).amount).toBe(
      'Сума перевищує баланс рахунку компанії',
    )
  })

  it('may take exactly the whole balance', () => {
    expect(validate({ ...dividend, amount: '500' }).amount).toBeUndefined()
  })

  it('a zero / negative / non-numeric amount reports the generic amount error, not the balance one', () => {
    expect(validate({ ...dividend, amount: '0' }).amount).toBe('Вкажіть коректну суму')
    expect(validate({ ...dividend, amount: '-1' }).amount).toBe('Вкажіть коректну суму')
    expect(validate({ ...dividend, amount: 'abc' }).amount).toBe('Вкажіть коректну суму')
    expect(validate({ ...dividend, amount: '0', companyBalance: -1 }).amount).toBe(
      'Вкажіть коректну суму',
    )
  })

  it('other types are not capped by the company balance', () => {
    expect(validate({ type: 'SENIOR_INCOME', amount: '9999' }).amount).toBeUndefined()
  })
})
