import { afterEach, describe, expect, it, vi } from 'vitest'

// Real dotenv side effects would make this file's behaviour depend on
// whether the machine running it happens to have an apps/api/.env — mocked
// out so runDbPushGuardCli()'s tests below are hermetic regardless (task-
// ci-db-rename-and-dbpush-guard).
vi.mock('./load-env-quietly', () => ({ loadEnvQuietly: vi.fn() }))

import {
  DISPOSABLE_NAME_PREFIX,
  LIVE_DB_NAME,
  SEED_LIVE_DB_CONFIRM_ENV,
  assertDbPushTargetIsDisposable,
  assertSeedTargetIsDisposable,
  extractDbName,
  looksDisposable,
  runDbPushGuardCli,
} from './seed-db-guard'

function urlFor(dbName: string): string {
  return `postgresql://crm_user:password@localhost:5432/${dbName}`
}

describe('extractDbName', () => {
  it('extracts the last path segment', () => {
    expect(extractDbName(urlFor('crm_qa'))).toBe('crm_qa')
  })

  it('percent-decodes (crm%5Fdb is the same database as crm_db to libpq)', () => {
    expect(extractDbName('postgresql://u:p@localhost:5432/crm%5Fdb')).toBe('crm_db')
  })

  it('trims surrounding whitespace after decoding', () => {
    expect(extractDbName('postgresql://u:p@localhost:5432/crm_db%20?sslmode=disable')).toBe(
      'crm_db',
    )
  })

  it('strips a query string (handled by URL.pathname already)', () => {
    expect(extractDbName(urlFor('crm_qa') + '?sslmode=disable')).toBe('crm_qa')
  })

  it('returns empty string for a malformed URL', () => {
    expect(extractDbName('not-a-url')).toBe('')
  })

  it('returns empty string for a URL with no path segment', () => {
    expect(extractDbName('postgresql://crm_user:password@localhost:5432')).toBe('')
  })

  it('falls back to the raw (un-decoded) segment when it is not valid percent-encoding, rather than throwing', () => {
    expect(extractDbName('postgresql://u:p@localhost:5432/crm_qa%zz')).toBe('crm_qa%zz')
  })
})

describe('looksDisposable', () => {
  it.each([
    'crm_qa',
    'crm_scratch',
    'crm_scratch_x',
    'crm_te_scratch',
    'crm_db_scratch',
    'crm_acct_create',
    'crm_hr_dash',
  ])('%s is disposable (crm_-prefixed, not the live name)', (name) => {
    expect(looksDisposable(name)).toBe(true)
  })

  it('the live name itself is NOT disposable', () => {
    expect(looksDisposable(LIVE_DB_NAME)).toBe(false)
  })

  it('is case-sensitive — CRM_DB is a different Postgres identifier from crm_db', () => {
    expect(looksDisposable('CRM_DB')).toBe(false) // does not start with lowercase prefix
  })

  it('a name with no crm_ prefix is not disposable (fail-closed on unrecognized names)', () => {
    expect(looksDisposable('some_other_db')).toBe(false)
  })

  it('empty name is not disposable', () => {
    expect(looksDisposable('')).toBe(false)
  })

  it(`prefix constant matches what the doc comment claims`, () => {
    expect(DISPOSABLE_NAME_PREFIX).toBe('crm_')
  })
})

describe('assertSeedTargetIsDisposable', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('the escape-hatch env var name is the exact string this file documents (not just "truthy")', () => {
    // Guards against the constant itself being gutted: every test above uses
    // the SAME imported symbol as both production code and test code, so a
    // mutated (e.g. emptied) constant would still "work" in every other test
    // here — only a direct value assertion catches that.
    expect(SEED_LIVE_DB_CONFIRM_ENV).toBe('SEED_CONFIRM_LIVE_DB_NAME')
  })

  it('does not throw for a disposable-looking name', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor('crm_qa'), {})).not.toThrow()
  })

  it('does not throw for any other ad-hoc crm_-prefixed scratch name', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor('crm_scratch_x'), {})).not.toThrow()
  })

  it('THROWS for the live db name crm_db, with no override present', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), {})).toThrow(
      /REFUSED: db:seed will not TRUNCATE database 'crm_db'/,
    )
  })

  it('the refusal names the exact database it saw', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), {})).toThrow(/'crm_db'/)
  })

  it('the refusal message contains every distinct piece of guidance text, in full (not just "REFUSED")', () => {
    let thrown: Error | undefined
    try {
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), {})
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeInstanceOf(Error)
    const msg = thrown!.message

    expect(msg).toContain("REFUSED: db:seed will not TRUNCATE database 'crm_db'")
    expect(msg).toContain('does not look disposable')
    expect(msg).toContain(`prefixed scratch/QA name, not exactly '${LIVE_DB_NAME}'`)
    // A blank line separates the "why" paragraph from the "how to override"
    // paragraph — a real \n\n, not just two \n-terminated lines back to back.
    expect(msg).toMatch(/\n\n/)
    expect(msg).toContain('truncates every table before reseeding')
    expect(msg).toContain('want to wipe it on purpose, set:')
    expect(msg).toContain(`${SEED_LIVE_DB_CONFIRM_ENV}=crm_db pnpm --filter @crm/api db:seed`)
    expect(msg).toContain('must equal the exact database name above')
    expect(msg).toContain('apps/api/.env will not work')
    expect(msg).toContain('will not accidentally match')
  })

  it('GITHUB_ACTIONS=true no longer bypasses the guard (removed by task-ci-db-rename-and-dbpush-guard — CI is renamed to crm_ci, which already passes looksDisposable() on its own; see ci.yml/e2e.yml)', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { GITHUB_ACTIONS: 'true' }),
    ).toThrow(/REFUSED/)
  })

  it('plain CI=true does not bypass the guard either (never did — CI is an easy-to-type/easy-to-inherit idiom nothing in this repo exports)', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { CI: 'true' })).toThrow(
      /REFUSED/,
    )
  })

  it('CI=true AND GITHUB_ACTIONS=true together still refuse — no env-var combination bypasses the name check anymore, only the exact-name confirmation below does', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { CI: 'true', GITHUB_ACTIONS: 'true' }),
    ).toThrow(/REFUSED/)
  })

  it("CI's own throwaway database name (crm_ci) needs no exception at all — it is crm_-prefixed and not literally crm_db, so it passes looksDisposable() the same way every other scratch name does", () => {
    expect(() => assertSeedTargetIsDisposable(urlFor('crm_ci'), {})).not.toThrow()
  })

  it('the exact-name confirmation env var bypasses the guard for crm_db', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), {
        [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_db',
      }),
    ).not.toThrow()
  })

  it('a WRONG confirmation value does NOT bypass the guard (must equal the exact db name)', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), {
        [SEED_LIVE_DB_CONFIRM_ENV]: '1',
      }),
    ).toThrow(/REFUSED/)
  })

  it('a confirmation value for a DIFFERENT db name does not leak permission onto crm_db', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), {
        [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_some_other_db',
      }),
    ).toThrow(/REFUSED/)
  })

  it('logs a warning naming the exact database when the confirmation bypasses (not silent)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_db' })
    expect(warnSpy).toHaveBeenCalledWith(
      `[seed-db-guard] ${SEED_LIVE_DB_CONFIRM_ENV} confirms wiping 'crm_db' — proceeding.`,
    )
  })

  it('an EMPTY confirmation value does not bypass an unparseable (empty) db name — the length check on the confirm branch is not dead code', () => {
    expect(() =>
      assertSeedTargetIsDisposable('not-a-url', { [SEED_LIVE_DB_CONFIRM_ENV]: '' }),
    ).toThrow(/REFUSED/)
  })

  it('refuses an unrecognized non-crm_-prefixed name too (fail-closed, not a crm_db-only denylist)', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor('some_other_db'), {})).toThrow(/REFUSED/)
  })

  it('refuses a malformed DATABASE_URL (unknown name, cannot prove disposable), naming it as unknown rather than showing an empty string', () => {
    expect(() => assertSeedTargetIsDisposable('not-a-url', {})).toThrow(/REFUSED/)
    let thrown: Error | undefined
    try {
      assertSeedTargetIsDisposable('not-a-url', {})
    } catch (err) {
      thrown = err as Error
    }
    const msg = thrown!.message
    expect(msg).toContain(
      "REFUSED: db:seed will not TRUNCATE database '(unknown — could not parse DATABASE_URL)'",
    )
    expect(msg).toContain(
      `${SEED_LIVE_DB_CONFIRM_ENV}=<exact db name> pnpm --filter @crm/api db:seed`,
    )
  })

  it('defaults to process.env when no env argument is passed (confirmSourceEnv falls back to it too)', () => {
    const saved = process.env[SEED_LIVE_DB_CONFIRM_ENV]
    process.env[SEED_LIVE_DB_CONFIRM_ENV] = 'crm_db'
    try {
      expect(() => assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME))).not.toThrow()
    } finally {
      if (saved === undefined) delete process.env[SEED_LIVE_DB_CONFIRM_ENV]
      else process.env[SEED_LIVE_DB_CONFIRM_ENV] = saved
    }
  })

  describe('confirmSourceEnv (LOW-2, PR #576, 2026-08-18) — the confirmation must come from the real invocation, not apps/api/.env', () => {
    it('a confirmation value present ONLY in the (post-dotenv) env, absent from confirmSourceEnv, does NOT bypass — this models it having come from a .env file', () => {
      const postDotenvEnv = { [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_db' } // as if dotenv injected it
      const preDotenvSnapshot = {} // the real invocation never set it
      expect(() =>
        assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), postDotenvEnv, preDotenvSnapshot),
      ).toThrow(/REFUSED/)
    })

    it('a confirmation value present in confirmSourceEnv (the pre-dotenv snapshot) DOES bypass — this models it being typed on the invoking command line', () => {
      const postDotenvEnv = {} // .env did not set it in this scenario
      const preDotenvSnapshot = { [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_db' } // shell exported it
      expect(() =>
        assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), postDotenvEnv, preDotenvSnapshot),
      ).not.toThrow()
    })

    it('confirmSourceEnv defaults to env when not passed (back-compat with a single-env call)', () => {
      expect(() =>
        assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), {
          [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_db',
        }),
      ).not.toThrow()
    })
  })
})

describe('assertDbPushTargetIsDisposable (task-ci-db-rename-and-dbpush-guard, AC5/AC6 — same check, same escape hatch as db:seed, worded for db:push/db:migrate)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw for a disposable-looking name', () => {
    expect(() => assertDbPushTargetIsDisposable(urlFor('crm_qa'), {})).not.toThrow()
  })

  it("does not throw for CI's own throwaway database name (crm_ci)", () => {
    expect(() => assertDbPushTargetIsDisposable(urlFor('crm_ci'), {})).not.toThrow()
  })

  it('THROWS for the live db name crm_db, with no override present', () => {
    expect(() => assertDbPushTargetIsDisposable(urlFor(LIVE_DB_NAME), {})).toThrow(
      /REFUSED: db:push \(drizzle-kit push\) will not run against database 'crm_db'/,
    )
  })

  it('the refusal message points at db:push, not db:seed, and names the senior_resumes incident', () => {
    let thrown: Error | undefined
    try {
      assertDbPushTargetIsDisposable(urlFor(LIVE_DB_NAME), {})
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeInstanceOf(Error)
    const msg = thrown!.message

    expect(msg).toContain(
      "REFUSED: db:push (drizzle-kit push) will not run against database 'crm_db'",
    )
    // Every distinct piece of the dangerParagraph, in full — not just one
    // substring — so emptying any ONE of its concatenated lines is caught
    // (mutation-gate found 3 survivors here before these three assertions).
    expect(msg).toContain(
      'drizzle-kit push syncs the database schema to match schema.ts, which can',
    )
    expect(msg).toContain(
      'drop or alter existing tables and columns without asking — this is exactly',
    )
    expect(msg).toContain('what destroyed the live senior_resumes table on 2026-08-12')
    expect(msg).toContain('genuinely your own database and you want to push schema to it, set:')
    expect(msg).toContain(`${SEED_LIVE_DB_CONFIRM_ENV}=crm_db pnpm --filter @crm/api db:push`)
    // Same escape hatch as db:seed — AC6, not a second mechanism.
    expect(msg).toContain(SEED_LIVE_DB_CONFIRM_ENV)
  })

  it('the SAME exact-name confirmation env var used by db:seed also bypasses db:push — one mechanism, not two (AC6)', () => {
    expect(() =>
      assertDbPushTargetIsDisposable(urlFor(LIVE_DB_NAME), {
        [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_db',
      }),
    ).not.toThrow()
  })

  it('a WRONG confirmation value does not bypass db:push either', () => {
    expect(() =>
      assertDbPushTargetIsDisposable(urlFor(LIVE_DB_NAME), {
        [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_some_other_db',
      }),
    ).toThrow(/REFUSED/)
  })

  it('defaults confirmSourceEnv to process.env when not passed', () => {
    const saved = process.env[SEED_LIVE_DB_CONFIRM_ENV]
    process.env[SEED_LIVE_DB_CONFIRM_ENV] = 'crm_db'
    try {
      expect(() => assertDbPushTargetIsDisposable(urlFor(LIVE_DB_NAME))).not.toThrow()
    } finally {
      if (saved === undefined) delete process.env[SEED_LIVE_DB_CONFIRM_ENV]
      else process.env[SEED_LIVE_DB_CONFIRM_ENV] = saved
    }
  })
})

describe('runDbPushGuardCli (task-ci-db-rename-and-dbpush-guard, AC5 — the actual db:push CLI entry-point logic, extracted out of the untestable require.main gate so it has real mutation coverage)', () => {
  const savedDatabaseUrl = process.env['DATABASE_URL']
  const savedConfirm = process.env[SEED_LIVE_DB_CONFIRM_ENV]

  afterEach(() => {
    vi.restoreAllMocks()
    if (savedDatabaseUrl === undefined) delete process.env['DATABASE_URL']
    else process.env['DATABASE_URL'] = savedDatabaseUrl
    if (savedConfirm === undefined) delete process.env[SEED_LIVE_DB_CONFIRM_ENV]
    else process.env[SEED_LIVE_DB_CONFIRM_ENV] = savedConfirm
  })

  it('DATABASE_URL unset — refuses loudly, exits 1, and never reaches the name check', () => {
    delete process.env['DATABASE_URL']
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    runDbPushGuardCli({})

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[seed-db-guard] REFUSED: DATABASE_URL is not set — refusing to run db:push/db:migrate blind.',
      ),
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('a disposable-looking DATABASE_URL — no exit, no error, runs clean', () => {
    process.env['DATABASE_URL'] = urlFor('crm_scratch')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    runDbPushGuardCli({})

    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("CI's own throwaway database name (crm_ci) — no exit, no error", () => {
    process.env['DATABASE_URL'] = urlFor('crm_ci')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    runDbPushGuardCli({})

    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('the live db name, no confirmation — refuses, exits 1, and the error names db:push (not db:seed)', () => {
    process.env['DATABASE_URL'] = urlFor(LIVE_DB_NAME)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    runDbPushGuardCli({})

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "REFUSED: db:push (drizzle-kit push) will not run against database 'crm_db'",
      ),
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('the live db name WITH the exact-name confirmation present in the pre-dotenv env — warns and proceeds, no exit', () => {
    process.env['DATABASE_URL'] = urlFor(LIVE_DB_NAME)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    runDbPushGuardCli({ [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_db' })

    expect(warnSpy).toHaveBeenCalledWith(
      `[seed-db-guard] ${SEED_LIVE_DB_CONFIRM_ENV} confirms wiping 'crm_db' — proceeding.`,
    )
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('a confirmation for a DIFFERENT db name does not leak permission onto the live one — still refuses', () => {
    process.env['DATABASE_URL'] = urlFor(LIVE_DB_NAME)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    runDbPushGuardCli({ [SEED_LIVE_DB_CONFIRM_ENV]: 'crm_some_other_db' })

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('REFUSED'))
  })

  it('defaults env to process.env when not passed', () => {
    process.env['DATABASE_URL'] = urlFor(LIVE_DB_NAME)
    process.env[SEED_LIVE_DB_CONFIRM_ENV] = 'crm_db'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    runDbPushGuardCli()

    expect(exitSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("confirms wiping 'crm_db'"))
  })
})
