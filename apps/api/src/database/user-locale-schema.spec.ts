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
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { users } from './schema'

describe('users.locale — column declaration', () => {
  it('is named "locale", NOT NULL, defaulting to "uk"', () => {
    const { columns } = getTableConfig(users)
    const column = columns.find((c) => c.name === 'locale')

    expect(column, 'locale column must exist on users').toBeDefined()
    expect(column!.notNull).toBe(true)
    expect(column!.default).toBe('uk')
  })
})
