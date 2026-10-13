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
}
