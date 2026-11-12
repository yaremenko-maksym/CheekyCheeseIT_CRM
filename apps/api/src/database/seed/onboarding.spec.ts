import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../schema'
import { HR0_ID, HR2_ID, SENIOR_SHARED_ID } from './ids'
import { seedOnboarding } from './onboarding'
import { d, type SeedDb } from './shared'

// The real PDF renderer is irrelevant to which rows are written; a fixed buffer stands in.
vi.mock('../../contracts/contract-pdf.service', () => ({
  ContractPdfService: class {
    generateContractPdf(): Promise<{ pdfBuffer: Buffer }> {
      return Promise.resolve({ pdfBuffer: Buffer.from('pdf') })
    }
  },
}))
vi.mock('../../common/pdf/pdf-generation.service', () => ({ PdfGenerationService: class {} }))

/**
 * Task 7.6a — the job-queue E2E users are onboarded (a signed contract of their role's template,
 * and a ToS acceptance), otherwise the queue answers them 403 ONBOARDING_REQUIRED.
 */
const recordInserts = () => {
  const inserts: { table: unknown; values: Record<string, unknown>; id: string }[] = []
  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const id = `row-${inserts.length + 1}`
        inserts.push({ table, values, id })
        const rows = [{ id }]
        return Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) })
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as unknown as SeedDb
  return { db, inserts }
}

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => undefined))
afterEach(() => vi.restoreAllMocks())

describe('seedOnboarding — the job-queue E2E users', () => {
  it.each([
    [
      HR2_ID,
      'HR',
      'Бондар Ірина Петрівна',
      18,
      'UA213223130000026007233566005 (monobank)',
      'Bank UAH FOP',
    ],
    [
      HR0_ID,
      'HR',
      'Мороз Юлія Андріївна',
      19,
      'UA213223130000026007233566006 (ПриватБанк)',
      'Bank UAH FOP',
    ],
    [
      SENIOR_SHARED_ID,
      'SENIOR',
      'Савчук Тарас Миколайович',
      20,
      '0x1aE0EA34a72D944a8C7603FfB3eC30a6669E454C',
      'USDT ERC-20',
    ],
  ])(
    'signs %s a %s contract and accepts the ToS',
    async (userId, role, name, num, requisites, method) => {
      const { db, inserts } = recordInserts()
      await seedOnboarding({ db })
      const templateId = inserts.find(
        (i) => i.table === schema.contractTemplates && i.values['targetRole'] === role,
      )!.id
      const tosVersionId = inserts.find((i) => i.table === schema.tosVersions)!.id
      const signed = inserts.filter(
        (i) => i.table === schema.signedContracts && i.values['userId'] === userId,
      )
      expect(signed.map((i) => i.values)).toEqual([
        expect.objectContaining({
          templateId,
          signedTypedName: name,
          signedAt: d(2025, 11, 15),
          contractNumber: `CHK-${num}-2025`,
          variablesFilled: expect.objectContaining({
            employeeName: name,
            preferredMethod: method,
            requisites,
          }) as unknown,
        }),
      ])
      const tos = inserts.filter(
        (i) => i.table === schema.tosAcceptances && i.values['userId'] === userId,
      )
      expect(tos.map((i) => i.values['tosVersionId'])).toEqual([tosVersionId])
    },
  )
})
