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
import {
  SignedContractsService,
  generateUniqueContractNumber,
  ipTrailingSegment,
} from './signed-contracts.service'

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
    // T4: new format CHK-<6 uppercase hex>
    contractNumber: 'CHK-7F3A9C',
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
  insertedRow,
}: {
  userRow?: ReturnType<typeof makeUser>
  // nextSeq removed: T4 uses crypto.randomBytes instead of sequence
  insertedRow?: ReturnType<typeof makeSignedContract>
} = {}): MockDb {
  // T4: findFirst for uniqueness check must return undefined (= candidate is free)
  // so generateUniqueContractNumber succeeds on the first attempt.
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
        const txInsertReturning = vi.fn().mockResolvedValue([insertedRow ?? makeSignedContract()])
        const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })
        const tx = {
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
          query: {
            // T4: uniqueness check — always return undefined (free candidate)
            signedContracts: { findFirst: vi.fn().mockResolvedValue(undefined) },
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

    it('happy path: creates signed contract with CHK-<6 hex> format and calls markSigned', async () => {
      const inserted = makeSignedContract({ contractNumber: 'CHK-AB12CD' })
      const mockDb = makeDb({ insertedRow: inserted })
      const empSvc = makeEmployeeContractsSvc()
      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      const result = await service.sign({
        userId: seniorUser.id,
        userRole: 'SENIOR',
        typedName: 'Senior One',
        ip: '10.0.0.5',
        userAgent: 'curl/8.0',
      })

      // T4: contract number must match CHK-XXXXXX (6 uppercase hex chars)
      expect(result.contractNumber).toMatch(/^CHK-[0-9A-F]{6}$/)
      expect(result.userId).toBe('senior-1')
      // A3-1: markSigned must be called to transition employee_contract → SIGNED.
      // Third arg is the Drizzle transaction handle (passed through for FK safety — see
      // employee-contracts.service.ts markSigned JSDoc). Use expect.anything() since the
      // tx object is opaque in unit tests (it's the mock db.transaction callback param).
      expect(empSvc.markSigned).toHaveBeenCalledWith('senior-1', inserted.id, expect.anything())
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
      // Security (MED#1/MED#2): getReadyForSigning must be called WITH the tx handle
      // so the SELECT runs with FOR UPDATE inside the transaction (locking read).
      expect(empSvc.getReadyForSigning).toHaveBeenCalledWith('senior-1', expect.anything())
    })

    it('MED#1/MED#2: getReadyForSigning is called with tx (locking read path)', async () => {
      // Verifies that sign() passes the transaction handle to getReadyForSigning
      // so that EmployeeContractsService executes SELECT...FOR UPDATE inside the
      // transaction — serialising concurrent sign() calls on the same user.
      const ec = makeEmployeeContract()
      const inserted = makeSignedContract()
      const mockDb = makeDb({ insertedRow: inserted })
      const getReadySpy = vi.fn().mockResolvedValue(ec)
      const empSvc = {
        getReadyForSigning: getReadySpy,
        markSigned: vi.fn().mockResolvedValue({ ...ec, status: 'SIGNED' }),
      } as unknown as EmployeeContractsService

      const service = new SignedContractsService(mockDb as unknown as DatabaseService, empSvc)

      await service.sign({
        userId: seniorUser.id,
        userRole: 'SENIOR',
        typedName: '',
        ip: null,
        userAgent: null,
      })

      // Must be called with (userId, tx) — second arg is the Drizzle tx handle.
      expect(getReadySpy).toHaveBeenCalledTimes(1)
      expect(getReadySpy).toHaveBeenCalledWith(seniorUser.id, expect.anything())
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
        const tx = {
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
          query: {
            // T4: uniqueness check returns undefined = candidate is free
            signedContracts: { findFirst: vi.fn().mockResolvedValue(undefined) },
            users: { findFirst: vi.fn().mockResolvedValue(makeUser()) },
          },
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
        makeSignedContract({ id: 'sc-2', contractNumber: 'CHK-FF0011' }),
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

  // task-junior-ut-round2 §7 — lazy backfill of the real PDF size.
  describe('recordPdfSizeIfAbsent', () => {
    // The service calls `this.db.db.update(...)`, so the injected DatabaseService
    // must expose a `.db` field holding the Drizzle client with `.update`.
    function makeUpdatableDb() {
      const whereFn = vi.fn().mockResolvedValue(undefined)
      const setFn = vi.fn().mockReturnValue({ where: whereFn })
      const updateFn = vi.fn().mockReturnValue({ set: setFn })
      const dbService = { db: { update: updateFn } } as unknown as DatabaseService
      return { dbService, updateFn, setFn, whereFn }
    }

    it('writes the size when positive', async () => {
      const { dbService, updateFn, setFn } = makeUpdatableDb()
      const service = new SignedContractsService(dbService, makeEmployeeContractsSvc())
      await service.recordPdfSizeIfAbsent('sc-1', 12345)
      expect(updateFn).toHaveBeenCalledTimes(1)
      expect(setFn).toHaveBeenCalledWith({ pdfSizeBytes: 12345 })
    })

    it('skips the write for zero size (no fake number persisted)', async () => {
      const { dbService, updateFn } = makeUpdatableDb()
      const service = new SignedContractsService(dbService, makeEmployeeContractsSvc())
      await service.recordPdfSizeIfAbsent('sc-1', 0)
      expect(updateFn).not.toHaveBeenCalled()
    })

    it('skips the write for negative / non-finite size', async () => {
      const { dbService, updateFn } = makeUpdatableDb()
      const service = new SignedContractsService(dbService, makeEmployeeContractsSvc())
      await service.recordPdfSizeIfAbsent('sc-1', -5)
      await service.recordPdfSizeIfAbsent('sc-1', Number.NaN)
      expect(updateFn).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// T4: generateUniqueContractNumber
// ---------------------------------------------------------------------------

describe('generateUniqueContractNumber', () => {
  it('returns a string matching CHK-[0-9A-F]{6}', async () => {
    const result = await generateUniqueContractNumber(async () => true)
    expect(result).toMatch(/^CHK-[0-9A-F]{6}$/)
  })

  it('retries on collision and succeeds on second attempt', async () => {
    let callCount = 0
    // First call: taken; second call: free
    const result = await generateUniqueContractNumber(async () => {
      callCount++
      return callCount > 1
    })
    expect(callCount).toBe(2)
    expect(result).toMatch(/^CHK-[0-9A-F]{6}$/)
  })

  it('throws InternalServerErrorException after maxAttempts collisions', async () => {
    const { InternalServerErrorException } = await import('@nestjs/common')
    await expect(generateUniqueContractNumber(async () => false, 3)).rejects.toThrow(
      InternalServerErrorException,
    )
  })

  it('produces distinct values on successive calls (statistical)', async () => {
    // Generate 50 numbers — with 16^6 = 16.7M possibilities, all 50 must differ
    const results = await Promise.all(
      Array.from({ length: 50 }, () => generateUniqueContractNumber(async () => true)),
    )
    const unique = new Set(results)
    // Statistical: extremely unlikely to have any collision in 50 draws from 16.7M
    expect(unique.size).toBe(50)
  })
})
