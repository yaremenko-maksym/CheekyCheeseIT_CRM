import { describe, expect, it } from 'vitest'

import {
  DISPOSABLE_NAME_PREFIX,
  LIVE_DB_NAME,
  SEED_LIVE_DB_CONFIRM_ENV,
  assertSeedTargetIsDisposable,
  extractDbName,
  looksDisposable,
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

  it('GITHUB_ACTIONS=true short-circuits before the name check, even against crm_db', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { GITHUB_ACTIONS: 'true' }),
    ).not.toThrow()
  })

  it('GITHUB_ACTIONS set to any other value does NOT bypass the guard', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { GITHUB_ACTIONS: 'false' }),
    ).toThrow(/REFUSED/)
  })

  it('plain CI=true does NOT bypass the guard (narrowed per security review, PR #576 MED-1 — CI is an easy-to-type/easy-to-inherit idiom nothing in this repo exports, unlike GITHUB_ACTIONS which only the runner sets)', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { CI: 'true' })).toThrow(
      /REFUSED/,
    )
  })

  it('CI=true AND GITHUB_ACTIONS=true together still bypass (GITHUB_ACTIONS is what matters)', () => {
    expect(() =>
      assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME), { CI: 'true', GITHUB_ACTIONS: 'true' }),
    ).not.toThrow()
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

  it('refuses an unrecognized non-crm_-prefixed name too (fail-closed, not a crm_db-only denylist)', () => {
    expect(() => assertSeedTargetIsDisposable(urlFor('some_other_db'), {})).toThrow(/REFUSED/)
  })

  it('refuses a malformed DATABASE_URL (unknown name, cannot prove disposable)', () => {
    expect(() => assertSeedTargetIsDisposable('not-a-url', {})).toThrow(/REFUSED/)
  })

  it('defaults to process.env when no env argument is passed', () => {
    const saved = process.env['GITHUB_ACTIONS']
    process.env['GITHUB_ACTIONS'] = 'true'
    try {
      expect(() => assertSeedTargetIsDisposable(urlFor(LIVE_DB_NAME))).not.toThrow()
    } finally {
      if (saved === undefined) delete process.env['GITHUB_ACTIONS']
      else process.env['GITHUB_ACTIONS'] = saved
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
