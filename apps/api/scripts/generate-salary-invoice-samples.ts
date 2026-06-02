/**
 * Generate 3 visual sample salary-invoices for different payment methods.
 *
 * Demo task: shows how a SALARY-type invoice looks when paid via:
 *   1. BANK_FOP   — Ukrainian sole proprietor (UAH bank account, IBAN + ЄДРПОУ)
 *   2. CRYPTO     — USDT ERC-20 wallet address
 *   3. CASH       — no requisites, marked "Наличка"
 *
 * Usage:
 *   pnpm --filter @crm/api exec tsx scripts/generate-salary-invoice-samples.ts
 *
 * Output:
 *   /tmp/salary-invoice-fop.pdf
 *   /tmp/salary-invoice-crypto.pdf
 *   /tmp/salary-invoice-cash.pdf
 *
 * These are fixed-data invoices (employee «Иван Петренко», salary month
 * `2026-05`). They are NOT inserted in the DB and do NOT touch the signing
 * flow — purely PDF rendering smoke samples for stakeholder review.
 */
import { writeFileSync } from 'fs'

import {
  InvoicePdfService,
  type GenerateSignableInvoiceParams,
} from '../src/invoices/invoice-pdf.service'

const FIXED_TX_DATE = new Date('2026-05-26T14:00:00.000Z')
const FIXED_COMPANY_SIGN = new Date('2026-05-26T14:00:00.000Z')
const FIXED_COUNTERPARTY_SIGN = new Date('2026-05-26T15:30:00.000Z')

// Stable employee identity for all three samples — only the payment method
// changes, making it easy to diff the three PDFs side-by-side.
const EMPLOYEE_NAME = 'Иван Петренко'
const COMPANY_ADDRESS = 'г. Киев, ул. Хрещатик, 22, оф. 5'
const SALARY_MONTH = '2026-05'

interface SampleSpec {
  filename: string
  txId: string
  amount: string
  currency: 'USDT' | 'UAH'
  counterparty: GenerateSignableInvoiceParams['counterparty']
  uahEquivalent: GenerateSignableInvoiceParams['uahEquivalent']
}

const samples: SampleSpec[] = [
  // 1. ФОП — UAH salary, bank account requisites
  {
    filename: '/tmp/salary-invoice-fop.pdf',
    txId: '11111111-aaaa-bbbb-cccc-111111111111',
    amount: '50000.00',
    currency: 'UAH',
    counterparty: {
      displayName: EMPLOYEE_NAME,
      paymentMethod: 'BANK_UAH_FOP',
      paymentDetails: [
        'IBAN: UA12 3052 9900 0002 6007 1234 5678 9',
        'Банк: ПриватБанк',
        'ЄДРПОУ ФОП: 1234567890',
        'Призначення: Оплата послуг ФОП за договором № 42-С/2026',
      ],
    },
    uahEquivalent: null, // currency = UAH → no equivalent line
  },
  // 2. Crypto — USDT ERC-20 wallet
  {
    filename: '/tmp/salary-invoice-crypto.pdf',
    txId: '22222222-aaaa-bbbb-cccc-222222222222',
    amount: '2500.00',
    currency: 'USDT',
    counterparty: {
      displayName: EMPLOYEE_NAME,
      paymentMethod: 'USDT_ERC20',
      paymentDetails: [
        'Адрес: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb6',
        'Сеть: Ethereum mainnet (ERC-20)',
        'Метка: Основной кошелёк сотрудника',
      ],
    },
    uahEquivalent: {
      formatted: '102 875.00',
      rateDate: '26.05.2026',
    },
  },
  // 3. Cash — no requisites, just method
  {
    filename: '/tmp/salary-invoice-cash.pdf',
    txId: '33333333-aaaa-bbbb-cccc-333333333333',
    amount: '35000.00',
    currency: 'UAH',
    counterparty: {
      displayName: EMPLOYEE_NAME,
      paymentMethod: 'CASH',
      paymentDetails: [],
    },
    uahEquivalent: null,
  },
]

async function main(): Promise<void> {
  const service = new InvoicePdfService()

  for (const spec of samples) {
    const params: GenerateSignableInvoiceParams = {
      transaction: {
        id: spec.txId,
        type: 'SALARY',
        amount: spec.amount,
        currency: spec.currency,
        projectName: null, // SALARY has no project
        salaryMonth: SALARY_MONTH,
        txDate: FIXED_TX_DATE,
      },
      company: {
        name: 'CheekyCheeseIT',
        address: COMPANY_ADDRESS,
      },
      counterparty: spec.counterparty,
      signatures: [
        {
          role: 'COMPANY',
          signerName: 'CheekyCheeseIT (auto)',
          signedAt: FIXED_COMPANY_SIGN,
          method: 'AUTO_COMPANY',
        },
        {
          role: 'COUNTERPARTY',
          signerName: EMPLOYEE_NAME,
          signedAt: FIXED_COUNTERPARTY_SIGN,
          method: 'MANUAL_CLICK',
          // Deterministic placeholder hash — real flow gets it from the
          // company-only PDF SHA-256 on first pass.
          pdfHashFull: 'd' + spec.txId.replace(/-/g, '').padEnd(63, '0').slice(0, 63),
          ipLastOctet: '17',
        },
      ],
      verifyUrl: `https://crm.cheekycheese.it/invoice/v/${spec.txId.slice(0, 8)}`,
      uahEquivalent: spec.uahEquivalent,
    }

    const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)
    writeFileSync(spec.filename, pdfBuffer)
    // eslint-disable-next-line no-console
    console.log(
      `Wrote ${spec.filename} (${pdfBuffer.length}B, sha256=${sha256Hash.slice(0, 12)}…) ` +
        `method=${spec.counterparty.paymentMethod ?? 'null'}`,
    )
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
