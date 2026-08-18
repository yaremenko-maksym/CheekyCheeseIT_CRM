/**
 * RBAC regression test — task-counterparty-role-masking.
 *
 * The counterparty that is an INTERNAL company party — a specific ADMIN
 * partner (Максим/Константин) or the company account pool itself — must be
 * disclosed ONLY to ADMIN/ACCOUNTANT. Every other role (SENIOR/JUNIOR/DROP/HR)
 * sees the neutral brand «CheekyCheeseIT» with the admin's user id + displayName
 * stripped from the DTO. This is RBAC (server-side masking in mapTx), NOT a
 * CSS/front-end concern — the network payload itself must never carry the
 * admin's identity for a non-privileged viewer.
 *
 * WHY real-DB (not mocked):
 *   mapTx joins `users.role` for both sender and receiver to decide whether a
 *   party is an ADMIN partner. A mocked findMany would let a regression in the
 *   Drizzle `with: { sender/receiver: { columns } }` join (dropping `role`)
 *   pass silently. A real-DB spec proves the whole path: rows in Postgres →
 *   Drizzle role join → mapTx masking → returned DTO.
 *   Class of incident: feedback_mocked_e2e_guards (real data-leaks behind
 *   guards — recurred 3×).
 *
 * WHAT it covers:
 *   CM-1  PAYOUT_DROP company-funded (senderLabel='COMPANY'): DROP viewer sees
 *         senderLabel='CheekyCheeseIT', senderId=null; ADMIN sees raw 'COMPANY'.
 *   CM-2  PAYOUT_DROP admin-personal (Максим paid): DROP viewer gets no admin
 *         id/name (senderLabel='CheekyCheeseIT', senderId/senderName=null);
 *         ACCOUNTANT sees the real admin id + displayName.
 *   CM-3  External-client SENIOR_INCOME: sender is the client company — NOT
 *         masked for SENIOR nor ADMIN (the recipient sees their real payer).
 *   CM-4  Security: the DROP's findAll payload does NOT contain the admin's
 *         displayName or id anywhere (whole-response grep).
 *   CM-5  findOne path masks the admin-personal counterparty for DROP, discloses
 *         it for ACCOUNTANT (second mapTx call site).
 *   CM-6  findPayoutRequest path (third mapTx call site): the linked
 *         transaction's admin sender is masked for the owning DROP, real for
 *         ACCOUNTANT.
 *   CM-7  The recipient (drop) is never masked — DROP sees their own id/name as
 *         the receiver on their own rows.
 *   CM-8  MED-1 (security review PR #384): admin-personal PAYOUT_DROP whose
 *         payer admin was DELETED (senderId=null via ON DELETE SET NULL,
 *         senderLabel=snapshot name, fundingSource='ADMIN_PERSONAL') — DROP
 *         still gets 'CheekyCheeseIT' (name does NOT leak just because the id
 *         is already gone); ADMIN sees the real snapshot label. Receiver (the
 *         drop) is confirmed NOT masked by the same new condition.
 *
 * CB — createdBy (registrar audit UUID) masking (follow-up hardening, same
 *      defense-in-depth class as the counterparty masking above):
 *   CB-1  findAll: a company-funded PAYOUT_DROP BOOKED BY an ADMIN
 *         (createdBy=admin) — DROP sees createdBy=null; ACCOUNTANT sees the
 *         real admin UUID.
 *   CB-2  findOne (second mapTx call site): same mask for DROP / disclose for
 *         ACCOUNTANT.
 *   CB-3  Self-preserve (non-regression): a row the viewer AUTHORED themselves
 *         (createdBy === viewer.id, e.g. self-declared income) keeps createdBy
 *         = their own id — nulling it would silently break the frontend author
 *         gate `canAttachReceipt` (receipt attach/replace on own income).
 *   CB-4  Security whole-payload grep: DROP findAll never carries the admin
 *         registrar's UUID via createdBy (the CB-1 row's admin has no other
 *         id vector — company-funded, senderId=null — isolating createdBy).
 *   CB-5  findPayoutRequest path (third mapTx call site): a linked, company-
 *         funded PAYOUT_DROP booked AND validated by the admin
 *         (createdBy=admin, validatedBy=admin) — the owning DROP sees BOTH
 *         audit UUIDs = null; ADMIN/ACCOUNTANT see the real admin UUID. Proves
 *         the validatedBy mask (follow-up to createdBy) on the payout-request
 *         path, mirroring CM-6 for the counterparty.
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * SEED strategy:
 *   UUID namespace: ca5f0000-* (users) / ca5f0001-* (transactions) /
 *   ca5f0002-* (payout_requests) — distinct from other specs. Idempotent via
 *   onConflictDoNothing; afterAll cleans up in reverse FK order.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { transactions, users, payoutRequests } from '../database/schema'
import * as schema from '../database/schema'
import type { TransactionsService } from './transactions.service'
import { hasDatabaseUrl } from '../test/require-real-db'

// ---------------------------------------------------------------------------
// Personas — namespace ca5f0000-*
// ---------------------------------------------------------------------------

/** The internal ADMIN partner whose identity must be masked (e.g. Максим). */
const ADMIN_MAKSYM: SessionUser = {
  id: 'ca5f0000-0000-4000-aa00-000000000001',
  email: 'cm-admin-maksym@test.spec',
  displayName: 'Максим Тестовый',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** Privileged viewer that MUST see the real admin identity. */
const ACCOUNTANT_1: SessionUser = {
  id: 'ca5f0000-0000-4000-aa00-000000000002',
  email: 'cm-accountant@test.spec',
  displayName: 'CM Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** External-client income receiver + non-privileged viewer. */
const SENIOR_1: SessionUser = {
  id: 'ca5f0000-0000-4000-aa00-000000000003',
  email: 'cm-senior@test.spec',
  displayName: 'CM Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** PAYOUT_DROP recipient + non-privileged viewer (the drop). */
const DROP_1: SessionUser = {
  id: 'ca5f0000-0000-4000-aa00-000000000004',
  email: 'cm-drop@test.spec',
  displayName: 'CM Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 26,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// Transaction IDs — namespace ca5f0001-*
// ---------------------------------------------------------------------------

/** PAYOUT_DROP funded from the company account (sender = company pool). */
const TX_DROP_COMPANY_ID = 'ca5f0001-0000-4000-b000-000000000001'
/** PAYOUT_DROP funded personally by Максим (sender = the admin). */
const TX_DROP_ADMIN_ID = 'ca5f0001-0000-4000-b000-000000000002'
/** External-client SENIOR_INCOME (sender = client company, not masked). */
const TX_SENIOR_CLIENT_ID = 'ca5f0001-0000-4000-b000-000000000003'
/** Admin-personal PAYOUT_DROP linked to a payout request (findPayoutRequest). */
const TX_PR_ADMIN_ID = 'ca5f0001-0000-4000-b000-000000000004'
/**
 * MED-1 (security review PR #384): admin-personal PAYOUT_DROP whose payer
 * admin was SUBSEQUENTLY DELETED. Simulated directly at the row level —
 * senderId=null (as the `ON DELETE SET NULL` FK would leave it) while
 * senderLabel still carries the deleted admin's SNAPSHOT displayName (exactly
 * what `paySalary`/`PendingSettlementService` stamp at pay time, which the FK
 * cascade never touches).
 */
const TX_DROP_DELETED_ADMIN_ID = 'ca5f0001-0000-4000-b000-000000000005'
/**
 * CB (createdBy masking): a company-funded PAYOUT_DROP to the drop, but BOOKED
 * BY the ADMIN (createdBy=admin). The counterparty (sender) is the company pool
 * — NOT the admin — so the ONLY vector for the admin's UUID in this row is the
 * `createdBy` audit field, isolating createdBy masking from counterparty masking.
 */
const TX_CB_ADMIN_ID = 'ca5f0001-0000-4000-b000-000000000006'
/**
 * CB-5 (validatedBy masking on the findPayoutRequest path): a company-funded
 * PAYOUT_DROP LINKED to the drop's payout request, BOOKED and VALIDATED by the
 * ADMIN (createdBy=admin, validatedBy=admin). Counterparty = company pool
 * (senderId=null, senderLabel='COMPANY'), so the ONLY vectors for the admin's
 * UUID are the `createdBy` + `validatedBy` audit fields — isolating audit-field
 * masking from counterparty masking on the third mapTx call site.
 */
const TX_CB_PR_ADMIN_ID = 'ca5f0001-0000-4000-b000-000000000007'

/** Payout request owned by the DROP (seniorId column reused as owner). */
const PR_1_ID = 'ca5f0002-0000-4000-c000-000000000001'

const EXTERNAL_CLIENT_LABEL = 'Acme Client LLC'
/** Snapshot displayName of the (simulated) deleted admin — see MED-1 above. */
const DELETED_ADMIN_LABEL = 'Константин Удалённый'

const ALL_TX_IDS = [
  TX_DROP_COMPANY_ID,
  TX_DROP_ADMIN_ID,
  TX_SENIOR_CLIENT_ID,
  TX_PR_ADMIN_ID,
  TX_DROP_DELETED_ADMIN_ID,
  TX_CB_ADMIN_ID,
  TX_CB_PR_ADMIN_ID,
]
const ALL_USER_IDS = [ADMIN_MAKSYM.id, ACCOUNTANT_1.id, SENIOR_1.id, DROP_1.id]

// ---------------------------------------------------------------------------
// DB-skip-guard
// ---------------------------------------------------------------------------

let _pool: Pool | null = null
let svc: TransactionsService

describe.skipIf(!hasDatabaseUrl())('CM — counterparty RBAC masking (real-DB)', () => {
  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      throw new Error(
        '[cm-counterparty-masking] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
    }

    _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(_pool, { schema })

    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: _pool, db })
    svc = makeTransactionsService({ db: dbSvc })

    // ── Users ────────────────────────────────────────────────────────────────
    for (const u of [ADMIN_MAKSYM, ACCOUNTANT_1, SENIOR_1, DROP_1]) {
      await db
        .insert(users)
        .values({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: 26,
        })
        .onConflictDoNothing()
    }

    // ── Payout request owned by the DROP (findPayoutRequest fixture) ──────────
    await db
      .insert(payoutRequests)
      .values({
        id: PR_1_ID,
        seniorId: DROP_1.id,
        incomeAmount: '1000',
        payableAmount: '740',
        contractAddress: '0x0000000000000000000000000000000000000001',
        status: 'PAID',
      })
      .onConflictDoNothing()

    // ── CM-1: PAYOUT_DROP funded from the company account ──────────────────────
    // sender = company pool (senderId=null, senderLabel='COMPANY',
    // fundingSource='COMPANY_ACCOUNT'); receiver = the drop.
    await db
      .insert(transactions)
      .values({
        id: TX_DROP_COMPANY_ID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '260',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'COMPANY',
        fundingSource: 'COMPANY_ACCOUNT',
        receiverId: DROP_1.id,
        recipientId: DROP_1.id,
        // `createdBy` is an audit field (who booked the row), NOT the
        // counterparty — deliberately anchored to a NON-masked user so CM-4's
        // whole-payload grep isolates a genuine *counterparty* identity leak.
        createdBy: DROP_1.id,
      })
      .onConflictDoNothing()

    // ── CM-2: PAYOUT_DROP funded personally by the admin ───────────────────────
    // sender = Максим (senderId=admin, senderLabel=admin displayName, no
    // COMPANY_ACCOUNT funding); receiver = the drop. The masking must catch this
    // via the joined sender.role === 'ADMIN'.
    await db
      .insert(transactions)
      .values({
        id: TX_DROP_ADMIN_ID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '260',
        currency: 'USDT',
        senderId: ADMIN_MAKSYM.id,
        senderLabel: ADMIN_MAKSYM.displayName,
        fundingSource: null,
        receiverId: DROP_1.id,
        recipientId: DROP_1.id,
        // `createdBy` is an audit field (who booked the row), NOT the
        // counterparty — deliberately anchored to a NON-masked user so CM-4's
        // whole-payload grep isolates a genuine *counterparty* identity leak.
        createdBy: DROP_1.id,
      })
      .onConflictDoNothing()

    // ── CM-3: External-client SENIOR_INCOME — sender is the client, NOT masked ─
    await db
      .insert(transactions)
      .values({
        id: TX_SENIOR_CLIENT_ID,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '5000',
        currency: 'USDT',
        senderId: null,
        senderLabel: EXTERNAL_CLIENT_LABEL,
        fundingSource: null,
        receiverId: SENIOR_1.id,
        // `createdBy` is an audit field (who booked the row), NOT the
        // counterparty — deliberately anchored to a NON-masked user so CM-4's
        // whole-payload grep isolates a genuine *counterparty* identity leak.
        createdBy: DROP_1.id,
      })
      .onConflictDoNothing()

    // ── CM-6: admin-personal PAYOUT_DROP linked to the drop's payout request ──
    await db
      .insert(transactions)
      .values({
        id: TX_PR_ADMIN_ID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '260',
        currency: 'USDT',
        senderId: ADMIN_MAKSYM.id,
        senderLabel: ADMIN_MAKSYM.displayName,
        fundingSource: null,
        receiverId: DROP_1.id,
        recipientId: DROP_1.id,
        payoutRequestId: PR_1_ID,
        // `createdBy` is an audit field (who booked the row), NOT the
        // counterparty — deliberately anchored to a NON-masked user so CM-4's
        // whole-payload grep isolates a genuine *counterparty* identity leak.
        createdBy: DROP_1.id,
      })
      .onConflictDoNothing()

    // ── CM-8 (MED-1): admin-personal PAYOUT_DROP, payer admin DELETED ─────────
    // senderId=null (as ON DELETE SET NULL would leave it) but senderLabel still
    // carries the deleted admin's snapshot name + fundingSource='ADMIN_PERSONAL'
    // — the exact shape `isAdminPartner` (which requires a live sideId) misses,
    // and which `isOrphanedAdminPersonalPayer` must catch instead.
    await db
      .insert(transactions)
      .values({
        id: TX_DROP_DELETED_ADMIN_ID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '260',
        currency: 'USDT',
        senderId: null,
        senderLabel: DELETED_ADMIN_LABEL,
        fundingSource: 'ADMIN_PERSONAL',
        receiverId: DROP_1.id,
        recipientId: DROP_1.id,
        // `createdBy` is an audit field (who booked the row), NOT the
        // counterparty — deliberately anchored to a NON-masked user so CM-4's
        // whole-payload grep isolates a genuine *counterparty* identity leak.
        createdBy: DROP_1.id,
      })
      .onConflictDoNothing()

    // ── CB: company-funded PAYOUT_DROP to the drop, BOOKED BY the ADMIN ────────
    // Counterparty = company pool (senderId=null, senderLabel='COMPANY') so the
    // sender masking has nothing admin-shaped to hide. `createdBy=admin` is the
    // ONLY vector for the admin's UUID — proving createdBy masking on its own.
    await db
      .insert(transactions)
      .values({
        id: TX_CB_ADMIN_ID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '260',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'COMPANY',
        fundingSource: 'COMPANY_ACCOUNT',
        receiverId: DROP_1.id,
        recipientId: DROP_1.id,
        createdBy: ADMIN_MAKSYM.id,
      })
      .onConflictDoNothing()

    // ── CB-5: company-funded PAYOUT_DROP LINKED to the drop's payout request, ──
    // BOOKED + VALIDATED by the admin. Counterparty = company pool
    // (senderId=null, senderLabel='COMPANY') so neither audit UUID has a
    // counterparty vector — createdBy=admin AND validatedBy=admin are the only
    // ways the admin's id can surface, proving both audit-field masks on the
    // findPayoutRequest (third mapTx) call site.
    await db
      .insert(transactions)
      .values({
        id: TX_CB_PR_ADMIN_ID,
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '260',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'COMPANY',
        fundingSource: 'COMPANY_ACCOUNT',
        receiverId: DROP_1.id,
        recipientId: DROP_1.id,
        payoutRequestId: PR_1_ID,
        createdBy: ADMIN_MAKSYM.id,
        validatedBy: ADMIN_MAKSYM.id,
        validatedAt: new Date('2026-01-15T10:00:00Z'),
      })
      .onConflictDoNothing()
  })

  afterAll(async () => {
    if (!_pool)
      throw new Error(
        '[require-real-db] _pool not initialized — beforeAll should have thrown already',
      )
    const db = drizzle(_pool, { schema })
    await db
      .delete(transactions)
      .where(inArray(transactions.id, ALL_TX_IDS))
      .catch(() => undefined)
    await db
      .delete(payoutRequests)
      .where(inArray(payoutRequests.id, [PR_1_ID]))
      .catch(() => undefined)
    await db
      .delete(users)
      .where(inArray(users.id, ALL_USER_IDS))
      .catch(() => undefined)
    await _pool.end()
  })

  // ── CM-1: company-funded — DROP masked, ADMIN raw ─────────────────────────

  it('CM-1 — company-funded PAYOUT_DROP: DROP sees «CheekyCheeseIT», ADMIN sees raw COMPANY', async () => {
    const dropRow = (await svc.findAll(DROP_1)).find((t) => t.id === TX_DROP_COMPANY_ID)
    expect(dropRow, 'drop must see their own PAYOUT_DROP row').toBeDefined()
    expect(dropRow!.senderLabel).toBe('CheekyCheeseIT')
    expect(dropRow!.senderId).toBeNull()
    expect(dropRow!.senderName).toBeNull()

    const adminRow = (await svc.findAll(ADMIN_MAKSYM)).find((t) => t.id === TX_DROP_COMPANY_ID)
    expect(adminRow, 'admin sees the row in the unfiltered list').toBeDefined()
    // Privileged: raw 'COMPANY' literal passes through unmasked (the front-end
    // display layer maps it to «Счёт компании»).
    expect(adminRow!.senderLabel).toBe('COMPANY')
  })

  // ── CM-2 / CM-7: admin-personal — DROP masked (no admin identity), ACCOUNTANT real

  it('CM-2 — admin-personal PAYOUT_DROP: DROP gets no admin id/name, ACCOUNTANT gets the real admin', async () => {
    const dropRow = (await svc.findAll(DROP_1)).find((t) => t.id === TX_DROP_ADMIN_ID)
    expect(dropRow, 'drop must see their own PAYOUT_DROP row').toBeDefined()
    expect(dropRow!.senderLabel).toBe('CheekyCheeseIT')
    expect(dropRow!.senderId).toBeNull()
    expect(dropRow!.senderName).toBeNull()
    // CM-7: the recipient (the drop themselves) is never masked.
    expect(dropRow!.receiverId).toBe(DROP_1.id)
    expect(dropRow!.receiverName).toBe(DROP_1.displayName)

    const acctRow = (await svc.findAll(ACCOUNTANT_1)).find((t) => t.id === TX_DROP_ADMIN_ID)
    expect(acctRow, 'accountant sees the row').toBeDefined()
    expect(acctRow!.senderId).toBe(ADMIN_MAKSYM.id)
    expect(acctRow!.senderName).toBe(ADMIN_MAKSYM.displayName)
  })

  // ── CM-3: external client is NOT masked for anyone ────────────────────────

  it('CM-3 — external-client SENIOR_INCOME is NOT masked (SENIOR and ADMIN both see the client)', async () => {
    const seniorRow = (await svc.findAll(SENIOR_1)).find((t) => t.id === TX_SENIOR_CLIENT_ID)
    expect(seniorRow, 'senior sees their own income row').toBeDefined()
    expect(seniorRow!.senderLabel).toBe(EXTERNAL_CLIENT_LABEL)

    const adminRow = (await svc.findAll(ADMIN_MAKSYM)).find((t) => t.id === TX_SENIOR_CLIENT_ID)
    expect(adminRow!.senderLabel).toBe(EXTERNAL_CLIENT_LABEL)
  })

  // ── CM-4: whole-response security grep — no admin identity leaks to DROP ───

  it('CM-4 — DROP findAll payload contains NO admin displayName or id anywhere', async () => {
    // Whole-response grep: the internal ADMIN counterparty's real identity must
    // never appear in the network payload of a non-privileged viewer — neither
    // the human-readable displayName nor the enumerable user id. This is the
    // core security AC (RBAC masking, not CSS-hiding). `createdBy` is anchored
    // to a non-masked user in the seed so this asserts a *counterparty* leak.
    const dropPayload = JSON.stringify(await svc.findAll(DROP_1))
    expect(dropPayload).not.toContain(ADMIN_MAKSYM.displayName)
    expect(dropPayload).not.toContain(ADMIN_MAKSYM.id)
    // MED-1: the deleted admin's snapshot label must not leak either — its id
    // is already gone (senderId=null), so ONLY the label check is meaningful.
    expect(dropPayload).not.toContain(DELETED_ADMIN_LABEL)
  })

  // ── CM-5: findOne path masks admin-personal for DROP, discloses for ACCOUNTANT

  it('CM-5 — findOne masks the admin counterparty for DROP, discloses it for ACCOUNTANT', async () => {
    const dropOne = await svc.findOne(TX_DROP_ADMIN_ID, DROP_1)
    expect(dropOne.senderLabel).toBe('CheekyCheeseIT')
    expect(dropOne.senderId).toBeNull()
    expect(dropOne.senderName).toBeNull()

    const acctOne = await svc.findOne(TX_DROP_ADMIN_ID, ACCOUNTANT_1)
    expect(acctOne.senderId).toBe(ADMIN_MAKSYM.id)
    expect(acctOne.senderName).toBe(ADMIN_MAKSYM.displayName)
  })

  // ── CM-6: findPayoutRequest path (third mapTx call site) ──────────────────

  it('CM-6 — findPayoutRequest masks the admin counterparty for the owning DROP, real for ACCOUNTANT', async () => {
    const dropReq = await svc.findPayoutRequest(PR_1_ID, DROP_1)
    const dropTx = dropReq.transactions.find((t) => t.id === TX_PR_ADMIN_ID)
    expect(dropTx, 'linked tx must be present for the owner').toBeDefined()
    expect(dropTx!.senderLabel).toBe('CheekyCheeseIT')
    expect(dropTx!.senderId).toBeNull()
    expect(dropTx!.senderName).toBeNull()

    const acctReq = await svc.findPayoutRequest(PR_1_ID, ACCOUNTANT_1)
    const acctTx = acctReq.transactions.find((t) => t.id === TX_PR_ADMIN_ID)
    expect(acctTx!.senderId).toBe(ADMIN_MAKSYM.id)
    expect(acctTx!.senderName).toBe(ADMIN_MAKSYM.displayName)
  })

  // ── CM-8 (MED-1): deleted admin-personal payer — orphaned senderId=null ────

  it('CM-8 — admin-personal payer DELETED (senderId=null, fundingSource=ADMIN_PERSONAL): DROP still gets CheekyCheeseIT, ADMIN sees the snapshot label', async () => {
    const dropRow = (await svc.findAll(DROP_1)).find((t) => t.id === TX_DROP_DELETED_ADMIN_ID)
    expect(dropRow, 'drop must see their own PAYOUT_DROP row').toBeDefined()
    // Before the MED-1 fix, isAdminPartner required a live sideId and this
    // branch never fired once senderId went null — the snapshot label leaked
    // straight through. It must now be masked exactly like a live admin.
    expect(dropRow!.senderLabel).toBe('CheekyCheeseIT')
    expect(dropRow!.senderId).toBeNull()
    expect(dropRow!.senderName).toBeNull()

    const acctRow = (await svc.findAll(ACCOUNTANT_1)).find((t) => t.id === TX_DROP_DELETED_ADMIN_ID)
    expect(acctRow, 'accountant sees the row').toBeDefined()
    // Privileged viewer still sees the raw snapshot label (the id is gone
    // regardless of viewer — that part of the FK cascade is unaffected by RBAC).
    expect(acctRow!.senderLabel).toBe(DELETED_ADMIN_LABEL)
    expect(acctRow!.senderId).toBeNull()

    // Receiver-safety (no over-masking): the recipient (the drop) on THIS same
    // fundingSource='ADMIN_PERSONAL' row must NOT be affected by the new
    // condition — they have a real, non-null id and are not the payer.
    expect(dropRow!.receiverId).toBe(DROP_1.id)
    expect(dropRow!.receiverName).toBe(DROP_1.displayName)
    expect(acctRow!.receiverId).toBe(DROP_1.id)
    expect(acctRow!.receiverName).toBe(DROP_1.displayName)
  })

  // ── CB-1: createdBy (registrar) masking on findAll ────────────────────────

  it('CB-1 — admin-booked row: DROP sees createdBy=null, ACCOUNTANT sees the real admin UUID', async () => {
    const dropRow = (await svc.findAll(DROP_1)).find((t) => t.id === TX_CB_ADMIN_ID)
    expect(dropRow, 'drop must see their own PAYOUT_DROP row').toBeDefined()
    // The registrar audit UUID (an ADMIN) is stripped for the non-privileged
    // viewer — same defense-in-depth as the counterparty masking.
    expect(dropRow!.createdBy).toBeNull()

    const acctRow = (await svc.findAll(ACCOUNTANT_1)).find((t) => t.id === TX_CB_ADMIN_ID)
    expect(acctRow, 'accountant sees the row').toBeDefined()
    expect(acctRow!.createdBy).toBe(ADMIN_MAKSYM.id)

    const adminRow = (await svc.findAll(ADMIN_MAKSYM)).find((t) => t.id === TX_CB_ADMIN_ID)
    expect(adminRow!.createdBy).toBe(ADMIN_MAKSYM.id)
  })

  // ── CB-2: same masking on the findOne call site ───────────────────────────

  it('CB-2 — findOne masks createdBy for DROP, discloses it for ACCOUNTANT', async () => {
    const dropOne = await svc.findOne(TX_CB_ADMIN_ID, DROP_1)
    expect(dropOne.createdBy).toBeNull()

    const acctOne = await svc.findOne(TX_CB_ADMIN_ID, ACCOUNTANT_1)
    expect(acctOne.createdBy).toBe(ADMIN_MAKSYM.id)
  })

  // ── CB-3: self-preserve (non-regression for canAttachReceipt author gate) ──

  it('CB-3 — a viewer sees their OWN createdBy on rows they authored (not nulled)', async () => {
    // TX_DROP_COMPANY_ID is seeded with createdBy=DROP_1.id (the drop authored
    // it). Masking must NOT strip the viewer's own id — otherwise the frontend
    // `canAttachReceipt` author gate (`createdBy === currentUserId`) would drop
    // the receipt attach/replace affordance on self-declared income. The own id
    // is not a leak (the viewer already knows it).
    const dropRow = (await svc.findAll(DROP_1)).find((t) => t.id === TX_DROP_COMPANY_ID)
    expect(dropRow, 'drop must see their own row').toBeDefined()
    expect(dropRow!.createdBy).toBe(DROP_1.id)

    // Foreign creator (a DIFFERENT non-privileged user) is still masked: SENIOR
    // views the external-client income whose createdBy is DROP_1.id → nulled.
    const seniorRow = (await svc.findAll(SENIOR_1)).find((t) => t.id === TX_SENIOR_CLIENT_ID)
    expect(seniorRow, 'senior sees their own income row').toBeDefined()
    expect(seniorRow!.createdBy).toBeNull()
  })

  // ── CB-4: whole-payload security grep — no admin registrar UUID for DROP ───

  it('CB-4 — DROP findAll payload never carries the admin registrar UUID via createdBy', async () => {
    // The CB seed row (TX_CB_ADMIN_ID) is company-funded with senderId=null, so
    // the admin's UUID has no counterparty vector — if it appears anywhere in
    // the DROP payload it can ONLY be an un-masked createdBy leak.
    const dropPayload = JSON.stringify(await svc.findAll(DROP_1))
    expect(dropPayload).not.toContain(ADMIN_MAKSYM.id)
  })

  // ── CB-5: createdBy + validatedBy masking on the findPayoutRequest path ────

  it('CB-5 — findPayoutRequest masks createdBy AND validatedBy for the owning DROP, discloses both for ADMIN/ACCOUNTANT', async () => {
    // The owning DROP views their own payout request. The linked, company-funded
    // row was booked AND validated by the admin — but the admin is NEITHER the
    // counterparty (company pool) NOR the viewer, so both audit UUIDs must be
    // stripped. Mirrors CM-6 (counterparty on the same third mapTx call site).
    const dropReq = await svc.findPayoutRequest(PR_1_ID, DROP_1)
    const dropTx = dropReq.transactions.find((t) => t.id === TX_CB_PR_ADMIN_ID)
    expect(dropTx, 'linked CB-5 tx must be present for the owner').toBeDefined()
    expect(dropTx!.createdBy).toBeNull()
    expect(dropTx!.validatedBy).toBeNull()

    // Privileged viewers see the real admin UUID on BOTH audit fields.
    const acctReq = await svc.findPayoutRequest(PR_1_ID, ACCOUNTANT_1)
    const acctTx = acctReq.transactions.find((t) => t.id === TX_CB_PR_ADMIN_ID)
    expect(acctTx!.createdBy).toBe(ADMIN_MAKSYM.id)
    expect(acctTx!.validatedBy).toBe(ADMIN_MAKSYM.id)

    const adminReq = await svc.findPayoutRequest(PR_1_ID, ADMIN_MAKSYM)
    const adminTx = adminReq.transactions.find((t) => t.id === TX_CB_PR_ADMIN_ID)
    expect(adminTx!.createdBy).toBe(ADMIN_MAKSYM.id)
    expect(adminTx!.validatedBy).toBe(ADMIN_MAKSYM.id)
  })
})
