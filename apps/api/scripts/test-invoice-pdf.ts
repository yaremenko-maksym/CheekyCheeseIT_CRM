/**
 * Manual smoke test for InvoicePdfService.
 *
 * Generates two sample PDFs under /tmp/ so a human can:
 *   - confirm Cyrillic glyphs render correctly (no boxes / tofu)
 *   - scan the QR with a phone camera and verify the URL roundtrips
 *   - check the layout doesn't overflow / overlap
 *
 * Usage:
 *   pnpm --filter @crm/api exec tsx scripts/test-invoice-pdf.ts
 *
 * Output:
 *   /tmp/test-invoice-pending.pdf   — auto-COMPANY only, awaits counterparty
 *   /tmp/test-invoice-signed.pdf    — both signatures in place
 */
import { writeFileSync } from 'fs'
import { InvoicePdfService } from '../src/invoices/invoice-pdf.service'

async function main(): Promise<void> {
  const service = new InvoicePdfService()

  const txDate = new Date('2026-05-26T14:00:00.000Z')

  // ----- 1. Pending (auto-COMPANY only) -----
  const pending = await service.generateSignableInvoicePdf({
    transaction: {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      type: 'SENIOR_INCOME',
      amount: '1234.567890',
      currency: 'USDT',
      projectName: 'Acme Corp',
      salaryMonth: '2026-05',
      txDate,
    },
    company: {
      name: 'CheekyCheese IT',
      address: 'г. Киев, ул. Хрещатик, 22, оф. 5',
    },
    counterparty: {
      displayName: 'Иван Петрович Иванов',
      paymentMethod: 'USDT_ERC20',
      paymentDetails: [
        'Адрес: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb6',
        'Метка: Основной кошелёк ERC-20',
      ],
    },
    signatures: [
      {
        role: 'COMPANY',
        signerName: 'Максим Яременко',
        signedAt: new Date('2026-05-26T14:00:00.000Z'),
        method: 'AUTO_COMPANY',
      },
    ],
    verifyUrl: 'https://crm.cheekycheese.it/invoice/v/aaaaaaaa',
    uahEquivalent: {
      formatted: '51 234.50',
      rateDate: '26.05.2026',
    },
  })

  writeFileSync('/tmp/test-invoice-pending.pdf', pending.pdfBuffer)
  console.log(
    `[pending]  /tmp/test-invoice-pending.pdf  size=${pending.pdfBuffer.length}B  hash=${pending.sha256Hash}`,
  )

  // ----- 2. Signed (both parties) -----
  const signed = await service.generateSignableInvoicePdf({
    transaction: {
      id: '11111111-2222-3333-4444-555566667777',
      type: 'SALARY',
      amount: '850.00',
      currency: 'USD',
      projectName: null,
      salaryMonth: '2026-05',
      txDate,
    },
    company: {
      name: 'CheekyCheese IT',
      address: 'г. Киев, ул. Хрещатик, 22, оф. 5',
    },
    counterparty: {
      displayName: 'Олена Кузьменко',
      paymentMethod: 'BANK_UAH_FOP',
      paymentDetails: [
        'Получатель: ФОП Кузьменко О.В.',
        'IBAN: UA213223130000026007000000123',
        'РНОКПП: 1234567890',
        'Банк: ПриватБанк',
      ],
    },
    signatures: [
      {
        role: 'COMPANY',
        signerName: 'Максим Яременко',
        signedAt: new Date('2026-05-26T14:00:00.000Z'),
        method: 'AUTO_COMPANY',
      },
      {
        role: 'COUNTERPARTY',
        signerName: 'Олена Кузьменко',
        signedAt: new Date('2026-05-26T15:30:00.000Z'),
        method: 'MANUAL_CLICK',
        pdfHashFull: 'a1b2c3d4' + '0'.repeat(56),
        ipLastOctet: '42',
      },
    ],
    verifyUrl: 'https://crm.cheekycheese.it/invoice/v/11111111',
    uahEquivalent: {
      formatted: '35 275.00',
      rateDate: '26.05.2026',
    },
  })

  writeFileSync('/tmp/test-invoice-signed.pdf', signed.pdfBuffer)
  console.log(
    `[signed]   /tmp/test-invoice-signed.pdf   size=${signed.pdfBuffer.length}B  hash=${signed.sha256Hash}`,
  )

  console.log('\nDone. Open the PDFs to verify cyrillic + QR.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
