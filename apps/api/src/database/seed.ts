import { drizzle } from 'drizzle-orm/node-postgres'

import { Pool } from 'pg'
import * as schema from './schema'
import { loadEnvQuietly } from './load-env-quietly'
import { assertSeedTargetIsDisposable } from './seed-db-guard'
import { seedUsers } from './seed/users'
import { seedTeams } from './seed/teams'
import { seedProjects } from './seed/projects'
import { seedInterviews } from './seed/interviews'
import { seedFinance } from './seed/finance'
import { seedOnboarding } from './seed/onboarding'
import { verifySeed } from './seed/verify'
import type { SeedCtx } from './seed/shared'

// Snapshot BEFORE loadEnvQuietly() below — see seed-db-guard.ts's
// SEED_CONFIRM_LIVE_DB_NAME doc (security review on PR #576, 2026-08-18,
// LOW-2): dotenv never overrides an already-set process.env var, so
// anything present in THIS snapshot came from the real shell invocation,
// never from apps/api/.env. Passed to assertSeedTargetIsDisposable() below
// as the sole source for the escape-hatch confirmation, so setting the
// confirmation once in .env cannot make it silently permanent.
const preDotenvEnv: NodeJS.ProcessEnv = { ...process.env }

// task-backlog-hygiene-batch (item 7/56): see load-env-quietly.ts for why
// this is a separate, unit-tested function rather than an inline call —
// this file's `main().catch(...)` at the bottom runs unconditionally on
// import, which is what left the inline version uncovered and let the
// mutation gate's own security review catch it surviving (round on #534).
loadEnvQuietly()

// ---------------------------------------------------------------------------
// Canonical UUIDs — must stay stable across reseeds (e2e fixtures + dev-login).
// Defined in ./seed/ids; the two public ones stay importable from this path.
// ---------------------------------------------------------------------------
export { MAKSYM_ID, KOSTYA_ID } from './seed/ids'

// ---------------------------------------------------------------------------
// Main seed function — orchestrates the phase modules in ./seed/ in order.
// ---------------------------------------------------------------------------
async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')

  // Must run before opening any connection, let alone the TRUNCATE below —
  // see seed-db-guard.ts for the incident this closes. `preDotenvEnv` (see
  // above) is the confirmation source — see that file's LOW-2 doc.
  assertSeedTargetIsDisposable(databaseUrl, process.env, preDotenvEnv)

  const pool = new Pool({ connectionString: databaseUrl })
  const db = drizzle(pool, { schema })

  console.log('=== Seeding 12-month realistic dataset ===')

  const ctx: SeedCtx = { db }

  // ---- 1. Truncate + 2. Users ----
  await seedUsers(ctx)

  // ---- 3. Teams ----
  await seedTeams(ctx)

  // ---- 4. Projects (~8) ----
  const projects = await seedProjects(ctx)

  // ---- 5. Interviews (~12) ----
  await seedInterviews(ctx)

  // ---- 6. Finance — transactions, exchange_rate (+ audit log, company account) ----
  await seedFinance({ ...ctx, projects })

  // ---- 7. Onboarding: ToS + contract templates + signed contracts ----
  await seedOnboarding(ctx)

  // ---- 8. Final verification queries ----
  await verifySeed(ctx)

  await pool.end()
  console.log('\n=== Seed complete ===')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
