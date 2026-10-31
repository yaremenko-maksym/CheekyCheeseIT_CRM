/**
 * CLI for humans: lists employer-board tokens found in stored source-record URLs that no board file
 * lists yet (ADR 8a, U8b). Reads the database at DATABASE_URL with one SELECT; sends no request.
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @crm/api job-sources:boards:discover
 *
 * Output is aggregate only: provider, token, opportunity count, match count.
 */
import { Pool } from 'pg'
import { discoverBoardTokens, queryablePool } from './board-discovery'

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL is not set')
  const pool = new Pool({ connectionString: url })
  try {
    const found = await discoverBoardTokens(queryablePool(pool))
    console.log('provider\ttoken\topportunities\tmatches')
    for (const b of found)
      console.log(`${b.provider}\t${b.token}\t${b.opportunities}\t${b.matches}`)
  } finally {
    await pool.end()
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
