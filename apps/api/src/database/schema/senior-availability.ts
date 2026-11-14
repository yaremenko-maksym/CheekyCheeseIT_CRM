/**
 * A senior's own availability (vacancy-queue design §5.2), shown on the HR queue card.
 * Its own table, not a `users` column: the forward DDL is staged
 * (`drizzle/manual-staged/2026-11-14_senior_availability.sql`), and a `users` column would make
 * every whole-row `users` read fail with 42703 on a database that has not run it yet. A missing
 * table fails only the queue card and the availability endpoints.
 */
import { sql } from 'drizzle-orm'
import { check, date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { SENIOR_AVAILABILITY_STATUSES } from '@crm/shared'
import { users } from './users'

export const seniorAvailability = pgTable(
  'senior_availability',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').$type<(typeof SENIOR_AVAILABILITY_STATUSES)[number]>().notNull(),
    availableFrom: date('available_from'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ck_senior_availability_status', sql`${t.status} IN ('FREE', 'BUSY')`),
    // FREE always names its day; BUSY never does.
    check(
      'ck_senior_availability_from',
      sql`(${t.status} = 'FREE') = (${t.availableFrom} IS NOT NULL)`,
    ),
  ],
)

export type SeniorAvailabilityRow = typeof seniorAvailability.$inferSelect
