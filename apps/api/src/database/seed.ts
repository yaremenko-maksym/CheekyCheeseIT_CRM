import 'dotenv/config'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import * as schema from './schema'

export const MAKSYM_ID = '00000000-0000-0000-0000-000000000001'
export const KOSTYA_ID = '00000000-0000-0000-0000-000000000002'

const SEED_USERS: schema.NewUser[] = [
  {
    id: MAKSYM_ID,
    email: 'yaremenkomaksym99@gmail.com',
    displayName: 'Maksym Yaremenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=maksym',
    role: 'ADMIN',
    telegram: '@maksym_yaremenko',
    phone: '+380671000001',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x1111111111111111111111111111111111111111',
    techStack: ['React', 'TypeScript', 'Node.js', 'NestJS', 'PostgreSQL'],
  },
  {
    id: KOSTYA_ID,
    email: 'kostya@cheekycheeseit.com',
    displayName: 'Kostya',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=kostya',
    role: 'ADMIN',
    telegram: '@kostya_partner',
    phone: '+380671000002',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x2222222222222222222222222222222222222222',
    techStack: ['Vue.js', 'Python', 'Django', 'AWS'],
  },
  {
    email: 'oleksiy.kovalenko@cheekycheese.dev',
    displayName: 'Oleksiy Kovalenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=oleksiy',
    role: 'SENIOR',
    telegram: '@oleksiy_koval',
    phone: '+380671000003',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x3333333333333333333333333333333333333333',
    techStack: ['React', 'TypeScript', 'Node.js', 'Python', 'AWS'],
  },
  {
    email: 'dmytro.marchenko@cheekycheese.dev',
    displayName: 'Dmytro Marchenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=dmytro',
    role: 'SENIOR',
    telegram: '@dmytro_march',
    phone: '+380671000004',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x4444444444444444444444444444444444444444',
    techStack: ['Vue.js', 'TypeScript', 'Python', 'PostgreSQL'],
  },
  {
    email: 'sofia.bondarenko@cheekycheese.dev',
    displayName: 'Sofia Bondarenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=sofia',
    role: 'JUNIOR',
    telegram: '@sofia_bond',
    phone: '+380671000005',
    monthlySalary: '500.00',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Sofia Bondarenko',
    bankUahIban: 'UA213223130000026007233566001',
    bankUahRnokpp: '3456789012',
    bankUahBankName: 'ПриватБанк',
    techStack: ['React', 'Tailwind', 'TypeScript'],
  },
  {
    email: 'ivan.petrenko@cheekycheese.dev',
    displayName: 'Ivan Petrenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=ivan',
    role: 'JUNIOR',
    telegram: '@ivan_pet',
    phone: '+380671000006',
    monthlySalary: '600.00',
    // No payment method set — salary will be LOCKED until requisites are filled
    techStack: ['React', 'JavaScript', 'CSS'],
  },
  {
    email: 'anna.lysenko@cheekycheese.dev',
    displayName: 'Anna Lysenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=anna',
    role: 'HR',
    telegram: '@anna_lysenko',
    phone: '+380671000007',
    monthlySalary: '800.00',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Anna Lysenko',
    bankUahIban: 'UA213223130000026007233566002',
    bankUahRnokpp: '2345678901',
    bankUahBankName: 'ПриватБанк',
  },
  {
    email: 'kateryna.shevchenko@cheekycheese.dev',
    displayName: 'Kateryna Shevchenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=kateryna',
    role: 'HR',
    telegram: '@kate_shevch',
    phone: '+380671000008',
    monthlySalary: '800.00',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Kateryna Shevchenko',
    bankUahIban: 'UA213223130000026007233566003',
    bankUahRnokpp: '5678901234',
    bankUahBankName: 'monobank',
  },
  {
    email: 'mykola.savchenko@cheekycheese.dev',
    displayName: 'Mykola Savchenko',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=mykola',
    role: 'ACCOUNTANT',
    telegram: '@mykola_savc',
    phone: '+380671000009',
    monthlySalary: '900.00',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Mykola Savchenko',
    bankUahIban: 'UA213223130000026007233566004',
    bankUahRnokpp: '6789012345',
    bankUahBankName: 'ПриватБанк',
  },
]

const SEED_PROJECTS = [
  {
    name: 'AI Platform v2',
    companyName: 'TechCorp AI',
    domain: 'AI / ML',
    seniorEmail: 'oleksiy.kovalenko@cheekycheese.dev',
    juniorEmails: ['sofia.bondarenko@cheekycheese.dev'],
    hrEmails: ['kateryna.shevchenko@cheekycheese.dev'],
    rate: 5000,
    currency: 'USDT' as const,
  },
  {
    name: 'EdTech LMS',
    companyName: 'LearnSpace Inc',
    domain: 'EdTech',
    seniorEmail: 'dmytro.marchenko@cheekycheese.dev',
    juniorEmails: ['ivan.petrenko@cheekycheese.dev'],
    hrEmails: ['anna.lysenko@cheekycheese.dev'],
    rate: 4500,
    currency: 'USD' as const,
  },
  {
    name: 'Ferm Project',
    companyName: 'Ferm',
    domain: 'E-Commerce',
    seniorEmail: 'yaremenkomaksym99@gmail.com',
    juniorEmails: [],
    hrEmails: ['anna.lysenko@cheekycheese.dev'],
    rate: 3500,
    currency: 'USD' as const,
  },
  {
    name: 'One Punch',
    companyName: 'One Punch',
    domain: 'SaaS',
    seniorEmail: 'yaremenkomaksym99@gmail.com',
    juniorEmails: [],
    hrEmails: ['kateryna.shevchenko@cheekycheese.dev'],
    rate: 4000,
    currency: 'USD' as const,
  },
  {
    name: 'Artkai',
    companyName: 'Artkai',
    domain: 'Other',
    seniorEmail: 'yaremenkomaksym99@gmail.com',
    juniorEmails: [],
    hrEmails: ['anna.lysenko@cheekycheese.dev'],
    rate: 3900,
    currency: 'USD' as const,
  },
  {
    name: 'Фавбет',
    companyName: 'Фавбет',
    domain: 'Gambling',
    seniorEmail: 'yaremenkomaksym99@gmail.com',
    juniorEmails: [],
    hrEmails: ['kateryna.shevchenko@cheekycheese.dev'],
    rate: 4500,
    currency: 'USD' as const,
  },
]

const SEED_TEAMS = [
  {
    name: 'Команда Oleksiy',
    seniorEmail: 'oleksiy.kovalenko@cheekycheese.dev',
    hrEmail: 'kateryna.shevchenko@cheekycheese.dev',
  },
  {
    name: 'Команда Dmytro',
    seniorEmail: 'dmytro.marchenko@cheekycheese.dev',
    hrEmail: 'anna.lysenko@cheekycheese.dev',
  },
]

async function main() {
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is not set')

  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
  const db = drizzle(pool, { schema })

  // Upsert users
  console.log('Seeding users...')
  for (const user of SEED_USERS) {
    await db
      .insert(schema.users)
      .values(user)
      .onConflictDoUpdate({
        target: schema.users.email,
        set: {
          telegram: user.telegram ?? null,
          phone: user.phone ?? null,
          seniorSharePercent: user.seniorSharePercent ?? 26,
          monthlySalary: user.monthlySalary ?? null,
          paymentMethod: user.paymentMethod ?? null,
          walletUsdtErc20: user.walletUsdtErc20 ?? null,
          bankUahRecipient: user.bankUahRecipient ?? null,
          bankUahIban: user.bankUahIban ?? null,
          bankUahRnokpp: user.bankUahRnokpp ?? null,
          bankUahBankName: user.bankUahBankName ?? null,
          techStack: user.techStack ?? null,
          updatedAt: new Date(),
        },
      })
    console.log(`  + ${user.email} (${user.role})`)
  }

  const allUsers = await db.select().from(schema.users)
  const byEmail = Object.fromEntries(allUsers.map((u) => [u.email, u]))

  const _hrUsers = allUsers.filter((u) => u.role === 'HR')
  const accountantUsers = allUsers.filter((u) => u.role === 'ACCOUNTANT')

  // Seed teams
  console.log('Seeding teams...')
  const existingTeams = await db.select().from(schema.teams)
  const existingNames = new Set(existingTeams.map((t) => t.name))

  for (const def of SEED_TEAMS) {
    if (existingNames.has(def.name)) {
      console.log(`  ~ ${def.name} (already exists, skipping)`)
      continue
    }

    const [team] = await db.insert(schema.teams).values({ name: def.name }).returning()
    console.log(`  + ${def.name}`)

    const senior = byEmail[def.seniorEmail]
    if (!senior) { console.warn(`    ! senior ${def.seniorEmail} not found`); continue }

    const hr = byEmail[def.hrEmail]
    if (!hr) { console.warn(`    ! HR ${def.hrEmail} not found`); continue }

    const memberIds = [
      senior.id,
      hr.id,
      ...accountantUsers.map((u) => u.id),
    ]

    const unique = [...new Set(memberIds)]
    await db.insert(schema.teamMembers).values(unique.map((userId) => ({ teamId: team!.id, userId })))
    console.log(`    members: ${unique.length}`)
  }

  // Seed projects
  console.log('Seeding projects...')
  const existingProjects = await db.select().from(schema.projects)
  const existingProjectNames = new Set(existingProjects.map((p) => p.name))

  for (const def of SEED_PROJECTS) {
    const senior = byEmail[def.seniorEmail]
    if (!senior) { console.warn(`  ! senior ${def.seniorEmail} not found`); continue }

    let projectId: string
    if (existingProjectNames.has(def.name)) {
      const existing = existingProjects.find((p) => p.name === def.name)!
      projectId = existing.id
      console.log(`  ~ ${def.name} (already exists, skipping)`)
    } else {
      const [project] = await db
        .insert(schema.projects)
        .values({
          name: def.name,
          companyName: def.companyName,
          domain: def.domain,
          startDate: new Date('2024-09-01'),
          seniorId: senior.id,
          rate: def.rate,
          currency: def.currency,
        })
        .returning()
      projectId = project!.id
      console.log(`  + ${def.name}`)
    }

    const membersToAdd = [
      ...def.juniorEmails,
      ...(def.hrEmails ?? []),
      ...accountantUsers.map((u) => u.email),
    ]
    for (const memberEmail of membersToAdd) {
      const member = byEmail[memberEmail]
      if (!member) { console.warn(`    ! member ${memberEmail} not found`); continue }

      const existingMember = await db.query.projectMembers.findFirst({
        where: (pm, { and, eq, isNull }) =>
          and(eq(pm.projectId, projectId), eq(pm.userId, member.id), isNull(pm.leftAt)),
      })
      if (!existingMember) {
        await db.insert(schema.projectMembers).values({ projectId, userId: member.id })
        console.log(`    + member ${memberEmail} (${member.role})`)
      }
    }
  }

  // ── Finance seed ──────────────────────────────────────────────────────────
  console.log('Seeding finance transactions...')
  const existingTxCount = await db.$count(schema.transactions)
  if (existingTxCount > 0) {
    console.log('  ~ transactions already seeded, skipping')
  } else {
    const allProjects = await db.select().from(schema.projects)
    const byProjectName = Object.fromEntries(allProjects.map((p) => [p.name, p]))

    const mykola = byEmail['mykola.savchenko@cheekycheese.dev']! // ACCOUNTANT
    const oleksiy = byEmail['oleksiy.kovalenko@cheekycheese.dev']! // SENIOR
    const dmytro = byEmail['dmytro.marchenko@cheekycheese.dev']! // SENIOR
    const anna = byEmail['anna.lysenko@cheekycheese.dev']! // HR
    const kateryna = byEmail['kateryna.shevchenko@cheekycheese.dev']! // HR
    const sofia = byEmail['sofia.bondarenko@cheekycheese.dev']! // JUNIOR
    const ivan = byEmail['ivan.petrenko@cheekycheese.dev']! // JUNIOR

    const aiProject = byProjectName['AI Platform v2']!
    const edtechProject = byProjectName['EdTech LMS']!
    const fermProject = byProjectName['Ferm Project']!
    const onePunchProject = byProjectName['One Punch']!
    const artkaiProject = byProjectName['Artkai']!
    const favbetProject = byProjectName['Фавбет']!

    type NewTx = typeof schema.transactions.$inferInsert

    const txBatch: NewTx[] = []
    const payoutBatch: typeof schema.payoutRequests.$inferInsert[] = []

    // Helper: date offset from a base month
    function monthDate(year: number, month: number, day = 10): Date {
      return new Date(year, month - 1, day)
    }

    // ── 2024 (Jan–Dec) ─────────────────────────────────────────────────────

    // Q1 2024 — Maksym active on Ferm + OnePunch, Kostya on Artkai
    for (const [mo, day, project, amount] of [
      [1, 8,  fermProject,     3500],
      [1, 12, onePunchProject, 4000],
      [2, 7,  fermProject,     3500],
      [2, 14, onePunchProject, 4000],
      [3, 9,  fermProject,     3500],
      [3, 11, onePunchProject, 4000],
    ] as [number, number, typeof fermProject, number][]) {
      const pr = {
        id: crypto.randomUUID(),
        seniorId: MAKSYM_ID,
        incomeAmount: String(amount),
        payableAmount: String(amount * 0.74),
        txHash: `0xPAYOUT_M_2024_${mo.toString().padStart(2,'0')}`,
        status: 'PAID' as const,
        createdAt: monthDate(2024, mo, day + 3),
        updatedAt: monthDate(2024, mo, day + 4),
      }
      payoutBatch.push(pr)

      // INCOME = client company → recipient user. sender side carries
      // only the project's company name (no userId); receiverId points
      // at the user who actually got the money. UI renders this as
      // "{companyName} → {recipient}". `createdBy` stays at the recipient
      // because it tracks "who entered the transaction", which is the
      // same person in seed data.
      const income: NewTx = {
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: String(amount),
        currency: 'USD',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: MAKSYM_ID,
        projectId: project.id,
        seniorSharePercent: 26,
        notes: `Monthly income ${2024}-${String(mo).padStart(2,'0')}`,
        createdBy: MAKSYM_ID,
        createdAt: monthDate(2024, mo, day),
        updatedAt: monthDate(2024, mo, day),
      }
      txBatch.push(income)
    }

    // Kostya admin income Q1 2024
    for (const [mo, day, project, amount] of [
      [1, 9,  artkaiProject, 3900],
      [2, 9,  artkaiProject, 3900],
      [3, 10, artkaiProject, 3900],
    ] as [number, number, typeof artkaiProject, number][]) {
      txBatch.push({
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: String(amount),
        currency: 'USD',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: KOSTYA_ID,
        projectId: project.id,
        seniorSharePercent: 26,
        createdBy: KOSTYA_ID,
        createdAt: monthDate(2024, mo, day),
        updatedAt: monthDate(2024, mo, day),
      })
    }

    // Oleksiy + Dmytro SENIOR_INCOME Q1 2024 — VALIDATED + payout done
    const seniorIncomeQ1: [typeof oleksiy, typeof aiProject, number, number, number][] = [
      [oleksiy, aiProject,    5000, 1, 5],
      [oleksiy, aiProject,    5000, 2, 6],
      [oleksiy, aiProject,    5000, 3, 7],
      [dmytro,  edtechProject, 4500, 1, 6],
      [dmytro,  edtechProject, 4500, 2, 7],
      [dmytro,  edtechProject, 4500, 3, 8],
    ]
    for (const [senior, project, amount, mo, day] of seniorIncomeQ1) {
      const incomeId = crypto.randomUUID()
      const prId = crypto.randomUUID()
      const payable = amount * 0.74

      payoutBatch.push({
        id: prId,
        seniorId: senior.id,
        incomeAmount: String(amount),
        payableAmount: String(payable),
        txHash: `0xSENIOR_${senior.id.slice(0,4)}_2024_${String(mo).padStart(2,'0')}`,
        status: 'PAID',
        createdAt: monthDate(2024, mo, day + 5),
        updatedAt: monthDate(2024, mo, day + 6),
      })

      txBatch.push({
        id: incomeId,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: String(amount),
        currency: 'USDT',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: senior.id,
        projectId: project.id,
        payoutRequestId: prId,
        seniorSharePercent: 26,
        validatedBy: mykola.id,
        validatedAt: monthDate(2024, mo, day + 2),
        receiptExternalUrl: `https://etherscan.io/tx/0xRECEIPT_${mo}_${senior.id.slice(0,4)}`,
        createdBy: senior.id,
        createdAt: monthDate(2024, mo, day),
        updatedAt: monthDate(2024, mo, day + 6),
      })
      // PAYOUT for this income
      txBatch.push({
        type: 'PAYOUT',
        status: 'PAID',
        amount: String(payable),
        currency: 'USDT',
        senderId: senior.id,
        receiverLabel: 'CheekyCheeseIT',
        projectId: project.id,
        payoutRequestId: prId,
        txHash: `0xSENIOR_${senior.id.slice(0,4)}_2024_${String(mo).padStart(2,'0')}`,
        createdBy: senior.id,
        createdAt: monthDate(2024, mo, day + 5),
        updatedAt: monthDate(2024, mo, day + 6),
      })
      // PAYOUT_ADMIN x2
      for (const adminId of [MAKSYM_ID, KOSTYA_ID]) {
        txBatch.push({
          type: 'PAYOUT_ADMIN',
          status: 'PAID',
          amount: String(payable / 2),
          currency: 'USDT',
          senderId: senior.id,
          receiverId: adminId,
          payoutRequestId: prId,
          txHash: `0xSENIOR_${senior.id.slice(0,4)}_2024_${String(mo).padStart(2,'0')}`,
          createdBy: senior.id,
          createdAt: monthDate(2024, mo, day + 5),
          updatedAt: monthDate(2024, mo, day + 5),
        })
      }
    }

    // Q2 2024 — same pattern. INCOME semantics: senderLabel = client
    // company, receiverId = the admin who got the money. See Q1 block
    // above for the rationale.
    for (const [mo, day, project, amount] of [
      [4, 8,  fermProject,     3500],
      [4, 12, onePunchProject, 4000],
      [5, 7,  fermProject,     3700],
      [5, 14, onePunchProject, 4000],
      [6, 9,  fermProject,     3700],
      [6, 11, onePunchProject, 4200],
    ] as [number, number, typeof fermProject, number][]) {
      txBatch.push({
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: String(amount),
        currency: 'USD',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: MAKSYM_ID,
        projectId: project.id,
        seniorSharePercent: 26,
        createdBy: MAKSYM_ID,
        createdAt: monthDate(2024, mo, day),
        updatedAt: monthDate(2024, mo, day),
      })
    }

    // Kostya Q2
    for (const [mo, project, amount] of [
      [4, artkaiProject, 3900],
      [5, favbetProject, 4500],
      [6, favbetProject, 4500],
    ] as [number, typeof artkaiProject, number][]) {
      txBatch.push({
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: String(amount),
        currency: 'USD',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: KOSTYA_ID,
        projectId: project.id,
        seniorSharePercent: 26,
        createdBy: KOSTYA_ID,
        createdAt: monthDate(2024, mo, 10),
        updatedAt: monthDate(2024, mo, 10),
      })
    }

    // Senior incomes Q2 2024
    for (const [senior, project, amount, mo] of [
      [oleksiy, aiProject,    5200, 4],
      [oleksiy, aiProject,    5200, 5],
      [oleksiy, aiProject,    5000, 6],
      [dmytro,  edtechProject, 4500, 4],
      [dmytro,  edtechProject, 4800, 5],
      [dmytro,  edtechProject, 4800, 6],
    ] as [typeof oleksiy, typeof aiProject, number, number][]) {
      const prId = crypto.randomUUID()
      const payable = amount * 0.74
      payoutBatch.push({
        id: prId,
        seniorId: senior.id,
        incomeAmount: String(amount),
        payableAmount: String(payable),
        txHash: `0xS_${senior.id.slice(0,4)}_Q2_${mo}`,
        status: 'PAID',
        createdAt: monthDate(2024, mo, 15),
        updatedAt: monthDate(2024, mo, 16),
      })
      txBatch.push({
        type: 'SENIOR_INCOME', status: 'PAID', amount: String(amount), currency: 'USDT',
        senderId: null, senderLabel: project.companyName, receiverId: senior.id,
        projectId: project.id, payoutRequestId: prId,
        seniorSharePercent: 26, validatedBy: mykola.id, validatedAt: monthDate(2024, mo, 12),
        receiptExternalUrl: `https://etherscan.io/tx/0xRQ2_${mo}_${senior.id.slice(0,4)}`,
        createdBy: senior.id, createdAt: monthDate(2024, mo, 8), updatedAt: monthDate(2024, mo, 16),
      })
      txBatch.push({
        type: 'PAYOUT', status: 'PAID', amount: String(payable), currency: 'USDT',
        senderId: senior.id, receiverLabel: 'CheekyCheeseIT', projectId: project.id, payoutRequestId: prId,
        txHash: `0xS_${senior.id.slice(0,4)}_Q2_${mo}`,
        createdBy: senior.id, createdAt: monthDate(2024, mo, 15), updatedAt: monthDate(2024, mo, 16),
      })
      for (const adminId of [MAKSYM_ID, KOSTYA_ID]) {
        txBatch.push({
          type: 'PAYOUT_ADMIN', status: 'PAID', amount: String(payable / 2), currency: 'USDT',
          senderId: senior.id, receiverId: adminId, payoutRequestId: prId,
          txHash: `0xS_${senior.id.slice(0,4)}_Q2_${mo}`,
          createdBy: senior.id, createdAt: monthDate(2024, mo, 15), updatedAt: monthDate(2024, mo, 15),
        })
      }
    }

    // Q3 2024 — Favbet joins Maksym's portfolio
    for (const [mo, project, amount] of [
      [7,  fermProject,     3700],
      [7,  onePunchProject, 4200],
      [7,  favbetProject,   4500],
      [8,  fermProject,     3700],
      [8,  onePunchProject, 4200],
      [8,  favbetProject,   4500],
      [9,  fermProject,     3700],
      [9,  onePunchProject, 4500],
      [9,  favbetProject,   4800],
    ] as [number, typeof fermProject, number][]) {
      txBatch.push({
        type: 'ADMIN_INCOME', status: 'PAID', amount: String(amount), currency: 'USD',
        senderId: null, senderLabel: project.companyName, receiverId: MAKSYM_ID,
        projectId: project.id, seniorSharePercent: 26,
        createdBy: MAKSYM_ID, createdAt: monthDate(2024, mo, 10), updatedAt: monthDate(2024, mo, 10),
      })
    }

    // Kostya Q3
    for (const [mo, project, amount] of [
      [7,  artkaiProject, 3900],
      [8,  artkaiProject, 3900],
      [9,  artkaiProject, 4100],
    ] as [number, typeof artkaiProject, number][]) {
      txBatch.push({
        type: 'ADMIN_INCOME', status: 'PAID', amount: String(amount), currency: 'USD',
        senderId: null, senderLabel: project.companyName, receiverId: KOSTYA_ID,
        projectId: project.id, seniorSharePercent: 26,
        createdBy: KOSTYA_ID, createdAt: monthDate(2024, mo, 11), updatedAt: monthDate(2024, mo, 11),
      })
    }

    // Senior incomes Q3 2024
    for (const [senior, project, amount, mo] of [
      [oleksiy, aiProject,    5000, 7],
      [oleksiy, aiProject,    5500, 8],
      [oleksiy, aiProject,    5500, 9],
      [dmytro,  edtechProject, 4800, 7],
      [dmytro,  edtechProject, 4800, 8],
      [dmytro,  edtechProject, 5000, 9],
    ] as [typeof oleksiy, typeof aiProject, number, number][]) {
      const prId = crypto.randomUUID()
      const payable = amount * 0.74
      payoutBatch.push({ id: prId, seniorId: senior.id, incomeAmount: String(amount), payableAmount: String(payable), txHash: `0xS_${senior.id.slice(0,4)}_Q3_${mo}`, status: 'PAID', createdAt: monthDate(2024, mo, 17), updatedAt: monthDate(2024, mo, 18) })
      txBatch.push({ type: 'SENIOR_INCOME', status: 'PAID', amount: String(amount), currency: 'USDT', senderId: null, senderLabel: project.companyName, receiverId: senior.id, projectId: project.id, payoutRequestId: prId, seniorSharePercent: 26, validatedBy: mykola.id, validatedAt: monthDate(2024, mo, 13), receiptExternalUrl: `https://etherscan.io/tx/0xRQ3_${mo}`, createdBy: senior.id, createdAt: monthDate(2024, mo, 9), updatedAt: monthDate(2024, mo, 18) })
      txBatch.push({ type: 'PAYOUT', status: 'PAID', amount: String(payable), currency: 'USDT', senderId: senior.id, receiverLabel: 'CheekyCheeseIT', projectId: project.id, payoutRequestId: prId, txHash: `0xS_${senior.id.slice(0,4)}_Q3_${mo}`, createdBy: senior.id, createdAt: monthDate(2024, mo, 17), updatedAt: monthDate(2024, mo, 18) })
      for (const adminId of [MAKSYM_ID, KOSTYA_ID]) {
        txBatch.push({ type: 'PAYOUT_ADMIN', status: 'PAID', amount: String(payable / 2), currency: 'USDT', senderId: senior.id, receiverId: adminId, payoutRequestId: prId, txHash: `0xS_${senior.id.slice(0,4)}_Q3_${mo}`, createdBy: senior.id, createdAt: monthDate(2024, mo, 17), updatedAt: monthDate(2024, mo, 17) })
      }
    }

    // Q4 2024 — Artkai grows, Maksym adds it
    for (const [mo, project, amount] of [
      [10, fermProject,     3700],
      [10, onePunchProject, 4500],
      [10, favbetProject,   4800],
      [11, fermProject,     3700],
      [11, onePunchProject, 4500],
      [11, favbetProject,   5000],
      [12, fermProject,     3700],
      [12, onePunchProject, 4500],
      [12, favbetProject,   5000],
    ] as [number, typeof fermProject, number][]) {
      txBatch.push({ type: 'ADMIN_INCOME', status: 'PAID', amount: String(amount), currency: 'USD', senderId: null, senderLabel: project.companyName, receiverId: MAKSYM_ID, projectId: project.id, seniorSharePercent: 26, createdBy: MAKSYM_ID, createdAt: monthDate(2024, mo, 10), updatedAt: monthDate(2024, mo, 10) })
    }
    for (const [mo, amount] of [[10, 4100], [11, 4100], [12, 4300]] as [number, number][]) {
      txBatch.push({ type: 'ADMIN_INCOME', status: 'PAID', amount: String(amount), currency: 'USD', senderId: null, senderLabel: artkaiProject.companyName, receiverId: KOSTYA_ID, projectId: artkaiProject.id, seniorSharePercent: 26, createdBy: KOSTYA_ID, createdAt: monthDate(2024, mo, 11), updatedAt: monthDate(2024, mo, 11) })
    }

    // Senior incomes Q4 2024
    for (const [senior, project, amount, mo] of [
      [oleksiy, aiProject,    5500, 10],
      [oleksiy, aiProject,    5800, 11],
      [oleksiy, aiProject,    5800, 12],
      [dmytro,  edtechProject, 5000, 10],
      [dmytro,  edtechProject, 5000, 11],
      [dmytro,  edtechProject, 5200, 12],
    ] as [typeof oleksiy, typeof aiProject, number, number][]) {
      const prId = crypto.randomUUID()
      const payable = amount * 0.74
      payoutBatch.push({ id: prId, seniorId: senior.id, incomeAmount: String(amount), payableAmount: String(payable), txHash: `0xS_${senior.id.slice(0,4)}_Q4_${mo}`, status: 'PAID', createdAt: monthDate(2024, mo, 17), updatedAt: monthDate(2024, mo, 18) })
      txBatch.push({ type: 'SENIOR_INCOME', status: 'PAID', amount: String(amount), currency: 'USDT', senderId: null, senderLabel: project.companyName, receiverId: senior.id, projectId: project.id, payoutRequestId: prId, seniorSharePercent: 26, validatedBy: mykola.id, validatedAt: monthDate(2024, mo, 13), receiptExternalUrl: `https://etherscan.io/tx/0xRQ4_${mo}`, createdBy: senior.id, createdAt: monthDate(2024, mo, 9), updatedAt: monthDate(2024, mo, 18) })
      txBatch.push({ type: 'PAYOUT', status: 'PAID', amount: String(payable), currency: 'USDT', senderId: senior.id, receiverLabel: 'CheekyCheeseIT', projectId: project.id, payoutRequestId: prId, txHash: `0xS_${senior.id.slice(0,4)}_Q4_${mo}`, createdBy: senior.id, createdAt: monthDate(2024, mo, 17), updatedAt: monthDate(2024, mo, 18) })
      for (const adminId of [MAKSYM_ID, KOSTYA_ID]) {
        txBatch.push({ type: 'PAYOUT_ADMIN', status: 'PAID', amount: String(payable / 2), currency: 'USDT', senderId: senior.id, receiverId: adminId, payoutRequestId: prId, txHash: `0xS_${senior.id.slice(0,4)}_Q4_${mo}`, createdBy: senior.id, createdAt: monthDate(2024, mo, 17), updatedAt: monthDate(2024, mo, 17) })
      }
    }

    // ── 2025 (Jan–Apr, active period) ──────────────────────────────────────

    for (const [mo, project, amount] of [
      [1,  fermProject,     3700],
      [1,  onePunchProject, 4500],
      [1,  favbetProject,   5000],
      [2,  fermProject,     3700],
      [2,  onePunchProject, 4500],
      [2,  favbetProject,   5200],
      [3,  fermProject,     3700],
      [3,  onePunchProject, 4500],
      [3,  favbetProject,   5200],
      [4,  fermProject,     3700],
      [4,  onePunchProject, 4500],
      [4,  favbetProject,   5200],
    ] as [number, typeof fermProject, number][]) {
      txBatch.push({ type: 'ADMIN_INCOME', status: 'PAID', amount: String(amount), currency: 'USD', senderId: null, senderLabel: project.companyName, receiverId: MAKSYM_ID, projectId: project.id, seniorSharePercent: 26, createdBy: MAKSYM_ID, createdAt: monthDate(2025, mo, 10), updatedAt: monthDate(2025, mo, 10) })
    }
    for (const [mo, amount] of [[1, 4300], [2, 4500], [3, 4500], [4, 4500]] as [number, number][]) {
      txBatch.push({ type: 'ADMIN_INCOME', status: 'PAID', amount: String(amount), currency: 'USD', senderId: null, senderLabel: artkaiProject.companyName, receiverId: KOSTYA_ID, projectId: artkaiProject.id, seniorSharePercent: 26, createdBy: KOSTYA_ID, createdAt: monthDate(2025, mo, 11), updatedAt: monthDate(2025, mo, 11) })
    }

    // Senior incomes 2025 Q1
    for (const [senior, project, amount, mo] of [
      [oleksiy, aiProject,    6000, 1],
      [oleksiy, aiProject,    6000, 2],
      [oleksiy, aiProject,    6200, 3],
      [dmytro,  edtechProject, 5200, 1],
      [dmytro,  edtechProject, 5200, 2],
      [dmytro,  edtechProject, 5500, 3],
    ] as [typeof oleksiy, typeof aiProject, number, number][]) {
      const prId = crypto.randomUUID()
      const payable = amount * 0.74
      payoutBatch.push({ id: prId, seniorId: senior.id, incomeAmount: String(amount), payableAmount: String(payable), txHash: `0x25_${senior.id.slice(0,4)}_${mo}`, status: 'PAID', createdAt: monthDate(2025, mo, 17), updatedAt: monthDate(2025, mo, 18) })
      txBatch.push({ type: 'SENIOR_INCOME', status: 'PAID', amount: String(amount), currency: 'USDT', senderId: null, senderLabel: project.companyName, receiverId: senior.id, projectId: project.id, payoutRequestId: prId, seniorSharePercent: 26, validatedBy: mykola.id, validatedAt: monthDate(2025, mo, 13), receiptExternalUrl: `https://etherscan.io/tx/0xR25_${mo}`, createdBy: senior.id, createdAt: monthDate(2025, mo, 9), updatedAt: monthDate(2025, mo, 18) })
      txBatch.push({ type: 'PAYOUT', status: 'PAID', amount: String(payable), currency: 'USDT', senderId: senior.id, receiverLabel: 'CheekyCheeseIT', projectId: project.id, payoutRequestId: prId, txHash: `0x25_${senior.id.slice(0,4)}_${mo}`, createdBy: senior.id, createdAt: monthDate(2025, mo, 17), updatedAt: monthDate(2025, mo, 18) })
      for (const adminId of [MAKSYM_ID, KOSTYA_ID]) {
        txBatch.push({ type: 'PAYOUT_ADMIN', status: 'PAID', amount: String(payable / 2), currency: 'USDT', senderId: senior.id, receiverId: adminId, payoutRequestId: prId, txHash: `0x25_${senior.id.slice(0,4)}_${mo}`, createdBy: senior.id, createdAt: monthDate(2025, mo, 17), updatedAt: monthDate(2025, mo, 17) })
      }
    }

    // Apr 2025 — recent (VALIDATED, no payout yet)
    for (const [senior, project, amount] of [
      [oleksiy, aiProject,    6200],
      [dmytro,  edtechProject, 5500],
    ] as [typeof oleksiy, typeof aiProject, number][]) {
      txBatch.push({
        type: 'SENIOR_INCOME', status: 'VALIDATED', amount: String(amount), currency: 'USDT',
        senderId: null, senderLabel: project.companyName, receiverId: senior.id,
        projectId: project.id, seniorSharePercent: 26,
        validatedBy: mykola.id, validatedAt: monthDate(2025, 4, 13),
        receiptExternalUrl: `https://etherscan.io/tx/0xR25_4_${senior.id.slice(0,4)}`,
        createdBy: senior.id, createdAt: monthDate(2025, 4, 9), updatedAt: monthDate(2025, 4, 13),
      })
    }

    // May 2025 — current month, pending
    txBatch.push({
      type: 'SENIOR_INCOME', status: 'PENDING', amount: '6500', currency: 'USDT',
      senderId: null, senderLabel: aiProject.companyName, receiverId: oleksiy.id,
      projectId: aiProject.id, seniorSharePercent: 26,
      receiptExternalUrl: 'https://etherscan.io/tx/0xRECENT_MAY', notes: 'May 2025 payment',
      createdBy: oleksiy.id, createdAt: monthDate(2025, 5, 8), updatedAt: monthDate(2025, 5, 8),
    })
    txBatch.push({
      type: 'SENIOR_INCOME', status: 'REJECTED', amount: '5300', currency: 'USDT',
      senderId: null, senderLabel: edtechProject.companyName, receiverId: dmytro.id,
      projectId: edtechProject.id, seniorSharePercent: 26,
      rejectionReason: 'Неверная сумма, должно быть 5500 USDT',
      createdBy: dmytro.id, createdAt: monthDate(2025, 5, 7), updatedAt: monthDate(2025, 5, 10),
    })
    // Maksym May 2025
    for (const [project, amount] of [
      [fermProject,     3700],
      [onePunchProject, 4500],
      [favbetProject,   5200],
    ] as [typeof fermProject, number][]) {
      txBatch.push({ type: 'ADMIN_INCOME', status: 'PAID', amount: String(amount), currency: 'USD', senderId: null, senderLabel: project.companyName, receiverId: MAKSYM_ID, projectId: project.id, seniorSharePercent: 26, createdBy: MAKSYM_ID, createdAt: monthDate(2025, 5, 10), updatedAt: monthDate(2025, 5, 10) })
    }

    // ── Expenses ────────────────────────────────────────────────────────────
    const expenses: NewTx[] = [
      // 2024
      { type: 'EXPENSE', status: 'PAID', amount: '199', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Оплата сервиса', notes: 'AWS hosting Jan 2024', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 1, 15), updatedAt: monthDate(2024, 1, 15) },
      { type: 'EXPENSE', status: 'PAID', amount: '150', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Реклама', notes: 'LinkedIn ads Q1', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 2, 10), updatedAt: monthDate(2024, 2, 10) },
      { type: 'EXPENSE', status: 'PAID', amount: '89',  currency: 'USD', senderId: KOSTYA_ID, receiverLabel: 'Комиссия', notes: 'Platform fee Mar', createdBy: KOSTYA_ID, createdAt: monthDate(2024, 3, 8), updatedAt: monthDate(2024, 3, 8) },
      { type: 'EXPENSE', status: 'PAID', amount: '300', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Аренда', notes: 'Office Apr 2024', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 4, 1), updatedAt: monthDate(2024, 4, 1) },
      { type: 'EXPENSE', status: 'PAID', amount: '250', currency: 'USD', senderId: KOSTYA_ID, receiverLabel: 'Реклама', notes: 'Google ads Q2', createdBy: KOSTYA_ID, createdAt: monthDate(2024, 5, 5), updatedAt: monthDate(2024, 5, 5) },
      { type: 'EXPENSE', status: 'PAID', amount: '120', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Оплата сервиса', notes: 'GitHub Teams', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 6, 12), updatedAt: monthDate(2024, 6, 12) },
      { type: 'EXPENSE', status: 'PAID', amount: '300', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Аренда', notes: 'Office Jul 2024', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 7, 1), updatedAt: monthDate(2024, 7, 1) },
      { type: 'EXPENSE', status: 'PAID', amount: '199', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Оплата сервиса', notes: 'AWS hosting Aug', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 8, 15), updatedAt: monthDate(2024, 8, 15) },
      { type: 'EXPENSE', status: 'PAID', amount: '75',  currency: 'USD', senderId: KOSTYA_ID, receiverLabel: 'Комиссия', notes: 'Stripe fees Sep', createdBy: KOSTYA_ID, createdAt: monthDate(2024, 9, 5), updatedAt: monthDate(2024, 9, 5) },
      { type: 'EXPENSE', status: 'PAID', amount: '300', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Аренда', notes: 'Office Oct 2024', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 10, 1), updatedAt: monthDate(2024, 10, 1) },
      { type: 'EXPENSE', status: 'PAID', amount: '400', currency: 'USD', senderId: KOSTYA_ID, receiverLabel: 'Реклама', notes: 'Conference Nov', createdBy: KOSTYA_ID, createdAt: monthDate(2024, 11, 20), updatedAt: monthDate(2024, 11, 20) },
      { type: 'EXPENSE', status: 'PAID', amount: '199', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Оплата сервиса', notes: 'AWS hosting Dec', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 12, 15), updatedAt: monthDate(2024, 12, 15) },
      // 2025
      { type: 'EXPENSE', status: 'PAID', amount: '300', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Аренда', notes: 'Office Jan 2025', createdBy: MAKSYM_ID, createdAt: monthDate(2025, 1, 2), updatedAt: monthDate(2025, 1, 2) },
      { type: 'EXPENSE', status: 'PAID', amount: '199', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Оплата сервиса', notes: 'AWS hosting Feb', createdBy: MAKSYM_ID, createdAt: monthDate(2025, 2, 15), updatedAt: monthDate(2025, 2, 15) },
      { type: 'EXPENSE', status: 'PAID', amount: '500', currency: 'USD', senderId: KOSTYA_ID, receiverLabel: 'Реклама', notes: 'Q1 marketing push', createdBy: KOSTYA_ID, createdAt: monthDate(2025, 3, 3), updatedAt: monthDate(2025, 3, 3) },
      { type: 'EXPENSE', status: 'PAID', amount: '300', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Аренда', notes: 'Office Apr 2025', createdBy: MAKSYM_ID, createdAt: monthDate(2025, 4, 1), updatedAt: monthDate(2025, 4, 1) },
      { type: 'EXPENSE', status: 'PAID', amount: '120', currency: 'USD', senderId: MAKSYM_ID, receiverLabel: 'Прочее', notes: 'Team lunch May', createdBy: MAKSYM_ID, createdAt: monthDate(2025, 5, 5), updatedAt: monthDate(2025, 5, 5) },
    ]
    txBatch.push(...expenses)

    // ── Salaries (HR, Accountant) — monthly PAID (2024) ────────────────────
    const salaryTargets: [typeof anna, string][] = [
      [anna, '800'],
      [kateryna, '800'],
      [mykola, '900'],
    ]
    for (let mo = 1; mo <= 12; mo++) {
      for (const [employee, salary] of salaryTargets) {
        txBatch.push({
          type: 'SALARY', status: 'PAID', amount: salary, currency: 'USD',
          senderId: MAKSYM_ID, receiverId: employee.id,
          salaryMonth: `2024-${String(mo).padStart(2, '0')}`,
          notes: `Salary ${employee.displayName} ${String(mo).padStart(2,'0')}/2024`,
          createdBy: MAKSYM_ID,
          createdAt: monthDate(2024, mo, 28),
          updatedAt: monthDate(2024, mo, 28),
        })
      }
    }
    // 2025 Q1 salaries (Jan–Mar PAID)
    for (let mo = 1; mo <= 3; mo++) {
      for (const [employee, salary] of salaryTargets) {
        txBatch.push({
          type: 'SALARY', status: 'PAID', amount: salary, currency: 'USD',
          senderId: MAKSYM_ID, receiverId: employee.id,
          salaryMonth: `2025-${String(mo).padStart(2, '0')}`,
          createdBy: MAKSYM_ID,
          createdAt: monthDate(2025, mo, 28),
          updatedAt: monthDate(2025, mo, 28),
        })
      }
    }
    // April 2025 salaries — PENDING (cron runs on May 1st, creates for previous month = April)
    for (const [employee, salary] of salaryTargets) {
      txBatch.push({
        type: 'SALARY', status: 'PENDING', amount: salary, currency: 'USD',
        senderId: MAKSYM_ID, receiverId: employee.id,
        salaryMonth: '2025-04',
        createdBy: MAKSYM_ID,
        createdAt: monthDate(2025, 5, 1),
        updatedAt: monthDate(2025, 5, 1),
      })
    }

    // Junior salaries — Sofia (has wallet → PAID), Ivan (no wallet → PENDING until now)
    // 2024: both active
    for (let mo = 1; mo <= 12; mo++) {
      txBatch.push({
        type: 'SALARY', status: 'PAID', amount: '500', currency: 'USD',
        senderId: MAKSYM_ID, receiverId: sofia.id,
        salaryMonth: `2024-${String(mo).padStart(2, '0')}`,
        txHash: `0xJR_SOFIA_2024_${mo}`,
        createdBy: MAKSYM_ID, createdAt: monthDate(2024, mo, 28), updatedAt: monthDate(2024, mo, 28),
      })
      // Ivan paid manually
      txBatch.push({
        type: 'SALARY', status: 'PAID', amount: '600', currency: 'USD',
        senderId: MAKSYM_ID, receiverId: ivan.id,
        salaryMonth: `2024-${String(mo).padStart(2, '0')}`,
        notes: 'Paid manually (no wallet)',
        createdBy: MAKSYM_ID, createdAt: monthDate(2024, mo, 28), updatedAt: monthDate(2024, mo, 28),
      })
    }
    for (let mo = 1; mo <= 3; mo++) {
      txBatch.push({
        type: 'SALARY', status: 'PAID', amount: '500', currency: 'USD',
        senderId: MAKSYM_ID, receiverId: sofia.id,
        salaryMonth: `2025-${String(mo).padStart(2, '0')}`,
        txHash: `0xJR_SOFIA_2025_${mo}`,
        createdBy: MAKSYM_ID, createdAt: monthDate(2025, mo, 28), updatedAt: monthDate(2025, mo, 28),
      })
      txBatch.push({
        type: 'SALARY', status: 'PAID', amount: '600', currency: 'USD',
        senderId: MAKSYM_ID, receiverId: ivan.id,
        salaryMonth: `2025-${String(mo).padStart(2, '0')}`,
        notes: 'Paid manually',
        createdBy: MAKSYM_ID, createdAt: monthDate(2025, mo, 28), updatedAt: monthDate(2025, mo, 28),
      })
    }
    // April 2025 — Sofia PENDING, Ivan LOCKED (cron May 1st → salary for April)
    txBatch.push({ type: 'SALARY', status: 'PENDING', amount: '500', currency: 'USD', senderId: MAKSYM_ID, receiverId: sofia.id, salaryMonth: '2025-04', createdBy: MAKSYM_ID, createdAt: monthDate(2025, 5, 1), updatedAt: monthDate(2025, 5, 1) })
    txBatch.push({ type: 'SALARY', status: 'LOCKED', amount: '600', currency: 'USD', senderId: MAKSYM_ID, receiverId: ivan.id, salaryMonth: '2025-04', createdBy: MAKSYM_ID, createdAt: monthDate(2025, 5, 1), updatedAt: monthDate(2025, 5, 1) })

    // ── Admin transfers ──────────────────────────────────────────────────────
    txBatch.push(
      { type: 'ADMIN_TRANSFER', status: 'PAID', amount: '1200', currency: 'USD', senderId: KOSTYA_ID, receiverId: MAKSYM_ID, notes: 'Q1 equalization', createdBy: KOSTYA_ID, createdAt: monthDate(2024, 4, 2), updatedAt: monthDate(2024, 4, 2) },
      { type: 'ADMIN_TRANSFER', status: 'PAID', amount: '800', currency: 'USD', senderId: MAKSYM_ID, receiverId: KOSTYA_ID, notes: 'Q3 balance top-up', createdBy: MAKSYM_ID, createdAt: monthDate(2024, 10, 5), updatedAt: monthDate(2024, 10, 5) },
      { type: 'ADMIN_TRANSFER', status: 'PAID', amount: '1500', currency: 'USD', senderId: KOSTYA_ID, receiverId: MAKSYM_ID, notes: 'Year-end settlement', createdBy: KOSTYA_ID, createdAt: monthDate(2025, 1, 15), updatedAt: monthDate(2025, 1, 15) },
    )

    // Insert payout requests first (transactions reference them)
    if (payoutBatch.length > 0) {
      await db.insert(schema.payoutRequests).values(payoutBatch)
      console.log(`  + inserted ${payoutBatch.length} payout requests`)
    }

    // Insert transactions in chunks to avoid param limit
    const CHUNK = 50
    for (let i = 0; i < txBatch.length; i += CHUNK) {
      await db.insert(schema.transactions).values(txBatch.slice(i, i + CHUNK))
    }
    console.log(`  + inserted ${txBatch.length} transactions`)
  }

  // Seed interviews
  console.log('Seeding interviews...')
  const existingInterviewsCount = await db.$count(schema.interviews)
  if (existingInterviewsCount > 0) {
    console.log('  ~ interviews already seeded, skipping')
  } else {
    const oleksiy = byEmail['oleksiy.kovalenko@cheekycheese.dev']
    const dmytro = byEmail['dmytro.marchenko@cheekycheese.dev']
    const anna = byEmail['anna.lysenko@cheekycheese.dev']

    if (oleksiy && dmytro && anna) {
      const interviewSeed: schema.NewInterview[] = [
        { seniorId: oleksiy.id, hrId: anna.id, companyName: 'GlobalTech', vacancyUrl: 'https://globaltech.com/jobs/senior-dev', stage: 'HR_SCREEN', position: 0 },
        { seniorId: oleksiy.id, hrId: anna.id, companyName: 'DataCorp', vacancyUrl: 'https://datacorp.io/careers/fullstack', stage: 'TECH_INTERVIEW', position: 0, notesDomain: 'Data Engineering', notesTechStack: 'Python, Spark, Kafka' },
        { seniorId: oleksiy.id, hrId: anna.id, companyName: 'AIStartup', vacancyUrl: 'https://aistartup.ai/roles/lead', stage: 'OFFER_RECEIVED', position: 0, notesDomain: 'AI / ML', notesTechStack: 'Python, FastAPI, PyTorch', notesPaymentType: 'гиг-контракт', notesSalaryReview: 'через 6 місяців' },
        { seniorId: oleksiy.id, hrId: anna.id, companyName: 'CloudSystems', stage: 'HIRED', position: 0, notesDomain: 'Cloud / DevOps', notesTechStack: 'AWS, Terraform, Node.js', notesPaymentType: 'ФОП' },
        { seniorId: dmytro.id, hrId: anna.id, companyName: 'WebAgency', vacancyUrl: 'https://webagency.com/jobs/react-dev', stage: 'HR_SCREEN', position: 0 },
        { seniorId: dmytro.id, hrId: anna.id, companyName: 'FinTech Ltd', vacancyUrl: 'https://fintech.com/careers', stage: 'ENGLISH_CHECK', position: 0, notesDomain: 'FinTech', notesTechStack: 'React, TypeScript, Node.js' },
        { seniorId: dmytro.id, hrId: anna.id, companyName: 'EdTechPro', vacancyUrl: 'https://edtechpro.com/jobs/senior', stage: 'FINAL_INTERVIEW', position: 0, notesDomain: 'EdTech', notesTechStack: 'Vue.js, Python, PostgreSQL', notesBenefits: '25 days vacation, health insurance', notesPaymentType: 'крипта' },
        { seniorId: dmytro.id, hrId: anna.id, companyName: 'OldCompany', stage: 'REJECTED', position: 0, notesGeneral: 'Не прошёл технический этап' },
      ]
      await db.insert(schema.interviews).values(interviewSeed)
      console.log(`  + seeded ${interviewSeed.length} interviews`)
    }
  }

  // ── Documents seed (PHASE 6) ─────────────────────────────────────────────
  //
  // Best-effort REAL uploads: when MinIO / S3 env vars are present (`S3_ENDPOINT`,
  // `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) we push a real
  // PDF (`seed-fixtures/sample-receipt-real.pdf`, a 143 KB sample receipt the
  // user supplied) into the bucket under each PDF document's s3_key. When
  // those vars are missing (CI / production migrations) we silently skip the
  // upload — the row stays in the DB and the UI shows a 404 thumbnail until
  // a real upload happens. ONE PDF is used for ALL PDF categories (RESUME /
  // CONTRACT / RECEIPT) to keep the seed deterministic and small.
  //
  // AVATAR/LOGO are NOT seeded here — those rows are created in
  // task-avatars-logos-integration where users.avatar_document_id and
  // projects.logo_document_id schema columns appear. This task only lays
  // down the table + enum.
  console.log('Seeding documents...')
  const existingDocsCount = await db.$count(schema.documents)
  if (existingDocsCount > 0) {
    console.log('  ~ documents already seeded, skipping')
  } else {
    const adminMaksym = byEmail['yaremenkomaksym99@gmail.com']
    const oleksiy = byEmail['oleksiy.kovalenko@cheekycheese.dev']
    const dmytro = byEmail['dmytro.marchenko@cheekycheese.dev']
    const sofia = byEmail['sofia.bondarenko@cheekycheese.dev']
    const ivan = byEmail['ivan.petrenko@cheekycheese.dev']
    const anna = byEmail['anna.lysenko@cheekycheese.dev']
    const kateryna = byEmail['kateryna.shevchenko@cheekycheese.dev']
    const mykola = byEmail['mykola.savchenko@cheekycheese.dev']

    if (adminMaksym && oleksiy && dmytro && sofia && ivan && anna && kateryna && mykola) {
      // Resolve the on-disk fixture once. Path is relative to this source
      // file so it works regardless of where `pnpm db:seed` was invoked from.
      // `sample-receipt-real.pdf` is a 143 KB real PDF supplied by the
      // product owner — we use it as the single sample for every PDF row
      // (RESUME / CONTRACT / RECEIPT). Image fixtures live in the same dir
      // but we keep them per-category (passport / receipt) for variety.
      const fixturesDir = join(__dirname, 'seed-fixtures')
      const samplePdfPath = join(fixturesDir, 'sample-receipt-real.pdf')
      const samplePdfBytes: Buffer | null = existsSync(samplePdfPath)
        ? readFileSync(samplePdfPath)
        : null
      const samplePdfSize = samplePdfBytes?.length ?? 50_000

      // Default originalName per category — uses the doc owner's first name
      // so a quick glance at the documents grid still tells you whose file
      // it is. Cyrillic on purpose (matches user-uploaded names).
      const originalNameFor = (
        category: schema.NewDocument['category'],
        owner: typeof oleksiy,
        ext: string,
      ): string => {
        const first = owner.displayName.split(' ')[0] ?? 'Файл'
        if (category === 'RESUME') return `Резюме ${first}.${ext}`
        if (category === 'CONTRACT') return `Договор ${first}.${ext}`
        if (category === 'RECEIPT') return `Чек ${first}.${ext}`
        if (category === 'SCAN') return `Скан ${first}.${ext}`
        return `${category} ${first}.${ext}`
      }

      // For each row we mint a UUID so the s3_key embeds the doc id (matches
      // production `documents/<category>/<owner>/<docId>-<file>` pattern,
      // just under the `seed/` namespace so prod buckets can't collide).
      const mintRow = (
        category: schema.NewDocument['category'],
        owner: typeof oleksiy,
        opts: {
          projectId?: string
          uploadedBy?: string
          ext?: 'pdf' | 'jpg' | 'png'
          mime?: string
          name?: string
        } = {},
      ): schema.NewDocument => {
        const id = crypto.randomUUID()
        const ext = opts.ext ?? (category === 'SCAN' || category === 'RECEIPT' ? 'jpg' : 'pdf')
        const mime = opts.mime ?? (ext === 'pdf' ? 'application/pdf' : ext === 'jpg' ? 'image/jpeg' : 'image/png')
        const name = opts.name ?? `${category.toLowerCase()}-${owner.displayName.split(' ')[0]?.toLowerCase() ?? 'doc'}.${ext}`
        return {
          id,
          ownerId: owner.id,
          projectId: opts.projectId ?? null,
          category,
          name,
          originalName: originalNameFor(category, owner, ext),
          s3Key: `documents/seed/${id}.${ext}`,
          // PDFs use the real fixture size (143 KB); images keep the
          // synthetic 50 KB placeholder until we wire real image fixtures.
          sizeBytes: ext === 'pdf' ? samplePdfSize : 50_000,
          mimeType: mime,
          uploadedBy: opts.uploadedBy ?? owner.id,
        }
      }

      const allProjects = await db.select().from(schema.projects)
      const byProjectName = Object.fromEntries(allProjects.map((p) => [p.name, p]))

      const docs: schema.NewDocument[] = []

      // RESUME (6) — one per ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT, self-uploaded
      docs.push(mintRow('RESUME', adminMaksym))
      docs.push(mintRow('RESUME', oleksiy))
      docs.push(mintRow('RESUME', dmytro))
      docs.push(mintRow('RESUME', sofia))
      docs.push(mintRow('RESUME', ivan))
      docs.push(mintRow('RESUME', anna))

      // SCAN (6) — one per several users; mix self-upload and HR-uploaded-for-other
      docs.push(mintRow('SCAN', adminMaksym))
      docs.push(mintRow('SCAN', oleksiy))
      docs.push(mintRow('SCAN', dmytro))
      docs.push(mintRow('SCAN', sofia, { uploadedBy: anna.id }))  // HR uploaded for junior
      docs.push(mintRow('SCAN', ivan, { uploadedBy: anna.id }))   // HR uploaded for junior
      docs.push(mintRow('SCAN', kateryna))

      // CONTRACT (4) — one per active project; ownerId = senior, projectId set
      const aiProject = byProjectName['AI Platform v2']
      const edtechProject = byProjectName['EdTech LMS']
      const fermProject = byProjectName['Ferm Project']
      const onePunchProject = byProjectName['One Punch']
      if (aiProject) docs.push(mintRow('CONTRACT', oleksiy, { projectId: aiProject.id }))
      if (edtechProject) docs.push(mintRow('CONTRACT', dmytro, { projectId: edtechProject.id }))
      if (fermProject) docs.push(mintRow('CONTRACT', adminMaksym, { projectId: fermProject.id }))
      if (onePunchProject) docs.push(mintRow('CONTRACT', adminMaksym, { projectId: onePunchProject.id }))

      // RECEIPT (12) — owner = sender of the transaction. We don't write the
      // FK transactions.receipt_document_id here (that column does not exist
      // until migration 0011 in task-finance-receipt-integration). Just
      // create the document rows so the API + UI tests have data to read.
      // SENIOR receipts (oleksiy / dmytro × several txns)
      for (let i = 0; i < 4; i++) docs.push(mintRow('RECEIPT', oleksiy))
      for (let i = 0; i < 4; i++) docs.push(mintRow('RECEIPT', dmytro))
      // ADMIN receipts (Maksym for his own admin-income txns)
      for (let i = 0; i < 4; i++) docs.push(mintRow('RECEIPT', adminMaksym))

      await db.insert(schema.documents).values(docs)
      console.log(`  + seeded ${docs.length} documents (RESUME/SCAN/CONTRACT/RECEIPT)`)

      // Best-effort: push the real sample PDF into MinIO under each PDF
      // row's s3_key. Image-MIME rows are skipped (the fixture is a PDF;
      // they keep their broken thumbnail). Failure here is non-fatal —
      // missing env vars or a MinIO outage just yields a warn line.
      const s3Endpoint = process.env['S3_ENDPOINT']
      const s3Bucket = process.env['S3_BUCKET']
      const s3AccessKey = process.env['AWS_ACCESS_KEY_ID']
      const s3SecretKey = process.env['AWS_SECRET_ACCESS_KEY']
      if (samplePdfBytes && s3Endpoint && s3Bucket && s3AccessKey && s3SecretKey) {
        const s3 = new S3Client({
          region: process.env['S3_REGION'] ?? 'us-east-1',
          endpoint: s3Endpoint,
          forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
          credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey },
        })
        let uploaded = 0
        let skipped = 0
        let failed = 0
        for (const d of docs) {
          if (d.mimeType !== 'application/pdf') {
            skipped += 1
            continue
          }
          try {
            await s3.send(
              new PutObjectCommand({
                Bucket: s3Bucket,
                Key: d.s3Key,
                Body: samplePdfBytes,
                ContentType: 'application/pdf',
                CacheControl: 'public, max-age=31536000, immutable',
              }),
            )
            uploaded += 1
          } catch (err) {
            failed += 1
            if (failed === 1) {
              // Log only the first failure to avoid a flood — the seed
              // can still finish even if MinIO is unhappy.
              console.warn(
                `  ! S3 upload failed for ${d.s3Key}: ${(err as Error).message}`,
              )
            }
          }
        }
        console.log(
          `  + S3: ${uploaded} PDF uploaded, ${skipped} image rows skipped` +
            (failed ? `, ${failed} failed` : ''),
        )
      } else if (!samplePdfBytes) {
        console.warn(
          `  ! sample-receipt-real.pdf missing at ${samplePdfPath} — skipped S3 uploads`,
        )
      } else {
        console.log(
          '  ~ S3 env vars not set (S3_ENDPOINT/S3_BUCKET/AWS_*) — skipped S3 uploads',
        )
      }
    } else {
      console.warn('  ! Missing required seed users — documents seed skipped')
    }
  }

  await pool.end()
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
