import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Manager-role plan PR 1a AC 3-5 — `manual/2026-11-27_accountant_role_retire.sql` against a REAL
 * Postgres, in a scratch schema holding stubs of the `role` type and of every table the file reads.
 * The stubs carry real FKs: the file's guard finds the referencing columns in pg_constraint, so it
 * must see them, and `template_drafts` is ON DELETE CASCADE, the shape Postgres would not refuse by
 * itself. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run accountant-role-retire-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-27_accountant_role_retire.sql',
)
const SCHEMA = 'ddl_accountant_role_retire'
const ACC_TPL = '00000000-0000-4000-8000-0000000000a1'
const ACC_TPL_2 = '00000000-0000-4000-8000-0000000000a2'
const SENIOR_TPL = '00000000-0000-4000-8000-0000000000b1'
const SENIOR_USER = '00000000-0000-4000-8000-0000000000c1'

let pool: Pool
let client: PoolClient

async function applyFile(): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(readFileSync(FILE, 'utf8'))
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

async function count(sql: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(sql)
  return Number(rows[0]?.n)
}

const templateIds = async (): Promise<string[]> =>
  (await client.query<{ id: string }>(`SELECT id FROM contract_templates ORDER BY id`)).rows.map(
    (r) => r.id,
  )

describe.skipIf(!hasDatabaseUrl())('DDL: accountant role retire (data step)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)
    await client.query(`
      CREATE TYPE ${SCHEMA}.role AS ENUM ('ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP');
      CREATE TABLE ${SCHEMA}.users (id uuid PRIMARY KEY, role ${SCHEMA}.role NOT NULL);
      CREATE TABLE ${SCHEMA}.contract_templates (
        id uuid PRIMARY KEY, target_role ${SCHEMA}.role NOT NULL, is_active boolean NOT NULL,
        created_at timestamptz NOT NULL);
      CREATE TABLE ${SCHEMA}.employee_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_template_id uuid NOT NULL REFERENCES ${SCHEMA}.contract_templates (id));
      CREATE TABLE ${SCHEMA}.signed_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        template_id uuid NOT NULL REFERENCES ${SCHEMA}.contract_templates (id) ON DELETE RESTRICT);
      CREATE TABLE ${SCHEMA}.template_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        base_template_id uuid REFERENCES ${SCHEMA}.contract_templates (id) ON DELETE CASCADE);
      CREATE TABLE ${SCHEMA}.transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        validated_by uuid REFERENCES ${SCHEMA}.users (id));
      CREATE TABLE ${SCHEMA}.transaction_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id uuid REFERENCES ${SCHEMA}.users (id));
    `)
  })

  beforeEach(async () => {
    // ACC_TPL_2 sits one second before the cutoff, so the happy path also pins its lower edge.
    await client.query(`
      TRUNCATE users, contract_templates, employee_contracts, signed_contracts, template_drafts,
        transactions, transaction_audit_log;
      INSERT INTO users VALUES ('${SENIOR_USER}', 'SENIOR');
      INSERT INTO contract_templates VALUES
        ('${ACC_TPL}', 'ACCOUNTANT', true, '2026-06-01 10:00:00+00'),
        ('${ACC_TPL_2}', 'ACCOUNTANT', false, '2026-11-28 23:59:59+00'),
        ('${SENIOR_TPL}', 'SENIOR', true, '2026-06-01 10:00:00+00');
      INSERT INTO employee_contracts (source_template_id) VALUES ('${SENIOR_TPL}');
      INSERT INTO signed_contracts (template_id) VALUES ('${SENIOR_TPL}');
      INSERT INTO template_drafts (base_template_id) VALUES ('${SENIOR_TPL}');
      INSERT INTO transactions (validated_by) VALUES ('${SENIOR_USER}'), ('${SENIOR_USER}');
      INSERT INTO transaction_audit_log (actor_id) VALUES ('${SENIOR_USER}');
    `)
  })

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('deletes the unreferenced ACCOUNTANT templates, keeps the others and the history rows', async () => {
    await applyFile()
    expect(await templateIds()).toEqual([SENIOR_TPL])
    expect(await count(`SELECT count(*) AS n FROM users WHERE role = 'SENIOR'`)).toBe(1)
    expect(await count(`SELECT count(*) AS n FROM employee_contracts`)).toBe(1)
    expect(await count(`SELECT count(*) AS n FROM signed_contracts`)).toBe(1)
    expect(await count(`SELECT count(*) AS n FROM template_drafts`)).toBe(1)
    expect(await count(`SELECT count(*) AS n FROM transactions`)).toBe(2)
    expect(await count(`SELECT count(*) AS n FROM transaction_audit_log`)).toBe(1)
  })

  it('is idempotent: a second apply raises nothing and changes nothing', async () => {
    await applyFile()
    await applyFile()
    expect(await templateIds()).toEqual([SENIOR_TPL])
    expect(await count(`SELECT count(*) AS n FROM transactions`)).toBe(2)
  })

  it.each([
    [
      'employee_contracts',
      'source_template_id',
      `INSERT INTO employee_contracts (source_template_id) VALUES ('${ACC_TPL}')`,
    ],
    [
      'signed_contracts',
      'template_id',
      `INSERT INTO signed_contracts (template_id) VALUES ('${ACC_TPL}')`,
    ],
    [
      'template_drafts',
      'base_template_id',
      `INSERT INTO template_drafts (base_template_id) VALUES ('${ACC_TPL_2}')`,
    ],
  ])(
    'refuses and deletes nothing when %s references an ACCOUNTANT template',
    async (table, column, seed) => {
      await client.query(seed)
      await expect(applyFile()).rejects.toThrow(
        `ACCOUNTANT contract templates are referenced (${table}.${column} 1;); nothing deleted`,
      )
      expect(await templateIds()).toEqual([ACC_TPL, ACC_TPL_2, SENIOR_TPL])
      expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBe(2)
    },
  )

  it('refuses and deletes nothing when an ACCOUNTANT template was created on the cutoff', async () => {
    await client.query(
      `INSERT INTO contract_templates VALUES (gen_random_uuid(), 'ACCOUNTANT', false, '2026-11-29 00:00:00+00')`,
    )
    await expect(applyFile()).rejects.toThrow(
      '1 ACCOUNTANT contract templates were created on or after 2026-11-29; nothing deleted',
    )
    expect(await count(`SELECT count(*) AS n FROM contract_templates`)).toBe(4)
  })

  it('refuses a multi-column FK onto contract_templates, which it cannot count', async () => {
    await client.query(`
      CREATE UNIQUE INDEX ct_id_role ON ${SCHEMA}.contract_templates (id, target_role);
      CREATE TABLE ${SCHEMA}.composite_refs (template_id uuid, template_role ${SCHEMA}.role,
        CONSTRAINT composite_refs_fk FOREIGN KEY (template_id, template_role)
          REFERENCES ${SCHEMA}.contract_templates (id, target_role));
    `)
    try {
      await expect(applyFile()).rejects.toThrow(
        'FK composite_refs_fk on composite_refs has 2 columns, this guard counts single-column FKs only; nothing deleted',
      )
      expect(await templateIds()).toEqual([ACC_TPL, ACC_TPL_2, SENIOR_TPL])
    } finally {
      await client.query(`DROP TABLE ${SCHEMA}.composite_refs; DROP INDEX ${SCHEMA}.ct_id_role`)
    }
  })

  it('refuses while a user still holds ACCOUNTANT and rolls the template delete back', async () => {
    await client.query(`INSERT INTO users VALUES (gen_random_uuid(), 'ACCOUNTANT')`)
    await expect(applyFile()).rejects.toThrow(/1 users still hold ACCOUNTANT/)
    expect(await templateIds()).toEqual([ACC_TPL, ACC_TPL_2, SENIOR_TPL])
  })

  it('still parses and passes after the role type is recreated without ACCOUNTANT (PR 1d)', async () => {
    await applyFile()
    await client.query(`
      ALTER TYPE ${SCHEMA}.role RENAME TO role_old;
      CREATE TYPE ${SCHEMA}.role AS ENUM ('ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'DROP');
      ALTER TABLE users ALTER COLUMN role TYPE ${SCHEMA}.role USING role::text::${SCHEMA}.role;
      ALTER TABLE contract_templates
        ALTER COLUMN target_role TYPE ${SCHEMA}.role USING target_role::text::${SCHEMA}.role;
      DROP TYPE ${SCHEMA}.role_old;
    `)
    await applyFile()
    await applyFile()
    expect(await templateIds()).toEqual([SENIOR_TPL])
    expect(await count(`SELECT count(*) AS n FROM transactions`)).toBe(2)
  })
})
