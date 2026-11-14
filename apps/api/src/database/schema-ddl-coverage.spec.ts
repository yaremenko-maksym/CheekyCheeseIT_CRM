/**
 * The drift guard of backlog 434: the Drizzle schema may not declare a table, column or named index
 * that no `drizzle/manual/*.sql` file creates. Production runs only those files, so such an object
 * exists in CI (`db:push`) and not in production — every 10-minute health tick failed with
 * `column "bytes_read" does not exist` for exactly this reason.
 *
 * Fix a red run by adding the DDL to a `manual/` file (and wiring it into the deploy), not by
 * extending an allow-list. A real exception goes in EXCEPTIONS with the reason it is safe.
 *
 * Known limit: a column added to the body of an existing `CREATE TABLE IF NOT EXISTS` reads as
 * created, though production (where the table already exists) skips it. New columns on an existing
 * table belong in `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from 'drizzle-orm'
import { index, integer, pgTable, PgTable, text, uuid } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema'
import { ddlCreatedObjects, uncreatedSchemaObjects } from './schema-ddl-coverage'

const MANUAL_DIR = join(__dirname, '..', '..', 'drizzle', 'manual')
const manualSql = readdirSync(MANUAL_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(MANUAL_DIR, f), 'utf8'))
const schemaTables = Object.values(schema).filter((v): v is PgTable => is(v, PgTable))

/**
 * PRE-MANUAL BASELINE. These 25 tables predate the `drizzle/manual/` discipline: production got
 * them from `drizzle-kit push` before the deploy stopped running it, so no manual file creates
 * them. The column and index lists are frozen as declared on 2026-11-14 (the repository history
 * before 2026-10-31 is squashed, so the freeze cannot be traced further back). Anything added to
 * these tables after this date needs an `ALTER TABLE … ADD COLUMN` in `manual/`, like every other
 * table. Not measured against production here; the read-only query that verifies it is in the
 * backlog 434 PR body.
 */
const PRE_MANUAL_BASELINE: Record<string, { columns: string; indexes: string }> = {
  company_account: {
    columns: 'confirmation_threshold id updated_at updated_by wallet_address',
    indexes: '',
  },
  contract_templates: {
    columns:
      'body_markdown created_at created_by_user_id custom_variables id is_active target_role version',
    indexes: '',
  },
  documents: {
    columns:
      'category created_at deleted_at deleted_by id mime_type name original_name owner_id project_id s3_key size_bytes thumbnail_s3_key uploaded_by',
    indexes: 'idx_documents_category idx_documents_owner idx_documents_project',
  },
  employee_contracts: {
    columns:
      'body_markdown created_at created_by_user_id custom_values id signed_contract_id source_template_id status updated_at user_id',
    indexes: 'employee_contracts_user_status_idx',
  },
  interviews: {
    columns:
      'call_url company_name created_at hr_id id notes_benefits notes_corp_tech notes_domain notes_general notes_payment_type notes_salary_review notes_team_size notes_tech_stack position senior_id stage updated_at vacancy_url',
    indexes: '',
  },
  invoice_signatures: {
    columns:
      'id ip_address method pdf_hash signed_at signer_id signer_role transaction_id user_agent',
    indexes: 'idx_invoice_signatures_signer idx_invoice_signatures_transaction',
  },
  legend_entries: {
    columns: 'author_id created_at event_date id legend_id text',
    indexes: '',
  },
  legends: {
    columns:
      'address backstory created_at date_of_birth full_name hobbies id notes presented_role presented_stack project_id updated_at',
    indexes: '',
  },
  notifications: {
    columns: 'body created_at id link read_at title type user_id',
    indexes: 'idx_notifications_user_created idx_notifications_user_unread',
  },
  payout_requests: {
    columns:
      'contract_address created_at id income_amount payable_amount senior_id status tx_hash updated_at',
    indexes: 'uq_payout_requests_txhash_paid',
  },
  pending_obligations: {
    columns:
      'amount closing_transaction_id created_at creditor_user_id currency debtor_type debtor_user_id id source_transaction_id status updated_at',
    indexes:
      'idx_pending_obligations_creditor idx_pending_obligations_source idx_pending_obligations_status',
  },
  project_audit_log: {
    columns: 'action actor_id changes created_at id target_id',
    indexes: 'project_audit_log_created_at_idx project_audit_log_target_id_idx',
  },
  project_credentials: {
    columns:
      'created_at created_by id label login notes password_ciphertext project_id updated_at url',
    indexes: 'project_credentials_project_idx',
  },
  project_finance_settings: {
    columns:
      'id junior_salary_override project_id senior_share_percent_override updated_at updated_by',
    indexes: '',
  },
  project_members: {
    columns: 'id joined_at left_at project_id user_id',
    indexes: '',
  },
  projects: {
    columns:
      'archived_at benefits company_name corp_tech created_at currency domain drop_id id logo_document_id logo_external_url name notes_general payment_type rate salary_review senior_id senior_share_percent_override start_date team_size tech_stack updated_at',
    indexes: '',
  },
  signed_contracts: {
    columns:
      'body_markdown_snapshot contract_number id pdf_size_bytes signed_at signed_ip signed_typed_name signed_user_agent template_id user_id variables_filled',
    indexes: 'signed_contracts_user_id_idx',
  },
  team_audit_log: {
    columns: 'action actor_id changes created_at id target_id',
    indexes: 'team_audit_log_created_at_idx team_audit_log_target_id_idx',
  },
  team_members: {
    columns: 'id joined_at left_at team_id user_id',
    indexes: '',
  },
  teams: {
    columns:
      'archived_at created_at id name notes senior_share_percent_override telegram telegram_channel type updated_at',
    indexes: '',
  },
  tos_acceptances: {
    columns: 'accepted_at accepted_ip accepted_user_agent id tos_version_id user_id',
    indexes: 'tos_acceptances_user_id_idx',
  },
  tos_versions: {
    columns: 'body_markdown created_at created_by_user_id id is_active version',
    indexes: '',
  },
  transactions: {
    columns:
      'amount created_at created_by currency funding_source id invoice_document_id notes payout_request_id project_id receipt_document_id receipt_external_url receiver_id receiver_label recipient_id rejection_reason salary_month sender_id sender_label senior_share_percent senior_share_percent_source status tx_date tx_hash type updated_at validated_at validated_by',
    indexes: 'uq_transactions_company_deposit_tx_hash uq_transactions_receipt_document_id',
  },
  user_audit_log: {
    columns: 'action actor_id changes created_at id target_id',
    indexes: 'user_audit_log_target_id_idx',
  },
  users: {
    columns:
      'admin_note archived_at avatar_document_id avatar_url bank_uah_bank_name bank_uah_iban bank_uah_recipient bank_uah_rnokpp created_at display_name drop_share_percent email google_id id legal_full_name monthly_salary payment_method phone registration_address role salary_currency senior_share_percent tech_stack telegram updated_at wallet_usdt_erc20 wallet_usdt_label',
    indexes: '',
  },
}

/** Non-baseline objects deliberately not created by a manual file: key -> why it is safe. */
const EXCEPTIONS: Record<string, string> = {}

const allowed = new Set([
  ...Object.entries(PRE_MANUAL_BASELINE).flatMap(([t, { columns, indexes }]) => [
    t,
    ...columns
      .split(' ')
      .filter(Boolean)
      .map((c) => `${t}.${c}`),
    ...indexes
      .split(' ')
      .filter(Boolean)
      .map((i) => `${t}#${i}`),
  ]),
  ...Object.keys(EXCEPTIONS),
])

describe('Drizzle schema vs drizzle/manual DDL (backlog 434 drift guard)', () => {
  it('every declared table, column and named index is created by a manual/ file', () => {
    expect(manualSql.length).toBeGreaterThan(50)
    expect(uncreatedSchemaObjects(schemaTables, manualSql, allowed)).toEqual([])
  })

  it('carries no stale allow-list entry (each is still declared and still not created)', () => {
    const declared = new Set(uncreatedSchemaObjects(schemaTables, [], new Set()))
    const created = ddlCreatedObjects(manualSql)
    expect([...allowed].filter((k) => !declared.has(k) || created.has(k))).toEqual([])
  })
})

describe('ddlCreatedObjects / uncreatedSchemaObjects', () => {
  const t = pgTable(
    'probe',
    { id: uuid('id').primaryKey(), extra: integer('extra'), note: text('note') },
    (c) => [index('idx_probe_note').on(c.note)],
  )
  const createProbe = `CREATE TABLE IF NOT EXISTS "public"."probe" (
    id uuid PRIMARY KEY, note text CHECK (note IN ('a,b', 'c')),
    CONSTRAINT ck_probe CHECK (length(note) > 0)
  );`
  const none = new Set<string>()

  it('reports a declared column no DDL creates (the deliberately undeclared column)', () => {
    expect(uncreatedSchemaObjects([t], [createProbe], none)).toEqual([
      'probe#idx_probe_note',
      'probe.extra',
    ])
  })

  it('accepts ALTER TABLE … ADD COLUMN and CREATE INDEX CONCURRENTLY', () => {
    const more = `ALTER TABLE probe ADD COLUMN IF NOT EXISTS "extra" integer;
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_probe_note" ON "probe" USING btree ("note");`
    expect(uncreatedSchemaObjects([t], [createProbe, more], none)).toEqual([])
  })

  it('scopes a column to its table and ignores commented-out DDL', () => {
    const elsewhere = `ALTER TABLE other ADD COLUMN extra integer;
      -- ALTER TABLE probe ADD COLUMN extra integer;
      /* CREATE INDEX idx_probe_note ON probe (note); */`
    expect(uncreatedSchemaObjects([t], [createProbe, elsewhere], none)).toEqual([
      'probe#idx_probe_note',
      'probe.extra',
    ])
  })

  it('does not read constraint lines as columns', () => {
    expect(ddlCreatedObjects([createProbe])).toEqual(new Set(['probe', 'probe.id', 'probe.note']))
  })

  it('reports a table no DDL creates, with all its columns', () => {
    expect(uncreatedSchemaObjects([t], [], none)).toEqual([
      'probe',
      'probe#idx_probe_note',
      'probe.extra',
      'probe.id',
      'probe.note',
    ])
  })
})
