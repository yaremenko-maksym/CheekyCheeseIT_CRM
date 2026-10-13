import * as schema from '../schema'
import {
  MAKSYM_ID,
  OLEKSIY_ID,
  SOFIA_ID,
  YURIY_ID,
  LENA_ID,
  MYKOLA_ID,
  ARTEM_ID,
  NAZAR_ID,
} from './ids'
import { d } from './shared'
import type { SeedCtxWithProjects } from './shared'

export async function seedFinance({ db, projects }: SeedCtxWithProjects): Promise<void> {
  const { proj1Id, proj2Id, proj4Id, proj6Id } = projects

  // ---- 6. Finance — transactions, exchange_rate ----
  console.log('\n[6/8] Inserting finance data...')

  // NBU exchange rates — monthly for 12 months
  interface ExchangeRateRow {
    currency: 'USD' | 'EUR'
    rateToUah: string
    rateDate: Date
    source: string
  }
  const exchangeRates: ExchangeRateRow[] = [
    { currency: 'USD', rateToUah: '41.20', rateDate: d(2025, 6, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '44.80', rateDate: d(2025, 6, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.35', rateDate: d(2025, 7, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.10', rateDate: d(2025, 7, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.50', rateDate: d(2025, 8, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.30', rateDate: d(2025, 8, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.65', rateDate: d(2025, 9, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.55', rateDate: d(2025, 9, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.80', rateDate: d(2025, 10, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.70', rateDate: d(2025, 10, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.00', rateDate: d(2025, 11, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.90', rateDate: d(2025, 11, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.20', rateDate: d(2025, 12, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.10', rateDate: d(2025, 12, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.50', rateDate: d(2026, 1, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.40', rateDate: d(2026, 1, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.70', rateDate: d(2026, 2, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.60', rateDate: d(2026, 2, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.90', rateDate: d(2026, 3, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.80', rateDate: d(2026, 3, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '43.10', rateDate: d(2026, 4, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '47.00', rateDate: d(2026, 4, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '43.30', rateDate: d(2026, 5, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '47.20', rateDate: d(2026, 5, 1), source: 'NBU' },
  ]
  // exchange_rate table check
  const hasCurrencyCol = await db.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_name='exchange_rate' AND column_name='currency' LIMIT 1" as unknown as Parameters<
      typeof db.execute
    >[0],
  )
  if (hasCurrencyCol.rows.length > 0) {
    for (const rate of exchangeRates) {
      await db.execute(
        `INSERT INTO exchange_rate (currency, rate_to_uah, rate_date, source) VALUES ('${rate.currency}', ${rate.rateToUah}, '${rate.rateDate.toISOString()}', '${rate.source}') ON CONFLICT DO NOTHING` as unknown as Parameters<
          typeof db.execute
        >[0],
      )
    }
    console.log('  ✓ 24 exchange rates inserted')
  } else {
    console.log('  ~ exchange_rate table not in expected shape, skipping rates')
  }

  // SENIOR_INCOME transactions — Oleksiy on proj1 (Jun–Nov 2025, PAID)
  interface TxInput {
    type: schema.NewTransaction['type']
    status: schema.NewTransaction['status']
    amount: string
    currency: schema.NewTransaction['currency']
    senderId?: string
    senderLabel?: string
    receiverId?: string
    receiverLabel?: string
    projectId?: string
    seniorSharePercent?: number
    seniorSharePercentSource?: string
    validatedBy?: string
    validatedAt?: Date
    txDate: Date
    createdBy: string
    createdAt: Date
    notes?: string
    salaryMonth?: string
  }
  const txRows: TxInput[] = []

  // Oleksiy — proj1 (PAID old transactions Jun–Oct 2025)
  for (let m = 6; m <= 10; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '5000.000000',
      currency: 'USDT',
      senderLabel: 'TechCorp AI',
      receiverId: OLEKSIY_ID,
      projectId: proj1Id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2025, m, 10),
      txDate: d(2025, m, 5),
      createdBy: OLEKSIY_ID,
      createdAt: d(2025, m, 5),
    })
  }
  // Nov 2025 proj1 — VALIDATED (project closed, payout pending)
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '5000.000000',
    currency: 'USDT',
    senderLabel: 'TechCorp AI',
    receiverId: OLEKSIY_ID,
    projectId: proj1Id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    validatedBy: MYKOLA_ID,
    validatedAt: d(2025, 11, 10),
    txDate: d(2025, 11, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2025, 11, 5),
  })

  // Oleksiy — proj2 LearnSpace (Jan–May 2026, mix statuses)
  for (let m = 1; m <= 3; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '4500.000000',
      currency: 'USD',
      senderLabel: 'LearnSpace Inc',
      receiverId: OLEKSIY_ID,
      projectId: proj2Id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2026, m, 8),
      txDate: d(2026, m, 5),
      createdBy: OLEKSIY_ID,
      createdAt: d(2026, m, 5),
    })
  }
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '4500.000000',
    currency: 'USD',
    senderLabel: 'LearnSpace Inc',
    receiverId: OLEKSIY_ID,
    projectId: proj2Id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    validatedBy: MYKOLA_ID,
    validatedAt: d(2026, 4, 8),
    txDate: d(2026, 4, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2026, 4, 5),
  })
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '4500.000000',
    currency: 'USD',
    senderLabel: 'LearnSpace Inc',
    receiverId: OLEKSIY_ID,
    projectId: proj2Id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    txDate: d(2026, 5, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2026, 5, 5),
  })

  // Artem — proj4 OnePunch (Sep 2025–Apr 2026)
  for (let m = 9; m <= 12; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '4000.000000',
      currency: 'USD',
      senderLabel: 'One Punch',
      receiverId: ARTEM_ID,
      projectId: proj4Id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2025, m, 12),
      txDate: d(2025, m, 8),
      createdBy: ARTEM_ID,
      createdAt: d(2025, m, 8),
    })
  }
  for (let m = 1; m <= 3; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '4000.000000',
      currency: 'USD',
      senderLabel: 'One Punch',
      receiverId: ARTEM_ID,
      projectId: proj4Id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2026, m, 12),
      txDate: d(2026, m, 8),
      createdBy: ARTEM_ID,
      createdAt: d(2026, m, 8),
    })
  }
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '4000.000000',
    currency: 'USD',
    senderLabel: 'One Punch',
    receiverId: ARTEM_ID,
    projectId: proj4Id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    txDate: d(2026, 4, 8),
    createdBy: ARTEM_ID,
    createdAt: d(2026, 4, 8),
  })

  // Nazar — proj6 CloudOps (Oct 2025–Apr 2026)
  for (let m = 10; m <= 12; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '5500.000000',
      currency: 'USDT',
      senderLabel: 'CloudOps UA',
      receiverId: NAZAR_ID,
      projectId: proj6Id,
      seniorSharePercent: 30,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2025, m, 15),
      txDate: d(2025, m, 10),
      createdBy: NAZAR_ID,
      createdAt: d(2025, m, 10),
    })
  }
  for (let m = 1; m <= 2; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'VALIDATED',
      amount: '5500.000000',
      currency: 'USDT',
      senderLabel: 'CloudOps UA',
      receiverId: NAZAR_ID,
      projectId: proj6Id,
      seniorSharePercent: 30,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2026, m, 15),
      txDate: d(2026, m, 10),
      createdBy: NAZAR_ID,
      createdAt: d(2026, m, 10),
    })
  }
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '5500.000000',
    currency: 'USDT',
    senderLabel: 'CloudOps UA',
    receiverId: NAZAR_ID,
    projectId: proj6Id,
    seniorSharePercent: 30,
    seniorSharePercentSource: 'USER_DEFAULT',
    txDate: d(2026, 3, 10),
    createdBy: NAZAR_ID,
    createdAt: d(2026, 3, 10),
  })

  // One REJECTED transaction — Oleksiy (typo in amount)
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'REJECTED',
    amount: '50000.000000',
    currency: 'USDT',
    senderLabel: 'TechCorp AI',
    receiverId: OLEKSIY_ID,
    projectId: proj1Id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    validatedBy: MYKOLA_ID,
    validatedAt: d(2025, 8, 12),
    txDate: d(2025, 8, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2025, 8, 5),
    notes: 'Помилка в сумі — відхилено',
  })

  // Company expenses — several months
  const expenseRows: TxInput[] = [
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '300.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 7, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 7, 1),
      notes: 'AWS EC2 + RDS — Jul 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '300.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 8, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 8, 1),
      notes: 'AWS EC2 + RDS — Aug 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '120.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'GitHub Team',
      txDate: d(2025, 9, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 9, 1),
      notes: 'GitHub Team plan — Q3',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '350.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 10, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 10, 1),
      notes: 'AWS EC2 + RDS — Oct 2025 (збільшений трафік)',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '89.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'Figma Business',
      txDate: d(2025, 11, 15),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 11, 15),
      notes: 'Figma Business — Nov 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '350.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 12, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 12, 1),
      notes: 'AWS EC2 + RDS — Dec 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PENDING',
      amount: '350.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2026, 5, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2026, 5, 1),
      notes: 'AWS EC2 + RDS — May 2026',
    },
  ]

  // Junior salary transactions
  const juniorSalaryRows: TxInput[] = [
    // Sofia — Jun–Nov 2025 (proj1 period) PAID
    ...([6, 7, 8, 9, 10, 11] as const).map((m) => ({
      type: 'SALARY' as const,
      status: 'PAID' as const,
      amount: '500.000000',
      currency: 'USD' as const,
      receiverId: SOFIA_ID,
      receiverLabel: 'Sofia Bondarenko',
      senderLabel: 'Cheeky Cheese IT',
      projectId: proj1Id,
      salaryMonth: `2025-${String(m).padStart(2, '0')}`,
      txDate: d(2025, m, 28),
      createdBy: MYKOLA_ID,
      createdAt: d(2025, m, 28),
    })),
    // Sofia — Jan–Apr 2026 (proj2) PAID
    ...([1, 2, 3] as const).map((m) => ({
      type: 'SALARY' as const,
      status: 'PAID' as const,
      amount: '500.000000',
      currency: 'USD' as const,
      receiverId: SOFIA_ID,
      receiverLabel: 'Sofia Bondarenko',
      senderLabel: 'Cheeky Cheese IT',
      projectId: proj2Id,
      salaryMonth: `2026-${String(m).padStart(2, '0')}`,
      txDate: d(2026, m, 28),
      createdBy: MYKOLA_ID,
      createdAt: d(2026, m, 28),
    })),
    {
      type: 'SALARY' as const,
      status: 'PENDING' as const,
      amount: '500.000000',
      currency: 'USD' as const,
      receiverId: SOFIA_ID,
      receiverLabel: 'Sofia Bondarenko',
      senderLabel: 'Cheeky Cheese IT',
      projectId: proj2Id,
      salaryMonth: '2026-04',
      txDate: d(2026, 4, 28),
      createdBy: MYKOLA_ID,
      createdAt: d(2026, 4, 28),
    },
  ]

  await db
    .insert(schema.transactions)
    .values([...txRows, ...expenseRows, ...juniorSalaryRows] as schema.NewTransaction[])
  console.log(
    `  ✓ ${txRows.length + expenseRows.length + juniorSalaryRows.length} transactions inserted`,
  )

  // ---- 6b. User audit log — salary change events for juniors ----
  // getSalaryMeta (users.service.ts) reads changedAt = createdAt of the latest
  // user_audit_log row where jsonb_exists(changes, 'monthlySalary').
  // Without these rows changedAt is null and the "Изменена <дата>" UI element
  // is never visible in UT.
  const salaryAuditRows: schema.NewUserAuditLogEntry[] = [
    // Sofia — initial salary set when onboarded to proj1 (Sep 2025)
    {
      actorId: MAKSYM_ID,
      targetId: SOFIA_ID,
      action: 'UPDATE_SALARY',
      changes: { monthlySalary: '[REDACTED]' },
      createdAt: d(2025, 9, 1),
    },
    // Sofia — salary updated for proj2 (Feb 2026)
    {
      actorId: MAKSYM_ID,
      targetId: SOFIA_ID,
      action: 'UPDATE_SALARY',
      changes: { monthlySalary: '[REDACTED]' },
      createdAt: d(2026, 2, 10),
    },
    // Yuriy — salary set when onboarded (Oct 2025)
    {
      actorId: MAKSYM_ID,
      targetId: YURIY_ID,
      action: 'UPDATE_SALARY',
      changes: { monthlySalary: '[REDACTED]' },
      createdAt: d(2025, 10, 5),
    },
    // Lena — salary set when onboarded (Jan 2026)
    {
      actorId: MAKSYM_ID,
      targetId: LENA_ID,
      action: 'UPDATE_SALARY',
      changes: { monthlySalary: '[REDACTED]' },
      createdAt: d(2026, 1, 15),
    },
  ]
  await db.insert(schema.userAuditLog).values(salaryAuditRows)
  console.log(`  ✓ ${salaryAuditRows.length} user_audit_log salary-change rows inserted`)

  // ---- Company Account (USDT) — task-company-account-backend ----
  // Single-row config. walletAddress starts NULL — an ADMIN configures the
  // shared company wallet in settings (changing it triggers an audit entry).
  // Threshold defaults to 12 confirmations.
  await db
    .insert(schema.companyAccount)
    .values({ walletAddress: null, confirmationThreshold: 12, updatedBy: MAKSYM_ID })
  console.log('  ✓ 1 company_account row inserted (wallet unset, threshold 12)')
}
