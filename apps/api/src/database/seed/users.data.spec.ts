import { describe, expect, it } from 'vitest'
import { seniorTechStackSchema } from '@crm/shared'
import { HR0_ID, HR2_ID, SENIOR_SHARED_ID } from './ids'
import { d } from './shared'
import { SEED_USERS } from './users.data'

describe('SEED_USERS — SENIOR technology floor', () => {
  const seniors = SEED_USERS.filter((u) => u.role === 'SENIOR')

  it('seeds at least one SENIOR (the check below is not vacuous)', () => {
    expect(seniors.length).toBeGreaterThan(0)
  })

  it('every seeded SENIOR has at least 3 distinct technologies', () => {
    const below = seniors
      .filter((u) => !seniorTechStackSchema.safeParse(u.techStack ?? null).success)
      .map((u) => u.email)
    expect(below).toEqual([])
  })
})

/**
 * Task 7.6a — the job-queue E2E users, pinned exactly: the Task 7.6 E2E dev-logs in by these
 * emails, and the onboarding contracts carry these payment details.
 */
describe('SEED_USERS — the job-queue E2E users (Task 7.6a)', () => {
  it('keeps their ids stable', () => {
    expect([HR2_ID, HR0_ID, SENIOR_SHARED_ID]).toEqual([
      'd5a6e7f8-a9b0-4c1d-8e2f-3a4b5c6d7e01',
      'e6b7f8a9-b0c1-4d2e-9f3a-4b5c6d7e8f02',
      'f7c8a9b0-c1d2-4e3f-a04b-5c6d7e8f9a03',
    ])
  })

  it('seeds U-HR2, U-HR0 and S-SHARED with exactly these fields', () => {
    const ids: string[] = [HR2_ID, HR0_ID, SENIOR_SHARED_ID]
    const created = { createdAt: d(2025, 11, 15), updatedAt: d(2025, 11, 15) }
    expect(SEED_USERS.filter((u) => ids.includes(u.id))).toEqual([
      {
        id: HR2_ID,
        email: 'iryna.bondar@cheekycheese.dev',
        displayName: 'Iryna Bondar',
        legalFullName: 'Бондар Ірина Петрівна',
        avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=iryna',
        role: 'HR',
        telegram: '@iryna_bondar',
        phone: '+380671000026',
        monthlySalary: '700.00',
        salaryCurrency: 'USD',
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Бондар Ірина Петрівна',
        bankUahIban: 'UA213223130000026007233566005',
        bankUahRnokpp: '1357924680',
        bankUahBankName: 'monobank',
        ...created,
      },
      {
        id: HR0_ID,
        email: 'yulia.moroz@cheekycheese.dev',
        displayName: 'Yulia Moroz',
        legalFullName: 'Мороз Юлія Андріївна',
        avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=yulia',
        role: 'HR',
        telegram: '@yulia_moroz',
        phone: '+380671000027',
        monthlySalary: '700.00',
        salaryCurrency: 'USD',
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Мороз Юлія Андріївна',
        bankUahIban: 'UA213223130000026007233566006',
        bankUahRnokpp: '2468013579',
        bankUahBankName: 'ПриватБанк',
        ...created,
      },
      {
        id: SENIOR_SHARED_ID,
        email: 'taras.savchuk@cheekycheese.dev',
        displayName: 'Taras Savchuk',
        legalFullName: 'Савчук Тарас Миколайович',
        avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=taras',
        role: 'SENIOR',
        telegram: '@taras_savchuk',
        phone: '+380671000028',
        seniorSharePercent: 26,
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0x1aE0EA34a72D944a8C7603FfB3eC30a6669E454C',
        techStack: ['React', 'TypeScript', 'Node.js', 'GraphQL'],
        ...created,
      },
    ])
  })
})
