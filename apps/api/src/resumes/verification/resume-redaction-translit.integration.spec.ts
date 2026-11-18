/**
 * Backlog 463 on a real Postgres: with a Cyrillic `displayName` and `legalFullName`, the contexts
 * the REAL producer (`loadOwnerContacts`) builds make `writingPayload` replace the Latin spelling of
 * each name inside a free-text value. Before the fix the name rode into the payload sent to the
 * third-party writer.
 *
 * The producer is the point: a hand-built `ContactContext` would not prove that the display and the
 * legal name both reach the redaction. The table itself is unit-tested in
 * `contact-scan.translit.spec.ts` (the mutation gate cannot see this file).
 *
 * Every name here is invented.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run resume-redaction-translit.integration.spec
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import type { ResumeFacts } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../../database/schema'
import { users } from '../../database/schema'
import { DatabaseService } from '../../database/database.service'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import { writingPayload, type ContentInput } from './content-gates'
import { deriveFrozenContent } from './derive-content'
import { loadOwnerContacts } from './verification-runner'

const OWNER_ID = 'b4630000-0000-4000-8000-000000000001'
const IDS = [OWNER_ID]
/** Invented: a Cyrillic display name and a surname-first Cyrillic legal name, as the CRM stores them. */
const OWNER = {
  displayName: 'Євгенія Хижняк',
  legalFullName: 'Щербань Юхим Гнатович',
  telegram: '@b463_owner',
}

const facts = (notes: string[], company: string): ResumeFacts => ({
  headline: 'Senior Backend Engineer',
  location: { city: 'Lviv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['TypeScript', 'NestJS'],
  experience: [
    {
      company,
      role: 'Tech Lead',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['TypeScript'],
      notes,
    },
  ],
  education: [],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
})

describe.skipIf(!hasDatabaseUrl())(
  'resume redaction — transliterated name, real DB (backlog 463)',
  () => {
    let pool: Pool
    let dbSvc: DatabaseService

    beforeAll(async () => {
      await assertRealDbSchema([{ table: 'users', column: 'legal_full_name' }])
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const { rows } = await pool.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      const db = drizzle(pool, { schema })
      dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
        pool,
        db,
      })
      await db.delete(users).where(inArray(users.id, IDS))
      await db.insert(users).values([
        {
          id: OWNER_ID,
          email: 'b463-owner@translit.spec',
          role: 'SENIOR',
          googleId: `g-${OWNER_ID}`,
          ...OWNER,
        },
      ])
    }, 30_000)

    afterAll(async () => {
      try {
        await dbSvc.db.delete(users).where(inArray(users.id, IDS))
      } finally {
        await pool?.end()
      }
    })

    const payloadFor = async (notes: string[], company = 'Acme Corp') => {
      const owner = await loadOwnerContacts(dbSvc, OWNER_ID)
      if (!owner) throw new Error('fixture owner vanished')
      // Both stored names reached the producer, so a miss below is the redaction, not the fixture.
      expect(owner.contacts.map((c) => c.fullName)).toEqual([
        OWNER.displayName,
        OWNER.legalFullName,
      ])
      const content: ContentInput = {
        facts: facts(notes, company),
        frozen: deriveFrozenContent(facts(notes, company)),
        contacts: owner.contacts,
        template: 'classic',
        now: new Date('2026-11-18T12:00:00Z'),
      }
      return writingPayload(content)
    }

    it('replaces the Latin spelling of the Cyrillic displayName in a free-text note', async () => {
      const payload = await payloadFor(['Khyzhniak led the migration with two engineers'])
      const notes = payload.experience[0]?.notes ?? []
      expect(notes).toEqual(['[REDACTED] led the migration with two engineers'])
      expect(JSON.stringify(payload)).not.toMatch(/Khyzhniak/iu)
    })

    it('replaces the Latin spelling of the Cyrillic legalFullName in a free-text note', async () => {
      const payload = await payloadFor(['Signed off by Shcherban Yukhym Hnatovych in 2023'])
      const notes = payload.experience[0]?.notes ?? []
      expect(notes).toEqual(['Signed off by [REDACTED] in 2023'])
      expect(JSON.stringify(payload)).not.toMatch(/Shcherban/iu)
    })

    it('replaces a variant spelling, and the company field too', async () => {
      const payload = await payloadFor(
        ['Hired by Scherban Yukhym Hnatovych'],
        'Khyzhnyak Consulting',
      )
      expect(payload.experience[0]?.notes).toEqual(['Hired by [REDACTED]'])
      expect(payload.experience[0]?.company).toBe('[REDACTED] Consulting')
    })

    /**
     * Pre-existing and unchanged by backlog 463: the joined reading gives the full name and its LAST
     * part alone, so a legal name stored surname-first (`Щербань Юхим Гнатович`, as the CRM stores
     * it) offers the patronymic alone, never the surname alone. That holds in the stored script too,
     * so the transliteration mirrors it rather than adding a part order of its own.
     */
    it('mirrors the stored script on the surname of a surname-first legal name, alone', async () => {
      const latin = await payloadFor(['Hired by Scherban'])
      expect(latin.experience[0]?.notes).toEqual(['Hired by Scherban'])
      const cyrillic = await payloadFor(['Прийняв Щербань'])
      expect(cyrillic.experience[0]?.notes).toEqual(['Прийняв Щербань'])
    })

    it('keeps a Latin word that is not a transliteration of either stored name', async () => {
      const payload = await payloadFor(['Ran the schema review and the khan release'])
      expect(payload.experience[0]?.notes).toEqual(['Ran the schema review and the khan release'])
    })

    it('still replaces the stored Cyrillic spelling', async () => {
      const payload = await payloadFor(['Веде Хижняк з 2021'])
      expect(payload.experience[0]?.notes).toEqual(['Веде [REDACTED] з 2021'])
    })
  },
)
