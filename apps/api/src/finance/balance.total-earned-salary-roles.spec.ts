/**
 * PR #1521 (ACCOUNTANT removed): `getTotalEarned` counts a PAID SALARY row
 * only for the two salary roles, JUNIOR and HR. Every other role, and a role
 * the code does not know, earns nothing from a SALARY row.
 */
import { describe, expect, it } from 'vitest'
import { BalanceService } from './balance.service'

const TARGET_ID = 'target-user-1'

function makeSalaryEarnedSvc(role: string): BalanceService {
  const salaryRow = {
    id: 'tx-salary-1',
    type: 'SALARY',
    status: 'PAID',
    amount: '500',
    currency: 'USD',
    senderId: null,
    receiverId: TARGET_ID,
    recipientId: null,
    projectId: null,
    seniorSharePercent: null,
    fundingSource: null,
  }
  const drizzleClient = {
    query: {
      users: {
        findFirst: async () => ({ id: TARGET_ID, role, displayName: 'Target' }),
      },
    },
    select: () => ({ from: async () => [salaryRow] }),
  }
  const db = { db: drizzleClient } as never
  const nbu = {
    getRates: async () => ({
      usdUah: '40.0000',
      usdtUah: '40.0000',
      eurUah: '44.0000',
      date: '20260531',
    }),
  } as never
  return new BalanceService(db, nbu)
}

describe('BalanceService.getTotalEarned — SALARY counts only for JUNIOR and HR', () => {
  it.each(['JUNIOR', 'HR'])('%s: a PAID SALARY to them is earned', async (role) => {
    const result = await makeSalaryEarnedSvc(role).getTotalEarned(TARGET_ID, 'USD')
    expect(result.totalEarned).toBe(500)
    expect(result.breakdown.salary).toBe(500)
  })

  it.each(['SENIOR', 'DROP', 'ADMIN', 'ACCOUNTANT', 'GUEST'])(
    '%s: a SALARY row to them is not earned',
    async (role) => {
      const result = await makeSalaryEarnedSvc(role).getTotalEarned(TARGET_ID, 'USD')
      expect(result.totalEarned).toBe(0)
      expect(result.breakdown.salary).toBeUndefined()
    },
  )
})
