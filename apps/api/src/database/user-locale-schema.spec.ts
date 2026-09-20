/**
 * task-i18n-stage2 (Task 3) — `users.locale` column declaration.
 *
 * Why a dedicated unit spec: `schema.ts`'s `locale: userLocaleEnum('locale')
 * .notNull().default('uk')` is a pure declaration — no service method reads
 * or branches on the column NAME or DEFAULT string, so a mutant that empties
 * either literal (`''`) is invisible to every behavior-level test in this
 * repo (mutation-gate: StringLiteral survived at schema.ts on this exact
 * line before this spec existed). `getTableConfig` inspects the Drizzle
 * column object directly, no database required — same pattern as
 * `notification-subjects-schema.spec.ts` / `notification-email-schema.spec.ts`.
 */
import { LOCALES } from '@crm/shared'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { userLocaleEnum, users } from './schema'

describe('users.locale — column declaration', () => {
  it('is named "locale", NOT NULL, defaulting to "uk"', () => {
    const { columns } = getTableConfig(users)
    const column = columns.find((c) => c.name === 'locale')

    expect(column, 'locale column must exist on users').toBeDefined()
    expect(column!.notNull).toBe(true)
    expect(column!.default).toBe('uk')
  })
})

describe('userLocaleEnum — value set', () => {
  // CI mutation gate (fix-round 3, CI-1): a StringLiteral mutant emptying
  // 'en' to '' in the pgEnum() call survived every behavior-level test —
  // nothing branches on the enum's DB-side value list. Pin it directly, and
  // pin it against @crm/shared's LOCALES so the Postgres enum and the Zod
  // schema can never silently drift apart.
  it('is exactly ["uk", "en"]', () => {
    expect(userLocaleEnum.enumValues).toEqual(['uk', 'en'])
  })

  it('matches @crm/shared LOCALES', () => {
    expect(userLocaleEnum.enumValues).toEqual([...LOCALES])
  })

  // Fixing the two literals above (`enumValues`) leaves a THIRD StringLiteral
  // on the same `pgEnum(...)` call unpinned: the first argument is the
  // Postgres enum type's own SQL name, unrelated to `enumValues`. Verified
  // locally — emptying it survives even with the two assertions above in
  // place (a second mutant, distinct from the one CI's paste showed).
  it('names the underlying Postgres enum type "user_locale"', () => {
    expect(userLocaleEnum.enumName).toBe('user_locale')
  })
})
