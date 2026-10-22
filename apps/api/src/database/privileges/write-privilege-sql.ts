/**
 * CLI: writes the generated privilege SQL files.
 *
 *   pnpm --filter @crm/api db:privileges:generate
 *
 * `generate-privilege-sql.spec.ts` fails when the committed files differ from what the
 * generator produces, so running this is part of any change to `privilege-classes.ts`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECK_FILE, GRANTS_FILE, buildCheckSql, buildGrantsSql } from './generate-privilege-sql'

export const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')

function main(): void {
  for (const [file, body] of [
    [GRANTS_FILE, buildGrantsSql()],
    [CHECK_FILE, buildCheckSql()],
  ] as const) {
    const path = join(MANUAL_DIR, file)
    writeFileSync(path, body, 'utf8')
    process.stdout.write(`wrote ${path}\n`)
  }
}

main()
