import type { SessionUser } from '@crm/shared'
import { mapTx, type TxWithRelations } from './transaction-mapper.util'

const ADMIN_ID = 'admin-1'
const EMP_ID = 'emp-1'
const ISO = '2026-01-02T03:04:05.000Z'
const D = new Date(ISO)

function makeTx(over: Partial<TxWithRelations> = {}): TxWithRelations {
  return {
    id: 'tx-1',
    type: 'PAYOUT',
    status: 'VALIDATED',
    amount: '100.00',
    currency: 'USD',
    originalAmount: '90.00',
    originalCurrency: 'EUR',
    exchangeRate: '1.1',
    settledAmount: '50.00',
    settledCurrency: 'USD',
    senderId: EMP_ID,
    senderLabel: 'Emp Label',
    receiverId: 'emp-2',
    receiverLabel: 'Emp2 Label',
    fundingSource: null,
    projectId: 'p-1',
    payoutRequestId: 'pr-1',
    dropCascadeOrigin: false,
    seniorSharePercent: 30,
    receiptDocumentId: 'doc-1',
    receiptExternalUrl: 'https://x.test/r',
    txHash: '0xhash',
    txFromAddress: '0xfrom',
    validatedBy: ADMIN_ID,
    validatedAt: D,
    rejectionReason: 'rr',
    notes: 'n',
    salaryMonth: '2026-01',
    txDate: D,
    recipientId: 'rec-1',
    createdBy: ADMIN_ID,
    createdAt: D,
    updatedAt: D,
    deletedAt: D,
    deletedBy: 'del-1',
    deletionReason: 'why',
    sender: { displayName: 'Emp Name', role: 'SENIOR' },
    receiver: { displayName: 'Emp2 Name', role: 'JUNIOR' },
    project: { name: 'Proj' },
    payoutRequest: null,
    seniorSharePercentSource: 'TEAM',
    ...over,
  } as unknown as TxWithRelations
}

const viewer = (role: SessionUser['role'], id = 'viewer-1') => ({ id, role }) as SessionUser

const adminSender = {
  senderId: ADMIN_ID,
  senderLabel: 'Max',
  sender: { displayName: 'Max Admin', role: 'ADMIN' },
}
const adminReceiver = {
  receiverId: ADMIN_ID,
  receiverLabel: 'Max',
  receiver: { displayName: 'Max Admin', role: 'ADMIN' },
}

describe('mapTx — privileged viewers see real identity', () => {
  it.each(['ADMIN', 'ACCOUNTANT'] as const)('%s sees internal sender and receiver', (role) => {
    const dto = mapTx(makeTx({ ...adminSender, ...adminReceiver } as never), viewer(role))
    expect(dto.senderId).toBe(ADMIN_ID)
    expect(dto.senderLabel).toBe('Max')
    expect(dto.senderName).toBe('Max Admin')
    expect(dto.receiverId).toBe(ADMIN_ID)
    expect(dto.receiverLabel).toBe('Max')
    expect(dto.receiverName).toBe('Max Admin')
    expect(dto.txFromAddress).toBe('0xfrom')
    expect(dto.validatedBy).toBe(ADMIN_ID)
    expect(dto.createdBy).toBe(ADMIN_ID)
  })
})

describe('mapTx — non-privileged viewers get masked internal parties', () => {
  it.each(['SENIOR', 'JUNIOR', 'HR', 'DROP'] as const)('%s: internal sender masked', (role) => {
    const dto = mapTx(makeTx(adminSender as never), viewer(role))
    expect(dto.senderId).toBeNull()
    expect(dto.senderLabel).toBe('CheekyCheeseIT')
    expect(dto.senderName).toBeNull()
    // receiver is a normal party: untouched
    expect(dto.receiverId).toBe('emp-2')
    expect(dto.receiverLabel).toBe('Emp2 Label')
    expect(dto.receiverName).toBe('Emp2 Name')
  })

  it.each(['SENIOR', 'JUNIOR', 'HR', 'DROP'] as const)('%s: internal receiver masked', (role) => {
    const dto = mapTx(makeTx(adminReceiver as never), viewer(role))
    expect(dto.receiverId).toBeNull()
    expect(dto.receiverLabel).toBe('CheekyCheeseIT')
    expect(dto.receiverName).toBeNull()
    // sender is a normal party: untouched
    expect(dto.senderId).toBe(EMP_ID)
    expect(dto.senderLabel).toBe('Emp Label')
    expect(dto.senderName).toBe('Emp Name')
  })

  it('masks company-account funded side via funding source', () => {
    const dto = mapTx(
      makeTx({ senderId: null, senderLabel: 'x', sender: null, fundingSource: 'COMPANY_ACCOUNT' }),
      viewer('SENIOR'),
    )
    expect(dto.senderId).toBeNull()
    expect(dto.senderLabel).toBe('CheekyCheeseIT')
    expect(dto.senderName).toBeNull()
  })

  it('strips audit identities and wallet address', () => {
    const dto = mapTx(makeTx(), viewer('SENIOR'))
    expect(dto.txFromAddress).toBeNull()
    expect(dto.validatedBy).toBeNull()
    expect(dto.createdBy).toBeNull()
  })

  it("preserves the viewer's own id on validatedBy / createdBy", () => {
    const dto = mapTx(makeTx({ validatedBy: 'me', createdBy: 'me' }), viewer('SENIOR', 'me'))
    expect(dto.validatedBy).toBe('me')
    expect(dto.createdBy).toBe('me')
  })

  it('never masks a normal non-internal party', () => {
    const dto = mapTx(makeTx(), viewer('DROP'))
    expect(dto.senderId).toBe(EMP_ID)
    expect(dto.senderLabel).toBe('Emp Label')
    expect(dto.senderName).toBe('Emp Name')
    expect(dto.receiverId).toBe('emp-2')
    expect(dto.receiverLabel).toBe('Emp2 Label')
    expect(dto.receiverName).toBe('Emp2 Name')
  })
})

describe('mapTx — every other field identical for both viewer classes', () => {
  const expected = {
    id: 'tx-1',
    type: 'PAYOUT',
    status: 'VALIDATED',
    amount: '100.00',
    currency: 'USD',
    originalAmount: '90.00',
    originalCurrency: 'EUR',
    exchangeRate: '1.1',
    settledAmount: '50.00',
    settledCurrency: 'USD',
    projectId: 'p-1',
    projectName: 'Proj',
    payoutRequestId: 'pr-1',
    dropCascadeOrigin: false,
    payoutRequest: null,
    seniorSharePercent: 30,
    seniorSharePercentSource: 'TEAM',
    receiptDocumentId: 'doc-1',
    receiptExternalUrl: 'https://x.test/r',
    txHash: '0xhash',
    validatedAt: ISO,
    rejectionReason: 'rr',
    notes: 'n',
    salaryMonth: '2026-01',
    txDate: ISO,
    recipientId: 'rec-1',
    createdAt: ISO,
    updatedAt: ISO,
    deletedAt: ISO,
    deletedBy: 'del-1',
    deletionReason: 'why',
  }

  it.each(['ADMIN', 'ACCOUNTANT', 'SENIOR', 'JUNIOR', 'HR', 'DROP'] as const)(
    '%s sees the same unmasked fields',
    (role) => {
      expect(mapTx(makeTx(), viewer(role))).toMatchObject(expected)
    },
  )

  it('falls back to nulls for absent optional fields', () => {
    const dto = mapTx(
      makeTx({
        project: null,
        payoutRequest: undefined,
        validatedAt: null,
        txDate: null,
        deletedAt: null,
        deletedBy: undefined,
        deletionReason: undefined,
        sender: null,
        receiver: null,
        seniorSharePercentSource: undefined,
        recipientId: undefined,
      } as never),
      viewer('ADMIN'),
    )
    expect(dto.projectName).toBeNull()
    expect(dto.payoutRequest).toBeNull()
    expect(dto.validatedAt).toBeNull()
    expect(dto.txDate).toBeNull()
    expect(dto.deletedAt).toBeNull()
    expect(dto.deletedBy).toBeNull()
    expect(dto.deletionReason).toBeNull()
    expect(dto.senderName).toBeNull()
    expect(dto.receiverName).toBeNull()
    expect(dto.seniorSharePercentSource).toBeNull()
    expect(dto.recipientId).toBeNull()
  })
})
