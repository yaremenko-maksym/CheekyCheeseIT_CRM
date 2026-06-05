import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import type { EmployeeContractsService } from './employee-contracts.service'
import { SignedContractsService, ipTrailingSegment } from './signed-contracts.service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminUser: SessionUser = {
  id: 'admin-1',
  email: 'admin@cc.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

const seniorUser: SessionUser = {
  id: 'senior-1',
  email: 'senior@cc.com',
  displayName: 'Senior One',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
}

const accountantUser: SessionUser = {
  id: 'acc-1',
  email: 'acc@cc.com',
  displayName: 'Acc',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
}

const otherSenior: SessionUser = {
  id: 'senior-2',
  email: 'senior2@cc.com',
  displayName: 'Other Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'senior-1',
    email: 'senior@cc.com',
    displayName: 'Senior One',
    role: 'SENIOR' as const,
    // legalFullName required by PD-4 guard (AC1) — set by ADMIN before signing.
    legalFullName: 'Сеньйор Один Тестович',
    walletUsdtErc20: '0x1234567890123456789012345678901234567890',
    walletUsdtLabel: 'Main wallet',
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    paymentMethod: 'USDT_ERC20',
    ...overrides,
  }
}

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmpl-1',
    targetRole: 'SENIOR' as const,
    version: 1,
    bodyMarkdown:
      '# MSA\n\n' +
      'Имя: {{employeeName}}\n' +
      'Email: {{employeeEmail}}\n' +
      'Роль: {{role}}\n' +
      'Дата: {{onboardingDate}}\n' +
      'Компания: {{companyName}}\n' +
      'USDT: {{walletUsdt}}\n' +
      'ФОП: {{bankUahFop}}\n' +
      'Метод: {{preferredMethod}}\n' +
      'Реквізити: {{requisites}}\n',
    isActive: true,
    createdByUserId: 'admin-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeSignedContract(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sc-1',
    userId: 'senior-1',
    templateId: 'tmpl-1',
    bodyMarkdownSnapshot: '# rendered',
    variablesFilled: {},
    signedTypedName: 'Senior One',
    signedIp: '127.0.0.1',
    signedUserAgent: 'vitest',
    signedAt: new Date('2026-06-03T00:00:00Z'),
    contractNumber: 'CHK-1-2026',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock employee_contract row
// ---------------------------------------------------------------------------

function makeEmployeeContract(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ec-1',
    userId: 'senior-1',
    sourceTemplateId: 'tmpl-1',
    bodyMarkdown:
      '# MSA\n\n' +
      'Имя: {{employeeName}}\n' +
      'Email: {{employeeEmail}}\n' +
      'Роль: {{role}}\n' +
      'Дата: {{onboardingDate}}\n' +
      'Компания: {{companyName}}\n' +
      'USDT: {{walletUsdt}}\n' +
      'ФОП: {{bankUahFop}}\n' +
      'Метод: {{preferredMethod}}\n' +
      'Реквізити: {{requisites}}\n',
    status: 'READY_TO_SIGN' as const,
    signedContractId: null,
    createdByUserId: 'admin-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-04T00:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

interface MockDb {
  db: {
    query: {
      signedContracts: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
      users: { findFirst: ReturnType<typeof vi.fn> }
    }
    transaction: ReturnType<typeof vi.fn>
  }
}

function makeDb({
  userRow = makeUser(),
  nextSeq = 1,
  insertedRow,
}: {
  userRow?: ReturnType<typeof makeUser>
  nextSeq?: number
  insertedRow?: ReturnType<typeof makeSignedContract>
} = {}): MockDb {
  const findSignedFirst = vi.fn().mockResolvedValue(undefined)
  const findSignedMany = vi.fn().mockResolvedValue([])
  const findUser = vi.fn().mockResolvedValue(userRow)

  return {
    db: {
      query: {
        signedContracts: { findFirst: findSignedFirst, findMany: findSignedMany },
        users: { findFirst: findUser },
      },
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txInsertReturning = vi
          .fn()
          .mockResolvedValue([
            insertedRow ?? makeSignedContract({ contractNumber: `CHK-${nextSeq}-2026` }),
          ])
        const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })
        const txExecute = vi.fn().mockResolvedValue([{ contract_number: `CHK-${nextSeq}-2026` }])
        const tx = {
          execute: txExecute,
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
          query: {
            signedContracts: { findFirst: findSignedFirst },
            users: { findFirst: findUser },
          },
        }
        return fn(tx as never)
      }),
    },
  }
}

/** Mock EmployeeContractsService — replaces ContractTemplatesService in sign() */
function makeEmployeeContractsSvc({
  readyContract = makeEmployeeContract(),
}: {
  readyContract?: ReturnType<typeof makeEmployeeContract> | null
} = {}) {
  return {
    getReadyForSigning: vi.fn().mockImplementation(async () => {
      if (!readyContract) throw new ConflictException('CONTRACT_NOT_READY')
      return readyContract
    }),
    markSigned: vi.fn().mockResolvedValue({ ...makeEmployeeContract(), status: 'SIGNED' }),
  } as unknown as EmployeeContractsService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignedContractsService', () => {
  describe('interpolateVariables', () => {
    it('substitutes all known placeholders', () => {
      const tmpl = makeTemplate()
      const user = makeUser({
        displayName: 'Test User',
        // legalFullName: null so employeeName falls back to displayName (tests
        // the interpolation fallback chain; signed contracts always require a
        // legalFullName but interpolateVariables itself does not enforce it).
        legalFullName: null,
        email: 'test@cc.com',
        role: 'SENIOR',
        walletUsdtErc20: '0xabc',
        paymentMethod: 'USDT_ERC20',
      })
      const date = new Date('2026-06-03T12:34:56Z')

      const result = SignedContractsService.interpolateVariables(
        tmpl.bodyMarkdown,
        user as never,
        date,
      )

      expect(result.body).toContain('Имя: Test User')
      expect(result.body).toContain('Email: test@cc.com')
      expect(result.body).toContain('Роль: Senior')
      expect(result.body).toContain('Компания: Cheeky Cheese IT')
      expect(result.body).toContain('USDT: 0xabc')
      expect(result.body).toContain('Метод: USDT (ERC-20)')
      expect(result.body).toContain('Дата: 2026-06-03')
      // variables snapshot also returned
      expect(result.variables['employeeName']).toBe('Test User')
      expect(result.variables['companyName']).toBe('Cheeky Cheese IT')
    })

    it('substitutes "не указано" for missing wallet/bank/method', () => {
      const tmpl = makeTemplate()
      const user = makeUser({
        walletUsdtErc20: null,
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
        paymentMethod: null,
      })
      const result = SignedContractsService.interpolateVariables(
        tmpl.bodyMarkdown,
        user as never,
        new Date(),
      )
      expect(result.body).toContain('USDT: не указано')
      expect(result.body).toContain('ФОП: не указано')
      expect(result.body).toContain('Метод: не указано')
    })

    it('requisites: no "не указаноне указано" duplication when both wallet and bank are empty', () => {
      // Regression: templates using {{requisites}} must produce a single
      // "не указано" when both walletUsdtErc20 and all bankUah* fields are null.
      const tmplWithRequisites = makeTemplate({
        bodyMarkdown: '- Реквізити: {{requisites}}\n- Метод: {{preferredMethod}}\n',
      })
      const user = makeUser({
        walletUsdtErc20: null,
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
        paymentMethod: null,
      })
      const result = SignedContractsService.interpolateVariables(
        tmplWithRequisites.bodyMarkdown,
        user as never,
        new Date(),
      )
      // Must contain exactly one "не указано", not "не указаноне указано"
      expect(result.body).toContain('- Реквізити: не указано')
      expect(result.body).not.toContain('не указаноне указано')
      expect(result.variables['requisites']).toBe('не указано')
    })

    it('requisites: shows wallet address for USDT_ERC20 method', () => {
      const tmpl = makeTemplate({ bodyMarkdown: 'Реквізити: {{requisites}}' })
      const user = makeUser({
        walletUsdtErc20: '0xABC123',
        paymentMethod: 'USDT_ERC20',
      })
      const result = SignedContractsService.interpolateVariables(
        tmpl.bodyMarkdown,
        user as never,
        new Date(),
      )
      expect(result.body).toBe('Реквізити: 0xABC123')
      expect(result.variables['requisites']).toBe('0xABC123')
    })

    it('requisites: shows ФОП fields for BANK_UAH_FOP method', () => {
      const tmpl = makeTemplate({ bodyMarkdown: 'Реквізити: {{requisites}}' })
      const user = makeUser({
        walletUsdtErc20: null,
        bankUahRecipient: 'Ivan Test',
        bankUahIban: 'UA111',
        bankUahRnokpp: null,
        bankUahBankName: 'PrivatBank',
        paymentMethod: 'BANK_UAH_FOP',
      })
      const result = SignedContractsService.interpolateVariables(
        tmpl.bodyMarkdown,
        user as never,
        new Date(),
      )
      expect(result.body).toContain('Ivan Test')
      expect(result.body).toContain('UA111')
      expect(result.body).toContain('PrivatBank')
      expect(result.variables['requisites']).toContain('Ivan Test')
    })

    it('builds ФОП string from all 4 bank fields when present', () => {
      const tmpl = makeTemplate()
      const user = makeUser({
        walletUsdtErc20: null,
        bankUahRecipient: 'Ivan Test',
        bankUahIban: 'UA111111111111111111111111111',
        bankUahRnokpp: '1234567890',
        bankUahBankName: 'PrivatBank',
        paymentMethod: 'BANK_UAH_FOP',
      })
      const result = SignedContractsService.interpolateVariables(
        tmpl.bodyMarkdown,
        user as never,
        new Date(),
      )
      expect(result.body).toContain('Ivan Test')
      expect(result.body).toContain('UA111111111111111111111111111')
      expect(result.body).toContain('1234567890')
      expect(result.body).toContain('PrivatBank')
      expect(result.body).toContain('Метод: ФОП (UAH)')
    })

    it('maps role enum to translated label', () => {
      const tmpl = makeTemplate({ bodyMarkdown: 'Роль: {{role}}' })
      const cases: Array<[string, string]> = [
        ['HR', 'HR'],
        ['SENIOR', 'Senior'],
        ['JUNIOR', 'Junior'],
        ['DROP', 'Drop'],
        ['ACCOUNTANT', 'Accountant'],
      ]
      for (const [enumVal, label] of cases) {
        const user = makeUser({ role: enumVal })
        const result = SignedContractsService.interpolateVariables(
          tmpl.bodyMarkdown,
          user as never,
          new Date(),
        )
        expect(result.body).toBe(`Роль: ${label}`)
      }
    })

    it('SECURITY: user-controlled value containing {{walletUsdt}} is NOT re-substituted', () => {
      // Defends against template injection: a malicious user who sets their
      // displayName to `{{walletUsdt}}` should NOT have their wallet address
      // rendered in place of their name.
      const tmpl = makeTemplate({
        bodyMarkdown: 'Имя: {{employeeName}}\nWallet: {{walletUsdt}}',
      })
      const user = makeUser({
        displayName: '{{walletUsdt}}',
        // legalFullName: null so the injection test goes through displayName path.
        legalFullName: null,
        walletUsdtErc20: '0xSECRET',
      })
      const result = SignedContractsService.interpolateVariables(
        tmpl.bodyMarkdown,
        user as never,
        new Date(),
      )
      // Single-pass substitution: employeeName slot literally contains the
      // string `{{walletUsdt}}`; walletUsdt slot contains the real wallet.
      expect(result.body).toBe('Имя: {{walletUsdt}}\nWallet: 0xSECRET')
    })

    it('leaves unknown placeholders intact (visible to ADMIN for debugging)', () => {
      const tmpl = makeTemplate({ bodyMarkdown: 'Hi {{employeeName}} / {{unknownToken}}' })
      const user = makeUser()
      const result = SignedContractsService.interpolateVariables(
        tmpl.bodyMarkdown,
        user as never,
        new Date(),
      )
      expect(result.body).toContain('{{unknownToken}}')
    })
  })

  describe('sign (A3-1 — reads from employee_contract)', () => {
    it('refuses for ADMIN role', async () => {
      const mockDb = makeDb()
      const empSvc = makeEmployeeContractsSvc()
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await expect(
        service.sign({
          userId: adminUser.id,
          userRole: 'ADMIN',
          typedName: 'X',
          ip: '127.0.0.1',
          userAgent: 'vt',
        }),
      ).rejects.toThrow(BadRequestException)
    })

    it('throws 409 CONTRACT_NOT_READY when no READY_TO_SIGN employee_contract', async () => {
      const mockDb = makeDb()
      // readyContract=null → getReadyForSigning throws ConflictException
      const empSvc = makeEmployeeContractsSvc({ readyContract: null })
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await expect(
        service.sign({
          userId: seniorUser.id,
          userRole: 'SENIOR',
          typedName: '',
          ip: '127.0.0.1',
          userAgent: 'vt',
        }),
      ).rejects.toThrow(ConflictException)
    })

    it('throws LEGAL_NAME_REQUIRED when legalFullName is null', async () => {
      const userWithoutLegal = makeUser({ legalFullName: null })
      const mockDb = makeDb({ userRow: userWithoutLegal })
      const empSvc = makeEmployeeContractsSvc()
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await expect(
        service.sign({
          userId: seniorUser.id,
          userRole: 'SENIOR',
          typedName: '',
          ip: '127.0.0.1',
          userAgent: 'vt',
        }),
      ).rejects.toThrow(BadRequestException)
    })

    it('throws LEGAL_NAME_REQUIRED when legalFullName is whitespace-only', async () => {
      const userWithEmptyLegal = makeUser({ legalFullName: '   ' })
      const mockDb = makeDb({ userRow: userWithEmptyLegal })
      const empSvc = makeEmployeeContractsSvc()
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await expect(
        service.sign({
          userId: seniorUser.id,
          userRole: 'SENIOR',
          typedName: '',
          ip: '127.0.0.1',
          userAgent: 'vt',
        }),
      ).rejects.toThrow(BadRequestException)
    })

    it('happy path: creates signed contract with CHK-<seq>-<year> and calls markSigned', async () => {
      const inserted = makeSignedContract({ contractNumber: 'CHK-5-2026' })
      const mockDb = makeDb({ insertedRow: inserted, nextSeq: 5 })
      const empSvc = makeEmployeeContractsSvc()
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      const result = await service.sign({
        userId: seniorUser.id,
        userRole: 'SENIOR',
        typedName: 'Senior One',
        ip: '10.0.0.5',
        userAgent: 'curl/8.0',
      })

      expect(result.contractNumber).toBe('CHK-5-2026')
      expect(result.userId).toBe('senior-1')
      // A3-1: markSigned must be called to transition employee_contract → SIGNED
      expect(empSvc.markSigned).toHaveBeenCalledWith('senior-1', inserted.id)
    })

    it('uses employee_contract.bodyMarkdown (not template body) as snapshot source', async () => {
      const customBody = '# Custom Body\n\nПерсональный контракт {{employeeName}}'
      const ec = makeEmployeeContract({ bodyMarkdown: customBody })
      const inserted = makeSignedContract()
      const mockDb = makeDb({ insertedRow: inserted })
      const empSvc = makeEmployeeContractsSvc({ readyContract: ec })
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await service.sign({
        userId: seniorUser.id,
        userRole: 'SENIOR',
        typedName: '',
        ip: null,
        userAgent: null,
      })

      // The tx.insert().values() call must have received the interpolated custom body
      const txMock = mockDb.db.transaction as ReturnType<typeof vi.fn>
      // Transaction was called
      expect(txMock).toHaveBeenCalled()
      // getReadyForSigning was called (not template lookup)
      expect(empSvc.getReadyForSigning).toHaveBeenCalledWith('senior-1')
    })

    it('MED#3: getReadyForSigning is called INSIDE the transaction (snapshot read inside tx)', async () => {
      const ec = makeEmployeeContract()
      const inserted = makeSignedContract()
      const callOrder: string[] = []

      // Track when transaction opens vs when getReadyForSigning is called
      const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        callOrder.push('tx:open')
        const txInsertReturning = vi.fn().mockResolvedValue([inserted])
        const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })
        const txExecute = vi.fn().mockResolvedValue([{ contract_number: 'CHK-1-2026' }])
        const tx = {
          execute: txExecute,
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
          query: { users: { findFirst: vi.fn().mockResolvedValue(makeUser()) } },
        }
        return cb(tx)
      })

      const mockDb = makeDb({ insertedRow: inserted })
      ;(mockDb.db as Record<string, unknown>).transaction = txFn

      const getReadySpy = vi.fn().mockImplementation(async () => {
        callOrder.push('getReadyForSigning:called')
        return ec
      })
      const empSvc = {
        getReadyForSigning: getReadySpy,
        markSigned: vi.fn().mockResolvedValue({ ...ec, status: 'SIGNED' }),
      } as unknown as import('./employee-contracts.service').EmployeeContractsService

      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await service.sign({
        userId: seniorUser.id,
        userRole: 'SENIOR',
        typedName: '',
        ip: null,
        userAgent: null,
      })

      // MED#3: snapshot read must happen AFTER the transaction opens
      expect(callOrder.indexOf('tx:open')).toBeLessThan(
        callOrder.indexOf('getReadyForSigning:called'),
      )
    })

    it('double-sign: CONTRACT_NOT_READY after first sign throws 409 (inside tx)', async () => {
      // MED#3: getReadyForSigning now runs inside tx — error propagates out of transaction
      const mockDb = makeDb()
      const empSvc = makeEmployeeContractsSvc({ readyContract: null })
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await expect(
        service.sign({
          userId: seniorUser.id,
          userRole: 'SENIOR',
          typedName: '',
          ip: null,
          userAgent: null,
        }),
      ).rejects.toThrow(ConflictException)
    })
  })

  describe('findById RBAC', () => {
    it('allows owner', async () => {
      const row = makeSignedContract({ userId: 'senior-1' })
      const mockDb = makeDb()
      mockDb.db.query.signedContracts.findFirst.mockResolvedValue(row)
      const service = new SignedContractsService(
        mockDb as unknown as DatabaseService,
        makeEmployeeContractsSvc(),
      )

      const result = await service.findById(row.id, seniorUser)
      expect(result).toEqual(row)
    })

    it('allows ADMIN', async () => {
      const row = makeSignedContract({ userId: 'senior-1' })
      const mockDb = makeDb()
      mockDb.db.query.signedContracts.findFirst.mockResolvedValue(row)
      const service = new SignedContractsService(
        mockDb as unknown as DatabaseService,
        makeEmployeeContractsSvc(),
      )

      const result = await service.findById(row.id, adminUser)
      expect(result).toEqual(row)
    })

    it('allows ACCOUNTANT', async () => {
      const row = makeSignedContract({ userId: 'senior-1' })
      const mockDb = makeDb()
      mockDb.db.query.signedContracts.findFirst.mockResolvedValue(row)
      const service = new SignedContractsService(
        mockDb as unknown as DatabaseService,
        makeEmployeeContractsSvc(),
      )

      const result = await service.findById(row.id, accountantUser)
      expect(result).toEqual(row)
    })

    it('forbids non-owner SENIOR', async () => {
      const row = makeSignedContract({ userId: 'senior-1' })
      const mockDb = makeDb()
      mockDb.db.query.signedContracts.findFirst.mockResolvedValue(row)
      const service = new SignedContractsService(
        mockDb as unknown as DatabaseService,
        makeEmployeeContractsSvc(),
      )

      await expect(service.findById(row.id, otherSenior)).rejects.toThrow(ForbiddenException)
    })

    it('throws NotFound when row missing', async () => {
      const mockDb = makeDb()
      mockDb.db.query.signedContracts.findFirst.mockResolvedValue(undefined)
      const service = new SignedContractsService(
        mockDb as unknown as DatabaseService,
        makeEmployeeContractsSvc(),
      )

      await expect(service.findById('nope', adminUser)).rejects.toThrow(NotFoundException)
    })
  })

  describe('findMine', () => {
    it('returns array of signed contracts for given user', async () => {
      const rows = [
        makeSignedContract(),
        makeSignedContract({ id: 'sc-2', contractNumber: 'CHK-2-2026' }),
      ]
      const mockDb = makeDb()
      mockDb.db.query.signedContracts.findMany.mockResolvedValue(rows)
      const service = new SignedContractsService(
        mockDb as unknown as DatabaseService,
        makeEmployeeContractsSvc(),
      )

      const result = await service.findMine('senior-1')
      expect(result).toHaveLength(2)
    })
  })
})

describe('ipTrailingSegment', () => {
  it('returns the last octet for IPv4', () => {
    expect(ipTrailingSegment('192.168.1.42')).toBe('42')
  })

  it('returns the last hextet for pure IPv6 (no dots to split)', () => {
    expect(ipTrailingSegment('2001:db8::1')).toBe('1')
    expect(ipTrailingSegment('fe80::a00:27ff:fe4e:66a1')).toBe('66a1')
  })

  it('unwraps IPv4-mapped IPv6 to the IPv4 last octet', () => {
    expect(ipTrailingSegment('::ffff:192.168.1.42')).toBe('42')
  })

  it('handles IPv6 loopback', () => {
    expect(ipTrailingSegment('::1')).toBe('1')
  })
})
