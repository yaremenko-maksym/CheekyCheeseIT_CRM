import { eq } from 'drizzle-orm'
import * as schema from '../schema'
import { JUNIOR_CONTRACT } from '../seed-templates/contract-junior'
import { HR_CONTRACT } from '../seed-templates/contract-hr'
import { ACCOUNTANT_CONTRACT } from '../seed-templates/contract-accountant'
import { ContractPdfService } from '../../contracts/contract-pdf.service'
import { PdfGenerationService } from '../../common/pdf/pdf-generation.service'
import { CONTRACT_BODY, TOS_BODY } from './contract-bodies'
import {
  MAKSYM_ID,
  OLEKSIY_ID,
  DMYTRO_ID,
  SOFIA_ID,
  ANNA_ID,
  KATERYNA_ID,
  MYKOLA_ID,
  ARTEM_ID,
  NAZAR_ID,
  OKSANA_ID,
  YURIY_ID,
  LENA_ID,
  HR3_ID,
  DROP1_ID,
  DROP2_ID,
  DROP3_ID,
  DROP4_ID,
  DROP5_ID,
  DROP6_ID,
} from './ids'
import { d } from './shared'
import type { SeedCtx } from './shared'

export async function seedOnboarding({ db }: SeedCtx): Promise<void> {
  // ---- 7. Onboarding: ToS + contract templates + signed contracts ----
  console.log('\n[7/8] Inserting onboarding data...')

  // ToS v1
  const tosV1Rows = await db
    .insert(schema.tosVersions)
    .values({
      version: 1,
      bodyMarkdown: TOS_BODY,
      isActive: true,
      createdByUserId: MAKSYM_ID,
    })
    .returning()
  const tosV1 = tosV1Rows[0]!
  console.log('  ✓ ToS v1 (active) inserted')

  // Contract templates — 5 roles (not ADMIN)
  const templateMap: Record<string, string> = {}
  const CONTRACT_CUSTOM_VARIABLES: Partial<
    Record<string, { key: string; label: string; defaultValue: string }[]>
  > = {
    JUNIOR: JUNIOR_CONTRACT.customVariables,
    HR: HR_CONTRACT.customVariables,
    ACCOUNTANT: ACCOUNTANT_CONTRACT.customVariables,
  }

  for (const role of ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const) {
    const tmplRows = await db
      .insert(schema.contractTemplates)
      .values({
        targetRole: role,
        version: 1,
        bodyMarkdown: CONTRACT_BODY[role] ?? '',
        isActive: true,
        createdByUserId: MAKSYM_ID,
        customVariables: CONTRACT_CUSTOM_VARIABLES[role] ?? [],
      })
      .returning()
    const tmpl = tmplRows[0]!
    templateMap[role] = tmpl.id
  }
  console.log('  ✓ 5 contract templates (active) inserted')

  // Onboarded users (all except Dmytro + Ivan who are un-onboarded)
  interface OnboardUser {
    userId: string
    role: 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'
    legalName: string
    signedAt: Date
    contractNum: number
    payRequisite: string
    method: string
  }
  const onboardedUsers: OnboardUser[] = [
    {
      userId: OLEKSIY_ID,
      role: 'SENIOR',
      legalName: 'Коваленко Олексій Сергійович',
      signedAt: d(2025, 6, 5),
      contractNum: 1,
      payRequisite: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
      method: 'USDT ERC-20',
    },
    {
      userId: SOFIA_ID,
      role: 'JUNIOR',
      legalName: 'Бондаренко Софія Олегівна',
      signedAt: d(2025, 6, 5),
      contractNum: 2,
      payRequisite: 'UA213223130000026007233566001 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: ANNA_ID,
      role: 'HR',
      legalName: 'Лисенко Анна Вікторівна',
      signedAt: d(2025, 6, 5),
      contractNum: 3,
      payRequisite: 'UA213223130000026007233566002 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: KATERYNA_ID,
      role: 'HR',
      legalName: 'Шевченко Катерина Олексіївна',
      signedAt: d(2025, 6, 5),
      contractNum: 4,
      payRequisite: 'UA213223130000026007233566003 (monobank)',
      method: 'Bank UAH FOP',
    },
    {
      userId: MYKOLA_ID,
      role: 'ACCOUNTANT',
      legalName: 'Савченко Микола Григорович',
      signedAt: d(2025, 6, 5),
      contractNum: 5,
      payRequisite: 'UA213223130000026007233566004 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: ARTEM_ID,
      role: 'SENIOR',
      legalName: 'Кравченко Артем Миколайович',
      signedAt: d(2025, 8, 15),
      contractNum: 6,
      payRequisite: '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
      method: 'USDT ERC-20',
    },
    {
      userId: OKSANA_ID,
      role: 'JUNIOR',
      legalName: 'Мельник Оксана Павлівна',
      signedAt: d(2025, 8, 20),
      contractNum: 7,
      payRequisite: '0x617F2E2fD72FD9D5503197092AC168961b98769F',
      method: 'USDT ERC-20',
    },
    {
      userId: HR3_ID,
      role: 'HR',
      legalName: 'Ковальчук Дарина Сергіївна',
      signedAt: d(2025, 9, 1),
      contractNum: 8,
      payRequisite: 'UA093052990000026204444020123 (Ощадбанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: NAZAR_ID,
      role: 'SENIOR',
      legalName: 'Пономаренко Назар Іванович',
      signedAt: d(2025, 10, 1),
      contractNum: 9,
      payRequisite: '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB',
      method: 'USDT ERC-20',
    },
    {
      userId: YURIY_ID,
      role: 'JUNIOR',
      legalName: 'Ткаченко Юрій Анатолійович',
      signedAt: d(2025, 10, 5),
      contractNum: 10,
      payRequisite: 'UA443052990000026206555020567 (monobank)',
      method: 'Bank UAH FOP',
    },
    {
      userId: LENA_ID,
      role: 'JUNIOR',
      legalName: 'Гриценко Олена Михайлівна',
      signedAt: d(2025, 12, 10),
      contractNum: 11,
      payRequisite: 'UA233220010000026201300038581 (ПУМБ)',
      method: 'Bank UAH FOP',
    },
    {
      userId: DROP1_ID,
      role: 'DROP',
      legalName: 'Дрожжин Віктор Олегович',
      signedAt: d(2025, 7, 1),
      contractNum: 12,
      payRequisite: '0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec',
      method: 'USDT ERC-20',
    },
    {
      userId: DROP2_ID,
      role: 'DROP',
      legalName: 'Дроздова Олена Борисівна',
      signedAt: d(2025, 7, 15),
      contractNum: 13,
      payRequisite: 'UA153052990000026201111020999 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: DROP3_ID,
      role: 'DROP',
      legalName: 'Дроботенко Роман Петрович',
      signedAt: d(2025, 8, 1),
      contractNum: 14,
      payRequisite: '0xdD870fA1b7C4700F2BD7f44238821C26f7392148',
      method: 'USDT ERC-20',
    },
    {
      userId: DROP4_ID,
      role: 'DROP',
      legalName: 'Дрозд Марта Іванівна',
      signedAt: d(2025, 9, 15),
      contractNum: 15,
      payRequisite: '0x583031D1113aD414F02576BD6afaBfb302140225',
      method: 'USDT ERC-20',
    },
    {
      userId: DROP5_ID,
      role: 'DROP',
      legalName: 'Дрофа Сергій Васильович',
      signedAt: d(2025, 10, 20),
      contractNum: 16,
      payRequisite: 'UA253052990000026208888020456 (monobank)',
      method: 'Bank UAH FOP',
    },
    {
      userId: DROP6_ID,
      role: 'DROP',
      legalName: 'Дробиш Тамара Григорівна',
      signedAt: d(2025, 11, 1),
      contractNum: 17,
      payRequisite: '0x4B0897b0513fdC7C541B6d9D7E929C4e5364D2dB',
      method: 'USDT ERC-20',
    },
  ]

  // Map userId → signed_contract.id for employee_contracts backfill (AC9)
  const signedContractIdByUser: Record<string, string> = {}

  // Instantiate once for real PDF size calculation (no DI deps needed)
  const contractPdf = new ContractPdfService(new PdfGenerationService())

  for (const u of onboardedUsers) {
    const tmplId = templateMap[u.role]
    if (!tmplId) continue
    const requisiteValue = u.payRequisite || 'не указано'
    const snapshot = (CONTRACT_BODY[u.role] ?? '')
      .replace(/\{\{employeeName\}\}/g, u.legalName)
      .replace(/\{\{onboardingDate\}\}/g, u.signedAt.toISOString().slice(0, 10))
      .replace(/\{\{preferredMethod\}\}/g, u.method)
      .replace(/\{\{requisites\}\}/g, requisiteValue)
      // Legacy fallback: templates that still contain old placeholders
      .replace(/\{\{walletUsdt\}\}/g, u.method === 'USDT ERC-20' ? u.payRequisite : '')
      .replace(/\{\{bankUahFop\}\}/g, u.method === 'Bank UAH FOP' ? u.payRequisite : '')

    const [sc] = await db
      .insert(schema.signedContracts)
      .values({
        userId: u.userId,
        templateId: tmplId,
        bodyMarkdownSnapshot: snapshot,
        variablesFilled: {
          employeeName: u.legalName,
          onboardingDate: u.signedAt.toISOString().slice(0, 10),
          preferredMethod: u.method,
          requisites: requisiteValue,
          walletUsdt: u.method === 'USDT ERC-20' ? u.payRequisite : '',
          bankUahFop: u.method === 'Bank UAH FOP' ? u.payRequisite : '',
        },
        signedTypedName: u.legalName,
        signedIp: '127.0.0.1',
        signedAt: u.signedAt,
        contractNumber: `CHK-${u.contractNum}-2025`,
      })
      .returning()
    if (sc) {
      signedContractIdByUser[u.userId] = sc.id

      // Generate real PDF to record actual file size (not a fake formula)
      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
      const { pdfBuffer } = await contractPdf.generateContractPdf({
        contractNumber: `CHK-${u.contractNum}-2025`,
        bodyMarkdown: snapshot,
        signedTypedName: u.legalName,
        signedAt: u.signedAt,
        verifyUrl: `${frontendUrl}/contract/v/${sc.id}`,
      })
      await db
        .update(schema.signedContracts)
        .set({ pdfSizeBytes: pdfBuffer.length })
        .where(eq(schema.signedContracts.id, sc.id))
      console.log(`    pdf size for CHK-${u.contractNum}-2025: ${pdfBuffer.length} bytes`)
    }

    // ToS acceptance for onboarded users
    await db.insert(schema.tosAcceptances).values({
      userId: u.userId,
      tosVersionId: tosV1.id,
      acceptedAt: u.signedAt,
      acceptedIp: '127.0.0.1',
    })
  }
  console.log(`  ✓ ${onboardedUsers.length} signed contracts + ToS acceptances inserted`)

  // AC9 — employee_contracts backfill (A3-1):
  //   • SIGNED for every onboarded user (linked to their signed_contract)
  //   • READY_TO_SIGN for Dmytro (awaiting signing — wizard test scenario)
  //   • No record for Ivan (completely un-onboarded — blocked fallback scenario)
  for (const u of onboardedUsers) {
    const tmplId = templateMap[u.role]
    const scId = signedContractIdByUser[u.userId]
    if (!tmplId || !scId) continue
    const requisiteValueEc = u.payRequisite || 'не указано'
    const snapshot = (CONTRACT_BODY[u.role] ?? '')
      .replace(/\{\{employeeName\}\}/g, u.legalName)
      .replace(/\{\{onboardingDate\}\}/g, u.signedAt.toISOString().slice(0, 10))
      .replace(/\{\{preferredMethod\}\}/g, u.method)
      .replace(/\{\{requisites\}\}/g, requisiteValueEc)
      // Legacy fallback: templates that still contain old placeholders
      .replace(/\{\{walletUsdt\}\}/g, u.method === 'USDT ERC-20' ? u.payRequisite : '')
      .replace(/\{\{bankUahFop\}\}/g, u.method === 'Bank UAH FOP' ? u.payRequisite : '')

    await db.insert(schema.employeeContracts).values({
      userId: u.userId,
      sourceTemplateId: tmplId,
      bodyMarkdown: snapshot,
      status: 'SIGNED',
      signedContractId: scId,
      createdByUserId: MAKSYM_ID,
      createdAt: u.signedAt,
      updatedAt: u.signedAt,
    })
  }

  // Dmytro: READY_TO_SIGN — contract prepared by ADMIN, awaiting user signing
  const dmytroTmplId = templateMap['SENIOR']
  if (dmytroTmplId) {
    const dmytroSnapshot = (CONTRACT_BODY['SENIOR'] ?? '')
      .replace(/\{\{employeeName\}\}/g, 'Марченко Дмитро Олексійович')
      .replace(/\{\{onboardingDate\}\}/g, d(2025, 7, 1).toISOString().slice(0, 10))
      .replace(/\{\{preferredMethod\}\}/g, 'не вказано')
      .replace(/\{\{requisites\}\}/g, 'не указано')
      // Legacy fallback: templates that still contain old placeholders
      .replace(/\{\{walletUsdt\}\}/g, '')
      .replace(/\{\{bankUahFop\}\}/g, '')

    await db.insert(schema.employeeContracts).values({
      userId: DMYTRO_ID,
      sourceTemplateId: dmytroTmplId,
      bodyMarkdown: dmytroSnapshot,
      status: 'READY_TO_SIGN',
      signedContractId: null,
      createdByUserId: MAKSYM_ID,
      createdAt: d(2025, 7, 1),
      updatedAt: d(2025, 7, 1),
    })
  }
  // Ivan: no employee_contract at all (completely blocked — frontend fallback scenario)

  console.log(
    `  ✓ ${onboardedUsers.length} employee_contracts (SIGNED) + 1 READY_TO_SIGN (Dmytro) inserted`,
  )
  console.log('  ✓ dmytro.marchenko — READY_TO_SIGN (wizard test); ivan.petrenko — no contract')
}
