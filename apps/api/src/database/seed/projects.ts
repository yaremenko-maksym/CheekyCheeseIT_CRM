import * as schema from '../schema'
import {
  MAKSYM_ID,
  OLEKSIY_ID,
  DMYTRO_ID,
  SOFIA_ID,
  IVAN_ID,
  OKSANA_ID,
  YURIY_ID,
  LENA_ID,
  ARTEM_ID,
  NAZAR_ID,
  DROP1_ID,
} from './ids'
import { d } from './shared'
import type { SeedCtx, SeedProjectIds } from './shared'

export async function seedProjects({ db }: SeedCtx): Promise<SeedProjectIds> {
  // ---- 4. Projects (~8) ----
  console.log('\n[4/8] Inserting projects...')

  // Project 1: TechCorp AI — Oleksiy, Sofia (CLOSED Jul 2025 – Nov 2025)
  const proj1Rows = await db
    .insert(schema.projects)
    .values({
      name: 'AI Platform v2',
      companyName: 'TechCorp AI',
      domain: 'ai-techcorp.io',
      startDate: d(2025, 6, 10),
      seniorId: OLEKSIY_ID,
      rate: 5000,
      currency: 'USDT',
      techStack: 'Python, TensorFlow, FastAPI, PostgreSQL',
      archivedAt: d(2025, 11, 30),
      createdAt: d(2025, 6, 10),
      updatedAt: d(2025, 11, 30),
    })
    .returning()
  const proj1 = proj1Rows[0]!
  // Sofia was active member, left when project closed
  await db.insert(schema.projectMembers).values({
    projectId: proj1.id,
    userId: SOFIA_ID,
    joinedAt: d(2025, 6, 10),
    leftAt: d(2025, 11, 30),
  })

  // Project 2: LearnSpace LMS — Oleksiy (ACTIVE, Jan 2026–)
  const proj2Rows = await db
    .insert(schema.projects)
    .values({
      name: 'LearnSpace LMS',
      companyName: 'LearnSpace Inc',
      domain: 'learnspace.io',
      startDate: d(2026, 1, 5),
      seniorId: OLEKSIY_ID,
      rate: 4500,
      currency: 'USD',
      techStack: 'React, Node.js, PostgreSQL, Redis',
      createdAt: d(2026, 1, 5),
      updatedAt: d(2026, 1, 5),
    })
    .returning()
  const proj2 = proj2Rows[0]!
  // Sofia is active junior on proj2
  await db.insert(schema.projectMembers).values({
    projectId: proj2.id,
    userId: SOFIA_ID,
    joinedAt: d(2026, 1, 5),
  })

  // Project 3: Ferm E-Commerce — Dmytro (ACTIVE, Jul 2025–)
  const proj3Rows = await db
    .insert(schema.projects)
    .values({
      name: 'Ferm E-Commerce',
      companyName: 'Ferm',
      domain: 'ferm.ua',
      startDate: d(2025, 7, 15),
      seniorId: DMYTRO_ID,
      rate: 3500,
      currency: 'USD',
      techStack: 'Vue.js, Python, Django, PostgreSQL',
      createdAt: d(2025, 7, 15),
      updatedAt: d(2025, 7, 15),
    })
    .returning()
  const proj3 = proj3Rows[0]!
  // Oksana is active junior on proj3
  await db.insert(schema.projectMembers).values({
    projectId: proj3.id,
    userId: OKSANA_ID,
    joinedAt: d(2025, 8, 20),
  })

  // Project 4: OnePunch SaaS — Artem (ACTIVE, Sep 2025–)
  const proj4Rows = await db
    .insert(schema.projects)
    .values({
      name: 'OnePunch Dashboard',
      companyName: 'One Punch',
      domain: 'onepunch.app',
      startDate: d(2025, 9, 1),
      seniorId: ARTEM_ID,
      rate: 4000,
      currency: 'USD',
      techStack: 'React, Next.js, TypeScript, Go',
      createdAt: d(2025, 9, 1),
      updatedAt: d(2025, 9, 1),
    })
    .returning()
  const proj4 = proj4Rows[0]!
  // Yuriy is active junior on proj4
  await db.insert(schema.projectMembers).values({
    projectId: proj4.id,
    userId: YURIY_ID,
    joinedAt: d(2025, 10, 5),
  })

  // Project 5: Artkai Design System — Artem (CLOSED, Aug–Dec 2025)
  const proj5Rows = await db
    .insert(schema.projects)
    .values({
      name: 'Artkai Design System',
      companyName: 'Artkai',
      domain: 'artkai.io',
      startDate: d(2025, 8, 15),
      seniorId: ARTEM_ID,
      rate: 4200,
      currency: 'USD',
      techStack: 'React, Storybook, Figma API',
      archivedAt: d(2025, 12, 31),
      createdAt: d(2025, 8, 15),
      updatedAt: d(2025, 12, 31),
    })
    .returning()
  const proj5 = proj5Rows[0]!
  // Lena was junior, left when project closed
  await db.insert(schema.projectMembers).values({
    projectId: proj5.id,
    userId: LENA_ID,
    joinedAt: d(2025, 12, 10),
    leftAt: d(2025, 12, 31),
  })

  // Project 6: CloudOps Platform — Nazar (ACTIVE, Oct 2025–)
  const proj6Rows = await db
    .insert(schema.projects)
    .values({
      name: 'CloudOps Platform',
      companyName: 'CloudOps UA',
      domain: 'cloudops.ua',
      startDate: d(2025, 10, 15),
      seniorId: NAZAR_ID,
      rate: 5500,
      currency: 'USDT',
      techStack: 'NestJS, Kubernetes, Terraform, AWS',
      createdAt: d(2025, 10, 15),
      updatedAt: d(2025, 10, 15),
    })
    .returning()
  const proj6 = proj6Rows[0]!
  // Lena is active junior on proj6 (she joined Jan 2026)
  await db.insert(schema.projectMembers).values({
    projectId: proj6.id,
    userId: LENA_ID,
    joinedAt: d(2026, 1, 15),
  })

  // Project 7: FinTrack Mobile — Nazar (ACTIVE, Feb 2026–)
  await db.insert(schema.projects).values({
    name: 'FinTrack Mobile',
    companyName: 'FinTrack Ltd',
    domain: 'fintrack.app',
    startDate: d(2026, 2, 1),
    seniorId: NAZAR_ID,
    rate: 5000,
    currency: 'USDT',
    techStack: 'NestJS, React Native, PostgreSQL',
    createdAt: d(2026, 2, 1),
    updatedAt: d(2026, 2, 1),
  })

  // Project 8: Oleksiy solo (ADMIN-owned context not applicable for Oleksiy)
  // Keeping 8 projects total
  const proj8Rows = await db
    .insert(schema.projects)
    .values({
      name: 'RetailPOS Integration',
      companyName: 'RetailTech UA',
      domain: 'retailtech.ua',
      startDate: d(2025, 11, 1),
      seniorId: OLEKSIY_ID,
      rate: 3800,
      currency: 'USD',
      techStack: 'Node.js, React, REST API',
      createdAt: d(2025, 11, 1),
      updatedAt: d(2025, 11, 1),
    })
    .returning()
  const proj8 = proj8Rows[0]!
  // Ivan is active junior on proj8 (Ivan is un-onboarded but can be member)
  await db.insert(schema.projectMembers).values({
    projectId: proj8.id,
    userId: IVAN_ID,
    joinedAt: d(2025, 11, 1),
  })

  // Admin-projects: Maksym acts as senior (task-admin-as-senior)
  // Project 9: NeuroEdge AI — admin-as-senior (ACTIVE, Mar 2026–)
  const adminProj1Rows = await db
    .insert(schema.projects)
    .values({
      name: 'NeuroEdge AI',
      companyName: 'NeuroEdge Labs',
      domain: 'neuroedge.ai',
      startDate: d(2026, 3, 1),
      seniorId: MAKSYM_ID,
      rate: 6000,
      currency: 'USDT',
      techStack: 'Python, PyTorch, FastAPI, React',
      createdAt: d(2026, 3, 1),
      updatedAt: d(2026, 3, 1),
    })
    .returning()
  const adminProj1 = adminProj1Rows[0]!
  // Sofia is active junior on adminProj1
  await db.insert(schema.projectMembers).values({
    projectId: adminProj1.id,
    userId: SOFIA_ID,
    joinedAt: d(2026, 3, 1),
  })
  // Legend for adminProj1 — persona so JUNIOR sees "Олексій Маринченко" not Maksym
  const adminProj1LegendRows = await db
    .insert(schema.legends)
    .values({
      projectId: adminProj1.id,
      fullName: 'Олексій Маринченко',
      presentedRole: 'Senior Full-Stack Engineer',
      presentedStack: 'Python, PyTorch, FastAPI',
      backstory: 'Досвідчений AI-інженер з 7 роками у сфері ML/DL рішень',
      createdAt: d(2026, 3, 1),
      updatedAt: d(2026, 3, 1),
    })
    .returning()
  const adminProj1Legend = adminProj1LegendRows[0]!
  await db.insert(schema.legendEntries).values({
    legendId: adminProj1Legend.id,
    authorId: MAKSYM_ID,
    text: 'Загальна персона для проекту NeuroEdge AI. Джун бачить цей аккаунт замість реального синьора.',
    createdAt: d(2026, 3, 1),
  })

  // Project 10: EduFlow Platform — admin-as-senior (ACTIVE, Apr 2026–)
  const adminProj2Rows = await db
    .insert(schema.projects)
    .values({
      name: 'EduFlow Platform',
      companyName: 'EduFlow EdTech',
      domain: 'eduflow.app',
      startDate: d(2026, 4, 1),
      seniorId: MAKSYM_ID,
      rate: 4800,
      currency: 'USD',
      techStack: 'React, NestJS, PostgreSQL, Redis',
      createdAt: d(2026, 4, 1),
      updatedAt: d(2026, 4, 1),
    })
    .returning()
  const adminProj2 = adminProj2Rows[0]!
  // Oksana as junior on adminProj2 (JUNIOR, distinct from SOFIA on adminProj1 and NeuroEdge)
  await db.insert(schema.projectMembers).values({
    projectId: adminProj2.id,
    userId: OKSANA_ID,
    joinedAt: d(2026, 4, 1),
  })
  // Legend for adminProj2
  const adminProj2LegendRows = await db
    .insert(schema.legends)
    .values({
      projectId: adminProj2.id,
      fullName: 'Дмитро Савченко',
      presentedRole: 'Senior Frontend Engineer',
      presentedStack: 'React, TypeScript, TailwindCSS',
      backstory: 'Спеціаліст у EdTech-продуктах із досвідом у дизайн-системах',
      createdAt: d(2026, 4, 1),
      updatedAt: d(2026, 4, 1),
    })
    .returning()
  const adminProj2Legend = adminProj2LegendRows[0]!
  await db.insert(schema.legendEntries).values({
    legendId: adminProj2Legend.id,
    authorId: MAKSYM_ID,
    text: 'Персона для EduFlow Platform. Джун бачить Дмитра Савченка замість Maksym Yaremenko.',
    createdAt: d(2026, 4, 1),
  })

  // Project 11: USDT DropVault — a USDT-payment project with a NON-admin senior
  // (Nazar) + a bound DROP (Viktor / DROP1). task-drop-share-override-and-receiver
  // (C10): gives dev/E2E a fixture to exercise the admin-USDT declaration flow
  // (POST /api/finance/usdt-income → SENIOR_PENDING_PAYOUT + DROP_PENDING_PAYOUT
  // obligations → settleByCompany). GamingTec is intentionally NOT seeded (it is a
  // prod-only project handled by the manual migration).
  await db.insert(schema.projects).values({
    name: 'USDT DropVault',
    companyName: 'DropVault Labs',
    // task-drop-share-override-and-receiver review round 1 (LOW-3, security):
    // `domain` must be a valid IT_DOMAINS enum member (itDomainSchema) — the
    // free-text 'dropvault.io' is not, and would fail Zod parse on the wire.
    domain: 'Web3 / Crypto',
    startDate: d(2026, 3, 1),
    seniorId: NAZAR_ID,
    dropId: DROP1_ID,
    rate: 6000,
    currency: 'USDT',
    paymentType: 'USDT',
    techStack: 'Node.js, Solidity, ethers.js',
    createdAt: d(2026, 3, 1),
    updatedAt: d(2026, 3, 1),
  })

  console.log(
    '  ✓ 11 projects (incl. 2 admin-as-senior + 1 USDT drop-project) + members + legends inserted',
  )

  return { proj1Id: proj1.id, proj2Id: proj2.id, proj4Id: proj4.id, proj6Id: proj6.id }
}
