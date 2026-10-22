import * as schema from '../schema'
import {
  ANNA_ID,
  OLEKSIY_ID,
  MYKOLA_ID,
  KATERYNA_ID,
  DMYTRO_ID,
  HR3_ID,
  ARTEM_ID,
  NAZAR_ID,
  DROP1_ID,
  DROP2_ID,
  DROP3_ID,
  DROP4_ID,
  DROP5_ID,
  DROP6_ID,
} from './ids'
import { d } from './shared'
import type { SeedCtx } from './shared'

export async function seedTeams({ db }: SeedCtx): Promise<void> {
  // ---- 3. Teams ----
  console.log('\n[3/8] Inserting teams...')

  // Team 1: Oleksiy's team (Anna HR)
  const team1Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Kovalenko',
      type: 'SENIOR',
      telegram: '@team_kovalenko',
      notes: 'AI/ML та EdTech проекти',
      createdAt: d(2025, 6, 5),
      updatedAt: d(2025, 6, 5),
    })
    .returning()
  const team1 = team1Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team1.id, userId: ANNA_ID, joinedAt: d(2025, 6, 5) },
    { teamId: team1.id, userId: OLEKSIY_ID, joinedAt: d(2025, 6, 5) },
    { teamId: team1.id, userId: MYKOLA_ID, joinedAt: d(2025, 6, 5) },
  ])

  // Team 2: Dmytro's team (Kateryna HR) — Dmytro is un-onboarded but team exists
  const team2Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Marchenko',
      type: 'SENIOR',
      telegram: '@team_marchenko',
      notes: 'Фінтех та SaaS',
      createdAt: d(2025, 7, 1),
      updatedAt: d(2025, 7, 1),
    })
    .returning()
  const team2 = team2Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team2.id, userId: KATERYNA_ID, joinedAt: d(2025, 7, 1) },
    { teamId: team2.id, userId: DMYTRO_ID, joinedAt: d(2025, 7, 1) },
    { teamId: team2.id, userId: MYKOLA_ID, joinedAt: d(2025, 7, 1) },
  ])

  // Team 3: Artem's team (Daryna HR)
  const team3Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Kravchenko',
      type: 'SENIOR',
      telegram: '@team_kravchenko',
      notes: 'E-Commerce та мобайл',
      createdAt: d(2025, 8, 15),
      updatedAt: d(2025, 8, 15),
    })
    .returning()
  const team3 = team3Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team3.id, userId: HR3_ID, joinedAt: d(2025, 8, 15) },
    { teamId: team3.id, userId: ARTEM_ID, joinedAt: d(2025, 8, 15) },
    { teamId: team3.id, userId: MYKOLA_ID, joinedAt: d(2025, 8, 15) },
  ])

  // Team 4: Nazar's team (Anna HR also manages)
  const team4Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Ponomarenko',
      type: 'SENIOR',
      telegram: '@team_ponomarenko',
      notes: 'DevOps та Cloud-проекти',
      createdAt: d(2025, 10, 1),
      updatedAt: d(2025, 10, 1),
    })
    .returning()
  const team4 = team4Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team4.id, userId: ANNA_ID, joinedAt: d(2025, 10, 1) },
    { teamId: team4.id, userId: NAZAR_ID, joinedAt: d(2025, 10, 1) },
    { teamId: team4.id, userId: MYKOLA_ID, joinedAt: d(2025, 10, 1) },
  ])
  console.log('  ✓ 4 teams + members inserted')

  // ---- Drop-teams (6) — task-drop-1-backend AC3 ----
  // Each of the 6 seed DROPs must belong to their OWN drop-team so the
  // drop-facing surfaces (teams list, «Мой проект» hub) have data for the
  // phase-2 UT. Mirrors the product flow `TeamsService.createDropTeam`
  // exactly: type='DROP', name='Команда <displayName>', members = drop + HR(s)
  // + the single ACCOUNTANT. No SENIOR by default (createDropTeam adds none).
  // The 3 HRs are spread across the 6 drops; MYKOLA is the only accountant.
  const dropTeamSeed: { dropId: string; name: string; hrId: string; joinedAt: Date }[] = [
    { dropId: DROP1_ID, name: 'Команда Viktor Drozhzhyn', hrId: ANNA_ID, joinedAt: d(2025, 7, 1) },
    {
      dropId: DROP2_ID,
      name: 'Команда Olena Drozdova',
      hrId: KATERYNA_ID,
      joinedAt: d(2025, 7, 15),
    },
    { dropId: DROP3_ID, name: 'Команда Roman Drobotenko', hrId: HR3_ID, joinedAt: d(2025, 8, 1) },
    { dropId: DROP4_ID, name: 'Команда Marta Drozd', hrId: ANNA_ID, joinedAt: d(2025, 9, 1) },
    { dropId: DROP5_ID, name: 'Команда Serhiy Drofa', hrId: KATERYNA_ID, joinedAt: d(2025, 9, 15) },
    { dropId: DROP6_ID, name: 'Команда Tamara Drobysh', hrId: HR3_ID, joinedAt: d(2025, 10, 1) },
  ]
  for (const dt of dropTeamSeed) {
    const dropTeamRows = await db
      .insert(schema.teams)
      .values({
        name: dt.name,
        type: 'DROP',
        notes: 'Drop payment-routing team',
        createdAt: dt.joinedAt,
        updatedAt: dt.joinedAt,
      })
      .returning()
    const dropTeam = dropTeamRows[0]!
    await db.insert(schema.teamMembers).values([
      { teamId: dropTeam.id, userId: dt.dropId, joinedAt: dt.joinedAt },
      { teamId: dropTeam.id, userId: dt.hrId, joinedAt: dt.joinedAt },
      { teamId: dropTeam.id, userId: MYKOLA_ID, joinedAt: dt.joinedAt },
    ])
  }
  console.log('  ✓ 6 drop-teams + members inserted')
}
