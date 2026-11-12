import { sql } from 'drizzle-orm'
import { SEED_QUEUE_OPPORTUNITIES } from './job-queue.data'
import type { SeedCtx } from './shared'

export async function verifySeed({ db }: SeedCtx): Promise<void> {
  // ---- 8. Final verification queries ----
  console.log('\n[8/8] Verification...')
  const userCounts = await db.execute(
    'SELECT role, count(*) FROM users GROUP BY role ORDER BY role' as unknown as Parameters<
      typeof db.execute
    >[0],
  )
  console.log('  Users by role:')
  for (const row of userCounts.rows) {
    const r = row as { role: string; count: string }
    console.log(`    ${r.role}: ${r.count}`)
  }

  const nullLfnRows = (
    await db.execute(
      "SELECT count(*) FROM users WHERE legal_full_name IS NULL AND role <> 'ADMIN'" as unknown as Parameters<
        typeof db.execute
      >[0],
    )
  ).rows as { count: string }[]
  const nullLfn = nullLfnRows[0]?.count ?? '?'
  console.log(`  Users with NULL legal_full_name (non-ADMIN): ${nullLfn} (expected: 0)`)

  // Task 7.6a: the Task 7.6 E2E finds these by title; a missing row or match fails the seed.
  const queueRows = (
    await db.execute(
      sql`SELECT o.title, count(m.senior_id)::int AS leads
            FROM job_opportunities o
            LEFT JOIN job_opportunity_matches m ON m.opportunity_id = o.id AND m.outcome = 'LEAD'
           WHERE o.title IN ${SEED_QUEUE_OPPORTUNITIES.map((o) => o.title)}
           GROUP BY o.title`,
    )
  ).rows as { title: string; leads: number }[]
  const missing = SEED_QUEUE_OPPORTUNITIES.filter(
    (o) => !queueRows.some((r) => r.title === o.title && r.leads === o.leads.length),
  ).map((o) => o.title)
  console.log(
    `  Job-queue seed opportunities: ${queueRows.length} (expected: ${SEED_QUEUE_OPPORTUNITIES.length})`,
  )
  if (missing.length > 0) throw new Error(`job-queue seed incomplete: ${missing.join(', ')}`)
}
