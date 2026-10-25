import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * r5 Task 2.5 T3 AC 7 — THE WRITE GATE for "Who writes which column" (ADR, Option A). A source file
 * that writes one of the ledger's columns, the host table or the meter tables, and is not that
 * column's one named writer, fails this spec. `*.spec.ts` and `src/test/**` are excluded (fixtures
 * write rows directly on purpose), as are the schema declarations, which define rather than write.
 *
 * It reads statements, not imports: a raw `INSERT INTO` / `UPDATE` naming the table, or a drizzle
 * `.insert(table)` / `.update(table)`. For `job_sources` only the ledger-owned columns count, because
 * other modules legitimately write other columns of that table (the legacy budget, the seed).
 */
const SRC = join(__dirname, '..', '..')

const LEDGER = 'job-sourcing/ownership/job-run-ledger.ts'
const HOSTS = 'job-sourcing/scheduling/host-state.ts'
const METER = 'job-sourcing/metering/account-meter.store.ts'

interface WholeTable {
  readonly sql: string
  readonly drizzle: string
  readonly writer: string
}

/** Tables every column of which has exactly one writer. */
const WHOLE_TABLES: readonly WholeTable[] = [
  { sql: 'job_collection_runs', drizzle: 'jobCollectionRuns', writer: LEDGER },
  { sql: 'job_source_hosts', drizzle: 'jobSourceHosts', writer: HOSTS },
  { sql: 'job_account_meters', drizzle: 'jobAccountMeters', writer: METER },
  { sql: 'job_account_meter_reservations', drizzle: 'jobAccountMeterReservations', writer: METER },
]

/** The `job_sources` columns only the ledger writes (and `admin_state_history` via resetFailures). */
const LEDGER_SOURCE_COLUMNS: readonly (readonly [string, string])[] = [
  ['next_attempt_at', 'nextAttemptAt'],
  ['cooldown_until', 'cooldownUntil'],
  ['consecutive_failures', 'consecutiveFailures'],
  ['last_attempt_at', 'lastAttemptAt'],
  ['last_success_at', 'lastSuccessAt'],
  ['last_nonempty_at', 'lastNonemptyAt'],
  ['last_error_code', 'lastErrorCode'],
  ['last_error_message', 'lastErrorMessage'],
]

interface Violation {
  readonly file: string
  readonly what: string
}

/** The text of every write statement in `text` that targets `table` (raw SQL or drizzle). */
function writeWindows(text: string, sqlName: string, drizzleName: string): string[] {
  const windows: string[] = []
  const raw = new RegExp(`\\b(INSERT\\s+INTO|UPDATE)\\s+${sqlName}\\b`, 'gi')
  const orm = new RegExp(`\\.(insert|update)\\(\\s*${drizzleName}\\s*\\)`, 'g')
  for (const re of [raw, orm]) {
    for (const m of text.matchAll(re)) {
      // A raw statement ends at its template's closing backtick; a drizzle chain is read for the
      // next 800 characters, which covers its `.set({...})` / `.values({...})`.
      const start = m.index ?? 0
      const end = re === raw ? text.indexOf('`', start + 1) : start + 800
      windows.push(text.slice(start, end === -1 ? undefined : end))
    }
  }
  return windows
}

/** The violations in one file's text, `file` being its path relative to `src/`. */
function scanForForeignWrites(file: string, text: string): Violation[] {
  const found: Violation[] = []
  for (const t of WHOLE_TABLES) {
    if (file === t.writer) continue
    if (writeWindows(text, t.sql, t.drizzle).length > 0) found.push({ file, what: t.sql })
  }
  if (file !== LEDGER) {
    for (const w of writeWindows(text, 'job_sources', 'jobSources')) {
      for (const [snake, camel] of LEDGER_SOURCE_COLUMNS) {
        if (new RegExp(`\\b(${snake}|${camel})\\b`).test(w)) {
          found.push({ file, what: `job_sources.${snake}` })
        }
      }
      if (
        /\badmin_state_history\b[^,]*RESET_FAILURES|RESET_FAILURES[\s\S]*admin_state_history/.test(
          w,
        )
      ) {
        found.push({ file, what: 'job_sources.admin_state_history RESET_FAILURES' })
      }
    }
  }
  return found
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__test-helpers__') continue
      out.push(...sourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const rel = (full: string) => relative(SRC, full).split(sep).join('/')

describe('the write gate (T3 AC 7)', () => {
  it('no file outside a column`s named writer writes it', () => {
    const files = sourceFiles(SRC)
      .map(rel)
      .filter((f) => !f.startsWith('test/') && !f.startsWith('database/schema'))
    // The scan must actually have read the tree, or an empty result proves nothing.
    expect(files).toContain(LEDGER)
    expect(files).toContain(METER)
    expect(files.length).toBeGreaterThan(200)
    const violations = files.flatMap((f) =>
      scanForForeignWrites(f, readFileSync(join(SRC, f), 'utf8')),
    )
    expect(violations).toEqual([])
  })

  it('the named writers really do write what they own (the gate is reading the right text)', () => {
    const read = (f: string) => readFileSync(join(SRC, f), 'utf8')
    expect(
      writeWindows(read(LEDGER), 'job_collection_runs', 'jobCollectionRuns').length,
    ).toBeGreaterThan(0)
    expect(writeWindows(read(HOSTS), 'job_source_hosts', 'jobSourceHosts').length).toBeGreaterThan(
      0,
    )
    expect(
      writeWindows(read(METER), 'job_account_meters', 'jobAccountMeters').length,
    ).toBeGreaterThan(0)
  })

  describe('it fails on a foreign writer', () => {
    it.each([
      [
        'a raw run update',
        "sql`UPDATE job_collection_runs SET outcome = 'FAILED'`",
        'job_collection_runs',
      ],
      [
        'a drizzle run insert',
        'await tx.insert(jobCollectionRuns).values(row)',
        'job_collection_runs',
      ],
      [
        'a host write',
        'sql`INSERT INTO job_source_hosts (host_key) VALUES (1)`',
        'job_source_hosts',
      ],
      ['a meter write', 'db.update(jobAccountMeters).set({ used: 0 })', 'job_account_meters'],
      [
        'a reservation write',
        "sql`UPDATE job_account_meter_reservations SET status = 'USED'`",
        'job_account_meter_reservations',
      ],
      [
        'a raw source backoff write',
        'sql`UPDATE job_sources SET cooldown_until = now() WHERE id = 1`',
        'job_sources.cooldown_until',
      ],
      [
        'a drizzle source counter write',
        'db.update(jobSources).set({ consecutiveFailures: 0 })',
        'job_sources.consecutive_failures',
      ],
    ])('%s', (_label, text, what) => {
      expect(scanForForeignWrites('job-sourcing/elsewhere.ts', text)).toEqual([
        { file: 'job-sourcing/elsewhere.ts', what },
      ])
    })

    it('a source write of a column the ledger does not own passes', () => {
      expect(
        scanForForeignWrites(
          'job-sourcing/elsewhere.ts',
          'db.update(jobSources).set({ budgetUsed: 1 })',
        ),
      ).toEqual([])
    })

    it('a read of the table is not a write', () => {
      expect(
        scanForForeignWrites('job-sourcing/elsewhere.ts', 'sql`SELECT * FROM job_collection_runs`'),
      ).toEqual([])
    })

    it('the named writer itself passes', () => {
      expect(
        scanForForeignWrites(LEDGER, "sql`UPDATE job_collection_runs SET outcome = 'FAILED'`"),
      ).toEqual([])
    })
  })
})
