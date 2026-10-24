/**
 * Characterization (unit) net for the payout-SETTLE cluster of
 * `TransactionsService`:
 *
 *   - `payPayoutRequest`        — on-chain happy path (SENIOR / DROP self-service)
 *   - `manualConfirmPayout`     — ADMIN / ACCOUNTANT escape hatch
 *   - `applyPayoutPaidCascade`  — the PRIVATE shared "mark PAID + cascade" core,
 *                                 reached ONLY through the two entry points above
 *
 * Why this file exists: before this spec NO unit test called either entry
 * point — only integration specs (real Postgres) did, and the mutation gate
 * runs unit-only. The cascade holds the money invariants (atomic flip, hash
 * claim, ledger fan-out), so its observable behaviour is pinned here BEFORE the
 * cluster is moved into its own service. Everything below pins CURRENT
 * behaviour; where the code carries a known quirk the test says so.
 *
 * The db is an event-recording double: every call on the pooled client or on the
 * transaction handle is appended to ONE log, so the write ORDER inside the
 * cascade (and its position relative to commit / invoice trigger) is asserted
 * from the log rather than guessed. `where` predicates are compiled with the
 * real `PgDialect` (see `compileWhere`) so a flipped operator or a dropped
 * predicate term is observable even though the executor is stubbed.
 *
 * Scope note on lock order: the cascade itself takes NO explicit lock
 * (`lockCompanyAccount` / `pending_obligations` locking live in the settle /
 * edit paths, not here). Its serialization point is the conditional
 * `UPDATE payout_requests … WHERE status='PENDING' RETURNING`; the order test
 * below pins that this claim is the FIRST write of the transaction and that the
 * transaction rows are only touched after it.
 */
import { ForbiddenException, HttpStatus, type Logger } from '@nestjs/common'
import { getTableName } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { compileWhere, collectParamValues } from './__test-helpers__/drizzle-where-introspection'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { PayoutRequestReadService } from './payout-request-read.service'

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function user(
  role: SessionUser['role'],
  id: string,
  extra: Partial<SessionUser> = {},
): SessionUser {
  return {
    id,
    role,
    displayName: id,
    email: `${id}@x.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
    ...extra,
  }
}

const SENIOR = user('SENIOR', 'senior-1')
const OTHER_SENIOR = user('SENIOR', 'senior-2')
const DROP = user('DROP', 'drop-1')
const ADMIN = user('ADMIN', 'admin-1')
const ACCOUNTANT = user('ACCOUNTANT', 'acc-1')
const JUNIOR = user('JUNIOR', 'junior-1')
const HR = user('HR', 'hr-1')

const REQUEST_ID = 'req-1'
const PAYOUT_ROW_ID = 'payout-tx-1'
const NOW = new Date('2026-06-15T12:00:00.000Z')

/** 0x + 64 hex, lowercase — the canonical form the registry stores. */
const HASH = `0x${'ab'.repeat(32)}`
const HASH_LINK_MIXED_CASE = `https://etherscan.io/tx/0x${'AB'.repeat(32)}`
const WALLET = '0x00000000000000000000000000000000000000c0'
const SENDER_MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
const SENDER_LOWER = '0xabcdef0123456789abcdef0123456789abcdef01'

function requestRow(overrides: Row = {}): Row {
  return {
    id: REQUEST_ID,
    seniorId: SENIOR.id,
    incomeAmount: '1234.560000',
    payableAmount: '740.070000',
    contractAddress: WALLET,
    txHash: null,
    txFromAddress: null,
    status: 'PENDING',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  }
}

// ── Event-recording db double ───────────────────────────────────────────────

interface Ev {
  label: string
  table?: string
  set?: Row
  values?: Row
  where?: { sql: string; params: unknown[] }
}

interface World {
  req: Row | undefined
  /** `payoutRequests.findFirst` filtered by tx_hash (pre-check / in-tx reuse guard). */
  reusedPaid: Row | undefined
  companyAccount: Row | undefined
  consumed: Row | undefined
  claimRows: Row[]
  payoutSource: Row[]
  previousClaim: Row[]
  incomes: Row[]
  payoutUpdateRows: Row[]
  existingPayout: Row[]
  projectsById: Record<string, Row>
  usersById: Record<string, Row>
  teamMembers: Row[]
  /** throw this from the first write whose label matches (e.g. 'insert consumed_tx_hashes'). */
  failOn: { label: string; error: unknown } | undefined
  verification: Row
}

function defaultWorld(): World {
  return {
    req: requestRow(),
    reusedPaid: undefined,
    companyAccount: { walletAddress: WALLET, confirmationThreshold: 12 },
    consumed: undefined,
    claimRows: [{ id: REQUEST_ID }],
    payoutSource: [
      { id: PAYOUT_ROW_ID, txDate: null, createdAt: new Date('2026-06-01T10:00:00.000Z') },
    ],
    previousClaim: [],
    incomes: [],
    payoutUpdateRows: [{ id: PAYOUT_ROW_ID }],
    existingPayout: [{ id: 'existing-payout-tx' }],
    projectsById: {},
    usersById: {},
    teamMembers: [],
    failOn: undefined,
    verification: {
      found: true,
      toMatches: true,
      fromAddress: SENDER_MIXED,
      confirmed: true,
      confirmations: 20,
      amountUsdt: 740.07,
      amountUsdtMinor: '740070000',
    },
  }
}

function build(patch: Partial<World> = {}) {
  const world: World = { ...defaultWorld(), ...patch }
  const events: Ev[] = []
  let iouSeq = 0
  /** Column selection handed to each `update … returning(...)` (table + field names). */
  const returned: { table: string; keys: string[] }[] = []

  const record = (ev: Ev) => {
    events.push(ev)
    if (world.failOn && world.failOn.label === ev.label) {
      const { error } = world.failOn
      world.failOn = undefined
      throw error
    }
  }

  const thenableOf = <T>(value: T, extra: Row = {}) =>
    Object.assign(
      {
        then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(value).then(res, rej),
      },
      extra,
    )

  const makeExecutor = (scope: 'base' | 'tx') => {
    const prefix = scope === 'base' ? 'base ' : ''
    return {
      update: (table: unknown) => {
        const name = getTableName(table as never)
        return {
          set: (set: Row) => ({
            where: (pred: unknown) => {
              record({
                label: `${prefix}update ${name}`,
                table: name,
                set,
                where: compileWhere(pred),
              })
              return thenableOf(undefined, {
                returning: async (fields?: Row) => {
                  returned.push({ table: name, keys: Object.keys(fields ?? {}) })
                  if (name === 'payout_requests') return world.claimRows
                  if (name === 'transactions') return world.payoutUpdateRows
                  throw new Error(`unscripted update returning on ${name}`)
                },
              })
            },
          }),
        }
      },
      insert: (table: unknown) => {
        const name = getTableName(table as never)
        return {
          values: (values: Row) => {
            record({ label: `${prefix}insert ${name}`, table: name, values })
            return thenableOf(undefined, {
              returning: async () => {
                if (name === 'consumed_tx_hashes') return [{ id: 'claim-1' }]
                if (name === 'transactions') {
                  iouSeq += 1
                  return [{ id: `iou-${iouSeq}`, ...values }]
                }
                throw new Error(`unscripted insert returning on ${name}`)
              },
            })
          },
        }
      },
      select: (fields: Row) => ({
        from: (table: unknown) => {
          const name = getTableName(table as never)
          const keys = Object.keys(fields).join(',')
          let where: Ev['where']
          const resolve = (): Row[] => {
            if (name === 'transactions' && keys === 'id,txDate,createdAt') return world.payoutSource
            if (
              name === 'transactions' &&
              keys === 'id,projectId,type,dropSharePercent,dropSharePercentSource'
            )
              return world.incomes
            if (name === 'transactions' && keys === 'id') return world.existingPayout
            if (name === 'consumed_tx_hashes' && keys === 'releasedAt') return world.previousClaim
            throw new Error(`unscripted select ${name}(${keys})`)
          }
          const finish = () => {
            record({ label: `${prefix}select ${name}`, table: name, ...(where ? { where } : {}) })
            return resolve()
          }
          let cached: Row[] | undefined
          const get = () => (cached ??= finish())
          const self: Row = {
            where: (pred: unknown) => {
              where = compileWhere(pred)
              return self
            },
            orderBy: () => self,
            limit: () => self,
            then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) => {
              try {
                return Promise.resolve(get()).then(res, rej)
              } catch (e) {
                return Promise.reject(e).then(res, rej)
              }
            },
          }
          return self
        },
      }),
      query: {
        payoutRequests: {
          findFirst: async (args: { where: unknown }) => {
            const where = compileWhere(args.where)
            record({ label: `${prefix}query payoutRequests`, table: 'payout_requests', where })
            return where.sql.includes('"tx_hash"') ? world.reusedPaid : world.req
          },
        },
        companyAccount: {
          findFirst: async () => {
            record({ label: `${prefix}query companyAccount`, table: 'company_account' })
            return world.companyAccount
          },
        },
        consumedTxHashes: {
          findFirst: async (args: { where: unknown }) => {
            record({
              label: `${prefix}query consumedTxHashes`,
              table: 'consumed_tx_hashes',
              where: compileWhere(args.where),
            })
            return world.consumed
          },
        },
        projects: {
          findFirst: async (args: { where: unknown }) => {
            const where = compileWhere(args.where)
            record({ label: `${prefix}query projects`, table: 'projects', where })
            return world.projectsById[String(where.params[0])]
          },
        },
        users: {
          findFirst: async (args: { where: unknown }) => {
            const where = compileWhere(args.where)
            record({ label: `${prefix}query users`, table: 'users', where })
            return world.usersById[String(collectParamValues(args.where)[0])]
          },
        },
        teamMembers: {
          findMany: async () => {
            record({ label: `${prefix}query teamMembers`, table: 'team_members' })
            return world.teamMembers
          },
        },
      },
    }
  }

  const txExec = makeExecutor('tx')
  const baseExec = {
    ...makeExecutor('base'),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      events.push({ label: 'tx-begin' })
      try {
        const out = await cb(txExec)
        events.push({ label: 'tx-commit' })
        return out
      } catch (e) {
        events.push({ label: 'tx-rollback' })
        throw e
      }
    },
  }

  const verifyDeposit = vi.fn(async () => world.verification)
  const safeAutoCreateInvoice = vi.fn(async (kind: string, id: string) => {
    events.push({ label: `invoice ${kind} ${id}` })
  })

  const svc = makeTransactionsService({
    db: { db: baseExec } as never,
    etherscanService: { verifyDeposit } as never,
    lifecycleService: { safeAutoCreateInvoice } as never,
  })
  const findPayoutRequest = vi
    .spyOn(
      (svc as unknown as { payoutRead: PayoutRequestReadService }).payoutRead,
      'findPayoutRequest',
    )
    .mockImplementation(async (id: string) => {
      events.push({ label: 'findPayoutRequest' })
      return { id, marker: 'found' } as never
    })
  const logger = (svc as unknown as { payoutSettle: { logger: Logger } }).payoutSettle.logger
  // The claim path warns through OnChainClaimService's own logger; one shared
  // mock records warnings from both the settlement service and the claim collaborator.
  const claimLogger = (svc as unknown as { onChainClaim: { logger: Logger } }).onChainClaim.logger
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  vi.spyOn(claimLogger, 'warn').mockImplementation((...args) => warn(...args))
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)

  const labels = () => events.map((e) => e.label)
  const find = (label: string) => events.filter((e) => e.label === label)
  const one = (label: string) => {
    const hits = find(label)
    expect(hits, `expected exactly one "${label}" in ${JSON.stringify(labels())}`).toHaveLength(1)
    return hits[0]!
  }

  return {
    svc,
    world,
    events,
    returned,
    labels,
    find,
    one,
    verifyDeposit,
    safeAutoCreateInvoice,
    findPayoutRequest,
    warn,
    error,
  }
}

type H = ReturnType<typeof build>

/** A drop-project world: one DROP_INCOME linked, project bound to a drop + senior. */
function dropWorld(over: Partial<World> = {}, incomeOver: Row = {}): Partial<World> {
  return {
    incomes: [
      {
        id: 'inc-1',
        projectId: 'proj-1',
        type: 'DROP_INCOME',
        dropSharePercent: 10,
        dropSharePercentSource: 'PROJECT',
        ...incomeOver,
      },
    ],
    projectsById: {
      'proj-1': {
        id: 'proj-1',
        dropId: 'drop-1',
        seniorId: 'senior-1',
        companyName: 'Acme',
        seniorSharePercentOverride: null,
        dropSharePercentOverride: null,
      },
    },
    usersById: {
      'drop-1': { id: 'drop-1', dropSharePercent: 7 },
      'senior-1': { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 26 },
    },
    ...over,
  }
}

const PRODUCTION_LIKE = ['production', 'staging', ''] as const

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function expectApiError(p: Promise<unknown>, code: string, status: number) {
  await expect(p).rejects.toMatchObject({ response: { code, statusCode: status } })
}

// ═══════════════════════════════════════════════════════════════════════════
// payPayoutRequest
// ═══════════════════════════════════════════════════════════════════════════

describe('payPayoutRequest — gates (nothing is read or written on refusal)', () => {
  it.each([ADMIN, ACCOUNTANT, JUNIOR, HR])(
    '$role is refused with 403 before ANY db access',
    async (u) => {
      const h = build()
      await expect(h.svc.payPayoutRequest(REQUEST_ID, HASH, u)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(h.events).toEqual([])
    },
  )

  it('unknown request → 404 FINANCE_PAYOUT_REQUEST_NOT_FOUND', async () => {
    const h = build({ req: undefined })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_PAYOUT_REQUEST_NOT_FOUND',
      HttpStatus.NOT_FOUND,
    )
    expect(h.labels()).toEqual(['base query payoutRequests'])
  })

  it('the lookup is by request id', async () => {
    const h = build({ req: undefined })
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR).catch(() => undefined)
    const where = h.one('base query payoutRequests').where!
    expect(where.sql).toBe('"payout_requests"."id" = $1')
    expect(where.params).toEqual([REQUEST_ID])
  })

  it('a payout owned by someone else → 403 (ownership beats status: a PAID foreign payout is 403, not 400)', async () => {
    const h = build({ req: requestRow({ seniorId: OTHER_SENIOR.id, status: 'PAID' }) })
    await expect(h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(h.labels()).toEqual(['base query payoutRequests'])
  })

  it.each(['PAID', 'REJECTED'])(
    'own payout in status %s → 400 ALREADY_PAID, no transaction opened',
    async (status) => {
      const h = build({ req: requestRow({ status }) })
      await expectApiError(
        h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
        'FINANCE_PAYOUT_REQUEST_ALREADY_PAID',
        HttpStatus.BAD_REQUEST,
      )
      expect(h.labels()).toEqual(['base query payoutRequests'])
      expect(h.verifyDeposit).not.toHaveBeenCalled()
    },
  )

  it('a DROP user owning the payout (drop-project flow: seniorId = the drop) passes the gates', async () => {
    const h = build({ req: requestRow({ seniorId: DROP.id }) })
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, DROP)
    expect(h.labels()).toContain('tx-commit')
  })
})

describe('payPayoutRequest — dev-simulate toggle is fail-closed', () => {
  it('development + simulateResult=error → 400 SIMULATION_TX_NOT_CONFIRMED, nothing written', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const h = build()
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, undefined, SENIOR, 'error'),
      'FINANCE_SIMULATION_TX_NOT_CONFIRMED',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).toEqual(['base query payoutRequests'])
  })

  it('test env also counts as non-production for simulate', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    const h = build()
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, undefined, SENIOR, 'error'),
      'FINANCE_SIMULATION_TX_NOT_CONFIRMED',
      HttpStatus.BAD_REQUEST,
    )
  })

  it.each(PRODUCTION_LIKE)(
    'NODE_ENV=%j ignores simulateResult=success: no hash → 400 TX_HASH_REQUIRED, Etherscan path never reached',
    async (env) => {
      vi.stubEnv('NODE_ENV', env)
      const h = build()
      await expectApiError(
        h.svc.payPayoutRequest(REQUEST_ID, undefined, SENIOR, 'success'),
        'FINANCE_TX_HASH_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
      expect(h.labels()).toEqual(['base query payoutRequests'])
    },
  )

  it.each(PRODUCTION_LIKE)(
    'NODE_ENV=%j ignores simulateResult=error too (it is NOT a refusal outside dev)',
    async (env) => {
      vi.stubEnv('NODE_ENV', env)
      const h = build()
      await expectApiError(
        h.svc.payPayoutRequest(REQUEST_ID, undefined, SENIOR, 'error'),
        'FINANCE_TX_HASH_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
    },
  )

  it('NODE_ENV unset is treated as production', async () => {
    vi.stubEnv('NODE_ENV', undefined as unknown as string)
    delete process.env['NODE_ENV']
    const h = build()
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, undefined, SENIOR, 'success'),
      'FINANCE_TX_HASH_REQUIRED',
      HttpStatus.BAD_REQUEST,
    )
  })

  it('development + simulateResult=success: synthesizes a 0xSIM marker (0xSIM + 56 hex), skips Etherscan / wallet / registry reads, still credits the company account', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const h = build()
    const out = await h.svc.payPayoutRequest(REQUEST_ID, undefined, SENIOR, 'success')

    expect(out).toEqual({ id: REQUEST_ID, marker: 'found' })
    expect(h.verifyDeposit).not.toHaveBeenCalled()
    expect(h.labels()).not.toContain('base query companyAccount')
    expect(h.labels()).not.toContain('base query consumedTxHashes')

    const claim = h.one('update payout_requests')
    expect(claim.set!['txHash']).toMatch(/^0xSIM[0-9a-f]{56}$/)
    expect(claim.set!['txFromAddress']).toBeNull()
    const payout = h.find('update transactions')[1]!
    expect(payout.set!['txHash']).toBe(claim.set!['txHash'])
    expect(payout.set!['fundingSource']).toBe('COMPANY_ACCOUNT')
    // synthetic marker is not an on-chain hash → nothing claimed in the registry
    expect(h.labels()).not.toContain('insert consumed_tx_hashes')
  })

  it('development + simulate with a SUPPLIED valid hash uses that hash (simulate does not override it)', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR, 'success')
    expect(h.one('update payout_requests').set!['txHash']).toBe(HASH)
    expect(h.one('insert consumed_tx_hashes').values!['txHash']).toBe(HASH)
    expect(h.verifyDeposit).not.toHaveBeenCalled()
  })

  it('development + simulate + whitespace-only hash is "no hash" → still a 0xSIM marker', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, '   ', SENIOR, 'success')
    expect(h.one('update payout_requests').set!['txHash']).toMatch(/^0xSIM[0-9a-f]{56}$/)
  })
})

describe('payPayoutRequest — hash shape', () => {
  it('a supplied-but-unparseable hash fails LOUD with 400 TX_HASH_INVALID (even in dev-simulate)', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const h = build()
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, '0xshort', SENIOR, 'success'),
      'FINANCE_TX_HASH_INVALID',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).toEqual(['base query payoutRequests'])
  })

  it('production: undefined hash → 400 TX_HASH_REQUIRED; whitespace-only hash is the same (not INVALID)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    for (const raw of [undefined, '', '   ']) {
      const h = build()
      await expectApiError(
        h.svc.payPayoutRequest(REQUEST_ID, raw, SENIOR),
        'FINANCE_TX_HASH_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
    }
  })

  it('an explorer link is reduced to the lowercase hash, and THAT is what is verified, stored and claimed', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH_LINK_MIXED_CASE, SENIOR)
    expect(h.verifyDeposit).toHaveBeenCalledWith(HASH, WALLET, 12)
    expect(h.one('update payout_requests').set!['txHash']).toBe(HASH)
    expect(h.one('insert consumed_tx_hashes').values!['txHash']).toBe(HASH)
  })
})

describe('payPayoutRequest — on-chain verification (production semantics)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
  })

  it('no company wallet row → 400 COMPANY_WALLET_NOT_CONFIGURED; nothing else read', async () => {
    const h = build({ companyAccount: undefined })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_COMPANY_WALLET_NOT_CONFIGURED',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).toEqual(['base query payoutRequests', 'base query companyAccount'])
  })

  it('a company row with an empty wallet is the same refusal', async () => {
    const h = build({ companyAccount: { walletAddress: null, confirmationThreshold: 12 } })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_COMPANY_WALLET_NOT_CONFIGURED',
      HttpStatus.BAD_REQUEST,
    )
  })

  it('hash already consumed by ANY path → 400 ALREADY_CONSUMED before Etherscan is called', async () => {
    const h = build({ consumed: { purpose: 'COMPANY_DEPOSIT', referenceId: 'dep-1' } })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_TX_HASH_ALREADY_CONSUMED',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.verifyDeposit).not.toHaveBeenCalled()
    expect(h.labels()).not.toContain('tx-begin')
  })

  it('legacy guard: a hash already on a PAID payout → 400 USED_FOR_OTHER_PAYOUT, scoped by hash AND status=PAID', async () => {
    const h = build({ reusedPaid: { id: 'other-req' } })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT',
      HttpStatus.BAD_REQUEST,
    )
    const reuse = h.find('base query payoutRequests')[1]!.where!
    expect(reuse.sql).toBe('("payout_requests"."tx_hash" = $1 and "payout_requests"."status" = $2)')
    expect(reuse.params).toEqual([HASH, 'PAID'])
    expect(h.verifyDeposit).not.toHaveBeenCalled()
  })

  it('verification asks Etherscan with (hash, company wallet, confirmation threshold)', async () => {
    const h = build({ companyAccount: { walletAddress: WALLET, confirmationThreshold: 7 } })
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)
    expect(h.verifyDeposit).toHaveBeenCalledWith(HASH, WALLET, 7)
  })

  it('recipient mismatch → 400 (checked before confirmation: both failing reports the recipient)', async () => {
    const h = build({
      verification: { ...defaultWorld().verification, toMatches: false, confirmed: false },
    })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).not.toContain('tx-begin')
  })

  it('not enough confirmations → 400 NOT_CONFIRMED_ONCHAIN', async () => {
    const h = build({ verification: { ...defaultWorld().verification, confirmed: false } })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_TX_NOT_CONFIRMED_ONCHAIN',
      HttpStatus.BAD_REQUEST,
    )
  })

  it.each([
    ['one minor unit below', '740069999'],
    ['one minor unit above', '740070001'],
    ['unresolved (null)', null],
    ['malformed', 'not-a-number'],
    ['zero', '0'],
  ])(
    'EXACT amount: transferred %s → 400 ONCHAIN_AMOUNT_MISMATCH, payout stays PENDING',
    async (_n, minor) => {
      const h = build({ verification: { ...defaultWorld().verification, amountUsdtMinor: minor } })
      await expectApiError(
        h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
        'FINANCE_ONCHAIN_AMOUNT_MISMATCH',
        HttpStatus.BAD_REQUEST,
      )
      expect(h.labels()).not.toContain('tx-begin')
    },
  )

  it('a zero payable never settles, even against a zero transfer', async () => {
    const h = build({
      req: requestRow({ payableAmount: '0.000000' }),
      verification: { ...defaultWorld().verification, amountUsdtMinor: '0' },
    })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_ONCHAIN_AMOUNT_MISMATCH',
      HttpStatus.BAD_REQUEST,
    )
  })

  it('an un-representable payable (7 decimals) never settles', async () => {
    const h = build({ req: requestRow({ payableAmount: '740.0700001' }) })
    await expectApiError(
      h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR),
      'FINANCE_ONCHAIN_AMOUNT_MISMATCH',
      HttpStatus.BAD_REQUEST,
    )
  })

  it('happy path: exact amount settles; sender is lowercased and stamped on BOTH the payout request and the PAYOUT row; result is the re-read payout', async () => {
    const h = build()
    const out = await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)

    expect(out).toEqual({ id: REQUEST_ID, marker: 'found' })
    expect(h.one('update payout_requests').set!['txFromAddress']).toBe(SENDER_LOWER)
    expect(h.find('update transactions')[1]!.set!['txFromAddress']).toBe(SENDER_LOWER)
    expect(h.find('update transactions')[1]!.set!['fundingSource']).toBe('COMPANY_ACCOUNT')
    const audit = h.one('insert transaction_audit_log').values!
    expect((audit['metadata'] as Row)['txFromAddress']).toBe(SENDER_LOWER)
  })

  it('a malformed sender is stored as null (audit only, never a gate)', async () => {
    const h = build({ verification: { ...defaultWorld().verification, fromAddress: '0xnope' } })
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)
    expect(h.one('update payout_requests').set!['txFromAddress']).toBeNull()
  })

  it('payPayoutRequest does NOT enable the in-transaction reuse guard (it ran its own pre-check)', async () => {
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)
    expect(h.labels().filter((l) => l === 'query payoutRequests')).toEqual([])
  })

  it('payPayoutRequest writes no audit note on the PAYOUT row and none in the audit metadata', async () => {
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)
    expect(h.find('update transactions')[1]!.set).not.toHaveProperty('notes')
    expect(h.one('insert transaction_audit_log').values!['metadata']).not.toHaveProperty('note')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manualConfirmPayout
// ═══════════════════════════════════════════════════════════════════════════

describe('manualConfirmPayout — gates', () => {
  it.each([SENIOR, DROP, JUNIOR, HR])(
    '$role is refused with 403 before ANY db access',
    async (u) => {
      const h = build()
      await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', u)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(h.events).toEqual([])
    },
  )

  it.each([ADMIN, ACCOUNTANT])('$role may confirm', async (u) => {
    const h = build()
    await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', u)).resolves.toEqual({
      id: REQUEST_ID,
      marker: 'found',
    })
  })

  it('unknown request → 404', async () => {
    const h = build({ req: undefined })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN),
      'FINANCE_PAYOUT_REQUEST_NOT_FOUND',
      HttpStatus.NOT_FOUND,
    )
    expect(h.labels()).toEqual(['base query payoutRequests'])
  })

  it('no ownership check: an admin can confirm a payout that belongs to any senior', async () => {
    const h = build({ req: requestRow({ seniorId: OTHER_SENIOR.id }) })
    await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)).resolves.toBeDefined()
  })

  it.each(['PAID', 'REJECTED'])(
    'status %s → 400 ALREADY_PAID (idempotency): no transaction, no second cascade',
    async (status) => {
      const h = build({ req: requestRow({ status }) })
      await expectApiError(
        h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN),
        'FINANCE_PAYOUT_REQUEST_ALREADY_PAID',
        HttpStatus.BAD_REQUEST,
      )
      expect(h.labels()).toEqual(['base query payoutRequests'])
      expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
    },
  )
})

describe('manualConfirmPayout — hash handling and funding marker', () => {
  it('a supplied-but-unparseable hash → 400 TX_HASH_INVALID, nothing written', async () => {
    const h = build()
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: '0xshort' }),
      'FINANCE_TX_HASH_INVALID',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).toEqual(['base query payoutRequests'])
  })

  it.each([undefined, null, '', '   '])(
    'no usable hash (%j) → synthesized 0xMANUAL marker (0xMANUAL + 52 hex), registry untouched',
    async (raw) => {
      const h = build()
      await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: raw })
      expect(h.one('update payout_requests').set!['txHash']).toMatch(/^0xMANUAL[0-9a-f]{52}$/)
      expect(h.labels()).not.toContain('insert consumed_tx_hashes')
      expect(h.labels()).not.toContain('base query consumedTxHashes')
      // synthetic marker: the pre-transaction reuse scan is not run either
      expect(h.labels().filter((l) => l === 'base query payoutRequests')).toHaveLength(1)
    },
  )

  it('an explorer link is reduced to the lowercase hash before anything is compared or stored', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, {
      txHash: HASH_LINK_MIXED_CASE,
    })
    expect(h.one('update payout_requests').set!['txHash']).toBe(HASH)
    expect(h.one('insert consumed_tx_hashes').values!['txHash']).toBe(HASH)
    expect(h.find('base query payoutRequests')[1]!.where!.params).toEqual([HASH, 'PAID'])
  })

  it.each([
    ['COMPANY_ACCOUNT', 'COMPANY_ACCOUNT'],
    ['ADMIN_USDT', null],
    ['CASH', null],
  ] as const)('method %s → PAYOUT row fundingSource %j', async (method, expected) => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, method, ADMIN)
    expect(h.find('update transactions')[1]!.set!['fundingSource']).toBe(expected)
    expect(
      (h.one('insert transaction_audit_log').values!['metadata'] as Row)['fundingSource'],
    ).toBe(expected)
  })

  it('manual settlements never record an on-chain sender (txFromAddress null on both rows)', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })
    expect(h.one('update payout_requests').set!['txFromAddress']).toBeNull()
    expect(h.find('update transactions')[1]!.set!['txFromAddress']).toBeNull()
  })

  it('manual confirm never calls Etherscan or reads the company wallet', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })
    expect(h.verifyDeposit).not.toHaveBeenCalled()
    expect(h.labels()).not.toContain('base query companyAccount')
  })
})

describe('manualConfirmPayout — txHash-reuse guards (two layers)', () => {
  it('COMPANY_ACCOUNT + real hash: Layer 1 pre-transaction scan (hash AND PAID) → 400 USED_FOR_OTHER_PAYOUT, no transaction', async () => {
    const h = build({ reusedPaid: { id: 'other-req' } })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH }),
      'FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT',
      HttpStatus.BAD_REQUEST,
    )
    const scan = h.find('base query payoutRequests')[1]!.where!
    expect(scan.sql).toBe('("payout_requests"."tx_hash" = $1 and "payout_requests"."status" = $2)')
    expect(scan.params).toEqual([HASH, 'PAID'])
    expect(h.labels()).not.toContain('tx-begin')
  })

  it.each(['ADMIN_USDT', 'CASH'] as const)(
    '%s + real hash: the PAID-payout scan is NOT run (money does not credit the company) — only the registry fast-fail is',
    async (method) => {
      const h = build({ reusedPaid: { id: 'other-req' } })
      await h.svc.manualConfirmPayout(REQUEST_ID, method, ADMIN, { txHash: HASH })
      expect(h.labels().filter((l) => l === 'base query payoutRequests')).toHaveLength(1)
      expect(h.labels()).toContain('base query consumedTxHashes')
      expect(h.labels()).toContain('tx-commit')
    },
  )

  it.each(['COMPANY_ACCOUNT', 'ADMIN_USDT', 'CASH'] as const)(
    '%s + real hash already consumed anywhere → 400 ALREADY_CONSUMED (registry fast-fail applies to EVERY method)',
    async (method) => {
      const h = build({ consumed: { purpose: 'COMPANY_DEPOSIT', referenceId: 'dep-1' } })
      await expectApiError(
        h.svc.manualConfirmPayout(REQUEST_ID, method, ADMIN, { txHash: HASH }),
        'FINANCE_TX_HASH_ALREADY_CONSUMED',
        HttpStatus.BAD_REQUEST,
      )
      expect(h.labels()).not.toContain('tx-begin')
    },
  )

  it('Layer 2: COMPANY_ACCOUNT + real hash re-checks INSIDE the transaction, excluding this request, and rolls back', async () => {
    // Pre-scan sees nothing (stale); the in-tx scan finds the competing PAID payout.
    const h = build()
    let calls = 0
    const original = h.world
    Object.defineProperty(original, 'reusedPaid', {
      get: () => (++calls >= 2 ? { id: 'winner-req' } : undefined),
    })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH }),
      'FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT',
      HttpStatus.BAD_REQUEST,
    )
    const inTx = h.one('query payoutRequests').where!
    expect(inTx.sql).toBe(
      '("payout_requests"."tx_hash" = $1 and "payout_requests"."status" = $2 and "payout_requests"."id" <> $3)',
    )
    expect(inTx.params).toEqual([HASH, 'PAID', REQUEST_ID])
    expect(h.labels()).toContain('tx-rollback')
    expect(h.labels()).not.toContain('insert consumed_tx_hashes')
    expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
  })

  it.each(['ADMIN_USDT', 'CASH'] as const)(
    'Layer 2 is off for %s (no in-transaction payout scan)',
    async (method) => {
      const h = build()
      await h.svc.manualConfirmPayout(REQUEST_ID, method, ADMIN, { txHash: HASH })
      expect(h.find('query payoutRequests')).toHaveLength(0)
    },
  )

  it('Layer 2 is off for COMPANY_ACCOUNT with a synthetic marker', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(h.find('query payoutRequests')).toHaveLength(0)
  })
})

describe('manualConfirmPayout — audit note', () => {
  it('format: "Manual payout confirmation by <actor> at <ISO now> (method=<m>)" — written to the PAYOUT row and the audit metadata', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'ADMIN_USDT', ACCOUNTANT)
    const note = `Manual payout confirmation by acc-1 at ${NOW.toISOString()} (method=ADMIN_USDT)`
    expect(h.find('update transactions')[1]!.set!['notes']).toBe(note)
    expect((h.one('insert transaction_audit_log').values!['metadata'] as Row)['note']).toBe(note)
  })

  it('a free-text note is appended after an em dash', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { note: 'paid in office' })
    expect(h.find('update transactions')[1]!.set!['notes']).toBe(
      `Manual payout confirmation by admin-1 at ${NOW.toISOString()} (method=CASH) — paid in office`,
    )
  })

  it.each([undefined, null, ''])('an empty note (%j) adds no suffix', async (note) => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { note })
    expect(h.find('update transactions')[1]!.set!['notes']).toBe(
      `Manual payout confirmation by admin-1 at ${NOW.toISOString()} (method=CASH)`,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// applyPayoutPaidCascade (via the two entry points)
// ═══════════════════════════════════════════════════════════════════════════

describe('applyPayoutPaidCascade — write ORDER (the serialization contract)', () => {
  it('senior-project settlement: claim FIRST, ledger rows only after it, invoice + re-read strictly AFTER commit', async () => {
    const h = build({
      incomes: [
        {
          id: 'inc-1',
          projectId: 'proj-1',
          type: 'SENIOR_INCOME',
          dropSharePercent: null,
          dropSharePercentSource: null,
        },
      ],
      projectsById: {
        'proj-1': { id: 'proj-1', dropId: null, seniorId: 'senior-1', companyName: 'Acme' },
      },
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })

    expect(h.labels()).toEqual([
      'base query payoutRequests', // entry-point load
      'base query payoutRequests', // layer-1 reuse scan
      'base query consumedTxHashes', // registry fast-fail
      'tx-begin',
      'update payout_requests', // atomic PENDING→PAID claim (serialization point)
      // SR-809-M-3: no `txDate` was sent, so the PAYOUT source row is NOT read.
      // That lookup only ever supplied the date floor, and reading it anyway is
      // what made a request with no PAYOUT row unpayable.
      'query payoutRequests', // layer-2 reuse guard, after the claim
      'insert consumed_tx_hashes', // cross-path hash claim
      'select consumed_tx_hashes', // release-history probe
      'update transactions', // bulk PAID flip of linked rows
      'select transactions', // linked incomes
      'update transactions', // PAYOUT row PAID + fundingSource
      'insert transaction_audit_log', // PAYOUT_SETTLED
      'query projects', // primary project
      'tx-commit',
      `invoice PAYOUT ${PAYOUT_ROW_ID}`,
      'findPayoutRequest',
    ])
  })

  it('drop-project settlement books both IOUs (transactions row THEN its pending_obligations row) after the audit row, inside the transaction', async () => {
    const h = build(dropWorld())
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)

    const tail = h.labels().slice(h.labels().indexOf('insert transaction_audit_log'))
    expect(tail).toEqual([
      'insert transaction_audit_log',
      'query projects',
      'query users', // drop
      'query users', // senior
      'base query teamMembers', // senior-share snapshot (committed data, base handle)
      'insert transactions', // SENIOR_PENDING_PAYOUT
      'insert pending_obligations',
      'insert transactions', // DROP_PENDING_PAYOUT
      'insert pending_obligations',
      'tx-commit',
      `invoice PAYOUT ${PAYOUT_ROW_ID}`,
      'findPayoutRequest',
    ])
  })

  it('the payout_requests claim is the FIRST write and no transactions-table write precedes it', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)
    const inTx = h.labels().slice(h.labels().indexOf('tx-begin') + 1)
    expect(inTx[0]).toBe('update payout_requests')
    expect(inTx.slice(1)).toContain('update transactions')
  })
})

describe('applyPayoutPaidCascade — the atomic PENDING→PAID claim', () => {
  it('writes txHash / sender / PAID / fresh updatedAt, guarded by id AND status=PENDING', async () => {
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)
    const claim = h.one('update payout_requests')
    expect(claim.set).toEqual({
      txHash: HASH,
      txFromAddress: SENDER_LOWER,
      status: 'PAID',
      updatedAt: NOW,
    })
    expect(claim.where!.sql).toBe(
      '("payout_requests"."id" = $1 and "payout_requests"."status" = $2)',
    )
    expect(claim.where!.params).toEqual([REQUEST_ID, 'PENDING'])
  })

  it('claim lost (0 rows) → 400 ALREADY_PAID, whole transaction rolled back, NOTHING else written, no invoice, no re-read', async () => {
    const h = build({ claimRows: [] })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH }),
      'FINANCE_PAYOUT_REQUEST_ALREADY_PAID',
      HttpStatus.BAD_REQUEST,
    )
    const inTx = h.labels().slice(h.labels().indexOf('tx-begin'))
    expect(inTx).toEqual(['tx-begin', 'update payout_requests', 'tx-rollback'])
    expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
    expect(h.findPayoutRequest).not.toHaveBeenCalled()
  })

  // SR-809-M-3 = CR-809-L-3. This lookup exists ONLY to supply the lower bound
  // for an explicitly chosen payment date, but #809 ran it unconditionally and
  // threw when it found nothing. That made every payout request without a PAYOUT
  // row (legacy data, a half-failed create) permanently unpayable — including
  // through `manualConfirmPayout`, which IS the ADMIN/ACCOUNTANT recovery path.
  it('no PAYOUT row and no txDate → the confirmation still proceeds, and the lower-bound lookup is not issued at all', async () => {
    const h = build({ payoutSource: [] })
    await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)).resolves.toBeDefined()
    expect(h.labels()).toContain('tx-commit')
    // `select transactions` is not a unique label — the linked-income read uses
    // it too. With no date supplied exactly ONE such read happens (the incomes);
    // the PAYOUT date-floor lookup is the one that must be absent.
    expect(h.labels().filter((l) => l === 'select transactions')).toHaveLength(1)
    const onlyRead = h.find('select transactions')[0]!.where!
    expect(onlyRead.params).toEqual([REQUEST_ID, 'SENIOR_INCOME', 'DROP_INCOME'])
  })

  it('no PAYOUT row but a txDate was sent → 400 PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST and rollback (the claim is undone)', async () => {
    const h = build({ payoutSource: [] })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-10' }),
      'FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels().slice(h.labels().indexOf('tx-begin'))).toEqual([
      'tx-begin',
      'update payout_requests',
      'select transactions',
      'tx-rollback',
    ])
    const sel = h.one('select transactions').where!
    expect(sel.params).toEqual([REQUEST_ID, 'PAYOUT'])
  })

  // SR-809-M-3, second half: a soft-deleted PAYOUT row used to satisfy the
  // lookup and then supply the lower-bound date, so a deleted row silently
  // governed what date a live payment could carry.
  it('the lower-bound lookup excludes soft-deleted PAYOUT rows', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-10' })
    const sel = h.find('select transactions')[0]!.where!
    expect(sel.sql).toBe(
      '("transactions"."payout_request_id" = $1 and "transactions"."type" = $2 and "transactions"."deleted_at" is null)',
    )
    expect(sel.params).toEqual([REQUEST_ID, 'PAYOUT'])
  })
})

// SR-809-L-3 — the pay-flow audit metadata recorded the NEW date but not the one
// it replaced, and the PAYOUT row's own date is overwritten at pay time. Without
// the previous value the override is not reconstructable from the audit trail.
describe('applyPayoutPaidCascade — date-override audit trail (SR-809-L-3)', () => {
  it('records both the replaced and the written business date when a date is supplied', async () => {
    const h = build({
      payoutSource: [
        {
          id: PAYOUT_ROW_ID,
          txDate: new Date('2026-06-01T00:00:00.000Z'),
          createdAt: new Date('2026-06-01T10:00:00.000Z'),
        },
      ],
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-10' })
    const metadata = h.one('insert transaction_audit_log').values!['metadata'] as Record<
      string,
      unknown
    >
    expect(metadata['txDateBefore']).toBe('2026-06-01')
    expect(metadata['txDateAfter']).toBe('2026-06-10')
  })

  it('records a null previous date when the PAYOUT row carried none', async () => {
    const h = build({
      payoutSource: [
        { id: PAYOUT_ROW_ID, txDate: null, createdAt: new Date('2026-06-01T10:00:00.000Z') },
      ],
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-10' })
    const metadata = h.one('insert transaction_audit_log').values!['metadata'] as Record<
      string,
      unknown
    >
    expect(metadata['txDateBefore']).toBeNull()
    expect(metadata['txDateAfter']).toBe('2026-06-10')
  })

  it('writes neither key when no date was supplied — there was no override to record', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)
    const metadata = h.one('insert transaction_audit_log').values!['metadata'] as Record<
      string,
      unknown
    >
    expect(metadata).not.toHaveProperty('txDateBefore')
    expect(metadata).not.toHaveProperty('txDateAfter')
  })
})

describe('applyPayoutPaidCascade — payment date', () => {
  it('no txDate: no floor check, and the PAYOUT row keeps its own date (no txDate key written)', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)
    expect(h.find('update transactions')[1]!.set).not.toHaveProperty('txDate')
    expect(h.one('insert transaction_audit_log').values!['metadata']).not.toHaveProperty('txDate')
  })

  it('txDate before the PAYOUT business date → 400 DATE_BEFORE_OBLIGATION, rolled back', async () => {
    const h = build({
      payoutSource: [
        {
          id: PAYOUT_ROW_ID,
          txDate: new Date('2026-06-10T00:00:00.000Z'),
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-09' }),
      'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).toContain('tx-rollback')
    expect(h.labels()).not.toContain('update transactions')
  })

  it('txDate equal to the PAYOUT business date is accepted (floor is inclusive); the time of day is ignored', async () => {
    const h = build({
      payoutSource: [
        {
          id: PAYOUT_ROW_ID,
          txDate: new Date('2026-06-10T23:59:59.000Z'),
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-10' })
    const set = h.find('update transactions')[1]!.set!
    expect((set['txDate'] as Date).toISOString().slice(0, 10)).toBe('2026-06-10')
  })

  it('the floor is the PAYOUT txDate when set, NOT its createdAt', async () => {
    const h = build({
      payoutSource: [
        {
          id: PAYOUT_ROW_ID,
          txDate: new Date('2026-06-10T00:00:00.000Z'),
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    })
    // 06-05 is after createdAt (06-01) but before txDate (06-10) → refused
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-05' }),
      'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION',
      HttpStatus.BAD_REQUEST,
    )
  })

  it('with no PAYOUT txDate the floor falls back to createdAt', async () => {
    const h = build({
      payoutSource: [
        { id: PAYOUT_ROW_ID, txDate: null, createdAt: new Date('2026-06-05T08:00:00.000Z') },
      ],
    })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-04' }),
      'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION',
      HttpStatus.BAD_REQUEST,
    )
    const ok = build({
      payoutSource: [
        { id: PAYOUT_ROW_ID, txDate: null, createdAt: new Date('2026-06-05T08:00:00.000Z') },
      ],
    })
    await expect(
      ok.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-05' }),
    ).resolves.toBeDefined()
  })

  it('a backdated txDate is stored as UTC midnight of that day; today keeps the real instant', async () => {
    const past = build()
    await past.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-10' })
    expect((past.find('update transactions')[1]!.set!['txDate'] as Date).toISOString()).toBe(
      '2026-06-10T00:00:00.000Z',
    )

    const today = build()
    await today.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN, { txDate: '2026-06-15' })
    expect(today.find('update transactions')[1]!.set!['txDate']).toEqual(NOW)
  })

  it('txDate is recorded in the audit metadata and flows through payPayoutRequest too', async () => {
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR, undefined, '2026-06-12')
    expect((h.one('insert transaction_audit_log').values!['metadata'] as Row)['txDate']).toBe(
      '2026-06-12',
    )
    expect((h.find('update transactions')[1]!.set!['txDate'] as Date).toISOString()).toBe(
      '2026-06-12T00:00:00.000Z',
    )
  })
})

describe('applyPayoutPaidCascade — consumed-hash registry claim', () => {
  it('a REAL hash is claimed: purpose PAYOUT, referenceId = request, consumer = the actor', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })
    expect(h.one('insert consumed_tx_hashes').values).toEqual({
      txHash: HASH,
      purpose: 'PAYOUT',
      referenceId: REQUEST_ID,
      consumedByUserId: ADMIN.id,
    })
  })

  it.each(['ADMIN_USDT', 'CASH'] as const)(
    'a non-crediting %s confirmation with a real hash STILL claims it (the transfer was spent)',
    async (method) => {
      const h = build()
      await h.svc.manualConfirmPayout(REQUEST_ID, method, ADMIN, { txHash: HASH })
      expect(h.find('insert consumed_tx_hashes')).toHaveLength(1)
    },
  )

  it('the consumer is the real actor even when impersonating', async () => {
    const h = build()
    const impersonated = user('ADMIN', 'admin-1', { impersonatorId: 'owner-9' })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', impersonated, { txHash: HASH })
    expect(h.one('insert consumed_tx_hashes').values!['consumedByUserId']).toBe('admin-1')
  })

  it('first-time claim writes no reclaim audit and no warning', async () => {
    const h = build({ previousClaim: [] })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })
    expect(h.find('insert transaction_audit_log')).toHaveLength(1)
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('previous claim that was NOT released → no reclaim audit', async () => {
    const h = build({ previousClaim: [{ releasedAt: null }] })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })
    expect(h.find('insert transaction_audit_log')).toHaveLength(1)
  })

  it('re-spending a RELEASED hash records ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE (before the bulk flip) attributed to the impersonator, and warns', async () => {
    const h = build({ previousClaim: [{ releasedAt: new Date('2026-06-02T00:00:00.000Z') }] })
    const impersonated = user('ADMIN', 'admin-1', { impersonatorId: 'owner-9' })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', impersonated, { txHash: HASH })

    const audits = h.find('insert transaction_audit_log')
    expect(audits).toHaveLength(2)
    expect(audits[0]!.values).toEqual({
      actorId: 'owner-9',
      targetId: REQUEST_ID,
      action: 'ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE',
      metadata: { path: 'applyPayoutPaidCascade', txHash: HASH, referenceId: REQUEST_ID },
    })
    const labels = h.labels()
    expect(labels.indexOf('insert transaction_audit_log')).toBeLessThan(
      labels.indexOf('update transactions'),
    )
    expect(h.warn).toHaveBeenCalledTimes(1)
  })
})

describe('applyPayoutPaidCascade — ledger rows', () => {
  it('bulk flip: every row linked to the request becomes PAID (predicate is the request link ONLY)', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)
    const bulk = h.find('update transactions')[0]!
    expect(bulk.set).toEqual({ status: 'PAID', updatedAt: NOW })
    expect(bulk.where!.sql).toBe('"transactions"."payout_request_id" = $1')
    expect(bulk.where!.params).toEqual([REQUEST_ID])
  })

  it('linked-income read selects SENIOR_INCOME or DROP_INCOME of this request', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)
    // SR-809-M-3: with no `txDate` the PAYOUT date-floor lookup no longer runs,
    // so the linked-income read is the FIRST `select transactions`, not the second.
    const read = h.find('select transactions')[0]!.where!
    expect(read.sql).toBe(
      '("transactions"."payout_request_id" = $1 and ("transactions"."type" = $2 or "transactions"."type" = $3))',
    )
    expect(read.params).toEqual([REQUEST_ID, 'SENIOR_INCOME', 'DROP_INCOME'])
  })

  it('PAYOUT row: PAID + hash + sender + funding marker + fresh updatedAt, ONLY the still-PENDING_PAYMENT PAYOUT of this request', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })
    const payout = h.find('update transactions')[1]!
    expect(payout.set).toEqual({
      status: 'PAID',
      txHash: HASH,
      txFromAddress: null,
      fundingSource: 'COMPANY_ACCOUNT',
      updatedAt: NOW,
      notes: expect.stringContaining('Manual payout confirmation by admin-1'),
    })
    expect(payout.where!.sql).toBe(
      '("transactions"."payout_request_id" = $1 and "transactions"."type" = $2 and "transactions"."status" = $3)',
    )
    expect(payout.where!.params).toEqual([REQUEST_ID, 'PAYOUT', 'PENDING_PAYMENT'])
  })

  it('PAYOUT row already PAID by the bulk flip (0 rows) → patch it (hash / funding marker / notes, no status) and recover its id for audit + invoice', async () => {
    const h = build({ payoutUpdateRows: [], existingPayout: [{ id: 'recovered-tx' }] })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH })

    const updates = h.find('update transactions')
    expect(updates).toHaveLength(3)
    const patch = updates[2]!
    expect(patch.set).toEqual({
      txHash: HASH,
      txFromAddress: null,
      fundingSource: 'COMPANY_ACCOUNT',
      updatedAt: NOW,
      notes: expect.stringContaining('Manual payout confirmation'),
    })
    expect(patch.where!.sql).toBe(
      '("transactions"."payout_request_id" = $1 and "transactions"."type" = $2)',
    )
    expect(patch.where!.params).toEqual([REQUEST_ID, 'PAYOUT'])

    expect(h.one('insert transaction_audit_log').values!['targetId']).toBe('recovered-tx')
    expect(h.labels()).toContain('invoice PAYOUT recovered-tx')
  })

  it('fallback also carries a backdated txDate and omits notes when there is no audit note', async () => {
    const h = build({ payoutUpdateRows: [], existingPayout: [{ id: 'recovered-tx' }] })
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR, undefined, '2026-06-10')
    const patch = h.find('update transactions')[2]!
    expect((patch.set!['txDate'] as Date).toISOString()).toBe('2026-06-10T00:00:00.000Z')
    expect(patch.set).not.toHaveProperty('notes')
  })

  it('fallback with no PAYOUT row at all → 400 PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST and rollback', async () => {
    const h = build({ payoutUpdateRows: [], existingPayout: [] })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN),
      'FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).toContain('tx-rollback')
    expect(h.labels()).not.toContain('insert transaction_audit_log')
    expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
  })

  it('PAYOUT_SETTLED audit row: exact shape, actor is the impersonator when present', async () => {
    const h = build()
    const impersonated = user('ACCOUNTANT', 'acc-1', { impersonatorId: 'owner-9' })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'ADMIN_USDT', impersonated, {
      txHash: HASH,
      note: 'wired',
      txDate: '2026-06-12',
    })
    const note = `Manual payout confirmation by acc-1 at ${NOW.toISOString()} (method=ADMIN_USDT) — wired`
    expect(h.one('insert transaction_audit_log').values).toEqual({
      actorId: 'owner-9',
      targetId: PAYOUT_ROW_ID,
      action: 'PAYOUT_SETTLED',
      metadata: {
        payoutRequestId: REQUEST_ID,
        txHash: HASH,
        txFromAddress: null,
        fundingSource: null,
        payableAmount: '740.070000',
        note,
        txDate: '2026-06-12',
        // SR-809-L-3: both ends of the date override. `null` = the PAYOUT row
        // carried no business date before this settlement overwrote it.
        txDateBefore: null,
        txDateAfter: '2026-06-12',
      },
    })
  })

  it('PAYOUT_SETTLED audit row for a plain on-chain settlement has no note / txDate keys and attributes the actor', async () => {
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)
    expect(h.one('insert transaction_audit_log').values).toEqual({
      actorId: SENIOR.id,
      targetId: PAYOUT_ROW_ID,
      action: 'PAYOUT_SETTLED',
      metadata: {
        payoutRequestId: REQUEST_ID,
        txHash: HASH,
        txFromAddress: SENDER_LOWER,
        fundingSource: 'COMPANY_ACCOUNT',
        payableAmount: '740.070000',
      },
    })
  })
})

describe('applyPayoutPaidCascade — senior vs drop routing', () => {
  it('no linked incomes → no project lookup, nothing booked', async () => {
    const h = build({ incomes: [] })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)
    expect(h.labels()).not.toContain('query projects')
    expect(h.labels()).not.toContain('insert transactions')
  })

  it('senior-project (dropId null): project is looked up by the FIRST income’s project, no partner rows are written', async () => {
    const h = build({
      incomes: [
        {
          id: 'inc-1',
          projectId: 'proj-A',
          type: 'SENIOR_INCOME',
          dropSharePercent: null,
          dropSharePercentSource: null,
        },
        {
          id: 'inc-2',
          projectId: 'proj-B',
          type: 'SENIOR_INCOME',
          dropSharePercent: null,
          dropSharePercentSource: null,
        },
      ],
      projectsById: { 'proj-A': { id: 'proj-A', dropId: null, seniorId: 'senior-1' } },
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(h.one('query projects').where!.params).toEqual(['proj-A'])
    expect(h.labels()).not.toContain('query users')
    expect(h.labels()).not.toContain('insert transactions')
    expect(h.labels()).not.toContain('insert pending_obligations')
  })

  it('project with a drop id but no resolvable drop user → falls back to the senior-project path (nothing booked)', async () => {
    const h = build(dropWorld({ usersById: {} }))
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(h.labels()).not.toContain('insert transactions')
    expect(h.labels()).toContain('tx-commit')
  })

  it('income whose project cannot be found → treated as senior-project (nothing booked)', async () => {
    const h = build(dropWorld({ projectsById: {} }))
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(h.labels()).not.toContain('query users')
    expect(h.labels()).not.toContain('insert transactions')
  })

  it('drop project whose project row has no senior → 404 SENIOR_NOT_FOUND_ON_DROP_PROJECT, whole cascade rolled back', async () => {
    const base = dropWorld()
    const h = build({
      ...base,
      projectsById: { 'proj-1': { ...(base.projectsById!['proj-1'] as Row), seniorId: null } },
    })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN),
      'FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT',
      HttpStatus.NOT_FOUND,
    )
    expect(h.labels()).toContain('tx-rollback')
    expect(h.labels()).not.toContain('insert transactions')
    expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
  })

  it('drop project whose senior user row is missing → the same 404', async () => {
    const base = dropWorld()
    const h = build({ ...base, usersById: { 'drop-1': base.usersById!['drop-1']! } })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN),
      'FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT',
      HttpStatus.NOT_FOUND,
    )
    expect(h.labels()).toContain('tx-rollback')
  })

  it('looks up the drop and the senior by the project’s dropId / seniorId (NOT by the payout owner)', async () => {
    const h = build({ ...dropWorld(), req: requestRow({ seniorId: 'drop-1' }) })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    const lookups = h.find('query users').map((e) => e.where!.params)
    expect(lookups).toEqual([['drop-1'], ['senior-1']])
  })
})

describe('applyPayoutPaidCascade — drop-project IOU booking (amounts)', () => {
  const ioWorld = () => dropWorld()

  const iouRows = (h: H) => h.find('insert transactions').map((e) => e.values!)
  const obligations = (h: H) => h.find('insert pending_obligations').map((e) => e.values!)

  it('books a senior IOU and a drop IOU on the GROSS income, with exact amounts / percents / sources / links', async () => {
    const h = build(ioWorld())
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)

    const [seniorIou, dropIou] = iouRows(h)
    expect(seniorIou).toMatchObject({
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: '320.9856', // 1234.56 × 26 %
      currency: 'USDT',
      receiverId: 'senior-1',
      recipientId: 'senior-1',
      projectId: 'proj-1',
      payoutRequestId: REQUEST_ID,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      notes: 'Drop payout — senior IOU (debtor=COMPANY)',
      createdBy: ADMIN.id,
      sourceIncomeTransactionId: null,
      companyNameSnapshot: 'Acme',
    })
    expect(dropIou).toMatchObject({
      type: 'DROP_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: '123.456', // 1234.56 × 10 % (the per-income snapshot, not the drop's 7 % default)
      currency: 'USDT',
      receiverId: 'drop-1',
      recipientId: 'drop-1',
      projectId: 'proj-1',
      payoutRequestId: REQUEST_ID,
      dropCascadeOrigin: true,
      dropSharePercent: 10,
      dropSharePercentSource: 'PROJECT',
      notes: 'Drop payout — drop IOU (debtor=COMPANY)',
      createdBy: ADMIN.id,
      companyNameSnapshot: 'Acme',
    })

    expect(obligations(h)).toEqual([
      {
        creditorUserId: 'senior-1',
        debtorType: 'COMPANY',
        debtorUserId: null,
        sourceTransactionId: 'iou-1',
        amount: '320.9856',
        currency: 'USDT',
        status: 'PENDING',
        payoutRequestId: REQUEST_ID,
      },
      {
        creditorUserId: 'drop-1',
        debtorType: 'COMPANY',
        debtorUserId: null,
        sourceTransactionId: 'iou-2',
        amount: '123.456',
        currency: 'USDT',
        status: 'PENDING',
        payoutRequestId: REQUEST_ID,
      },
    ])
  })

  it('IOUs are attributed to the acting user id (not the impersonator) and carry the payment date when one was chosen', async () => {
    const h = build(ioWorld())
    const impersonated = user('ADMIN', 'admin-1', { impersonatorId: 'owner-9' })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', impersonated, {
      txDate: '2026-06-10',
    })
    for (const row of iouRows(h)) {
      expect(row['createdBy']).toBe('admin-1')
      expect((row['txDate'] as Date).toISOString()).toBe('2026-06-10T00:00:00.000Z')
    }
  })

  it('without a chosen date the IOU rows carry no txDate key', async () => {
    const h = build(ioWorld())
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    for (const row of iouRows(h)) expect(row).not.toHaveProperty('txDate')
  })

  it('the income is req.incomeAmount parsed as a float (not payableAmount)', async () => {
    const h = build({
      ...ioWorld(),
      req: requestRow({ incomeAmount: '2000.000000', payableAmount: '1.000000' }),
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h).map((r) => r['amount'])).toEqual(['520', '200'])
  })

  it('a non-PROJECT drop-share source on the income snapshot is reported as USER_DEFAULT', async () => {
    for (const source of ['USER_DEFAULT', null, 'whatever']) {
      const h = build(dropWorld({}, { dropSharePercentSource: source }))
      await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
      expect(iouRows(h)[1]).toMatchObject({
        dropSharePercent: 10,
        dropSharePercentSource: 'USER_DEFAULT',
      })
    }
  })

  it('a zero-percent income snapshot is honoured (0 is a value, not "missing")', async () => {
    const h = build(dropWorld({}, { dropSharePercent: 0 }))
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h)[1]).toMatchObject({ amount: '0', dropSharePercent: 0 })
  })

  it('the FIRST income’s drop snapshot wins over later incomes', async () => {
    const base = dropWorld()
    const h = build({
      ...base,
      incomes: [
        ...(base.incomes as Row[]),
        {
          id: 'inc-2',
          projectId: 'proj-1',
          type: 'DROP_INCOME',
          dropSharePercent: 30,
          dropSharePercentSource: 'PROJECT',
        },
      ],
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h)[1]).toMatchObject({ dropSharePercent: 10 })
  })

  it('legacy income with no snapshot: project override wins and is tagged PROJECT', async () => {
    const base = dropWorld({}, { dropSharePercent: null, dropSharePercentSource: null })
    const proj = base.projectsById!['proj-1'] as Row
    const h = build({
      ...base,
      projectsById: { 'proj-1': { ...proj, dropSharePercentOverride: 12 } },
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h)[1]).toMatchObject({
      amount: '148.1472',
      dropSharePercent: 12,
      dropSharePercentSource: 'PROJECT',
    })
  })

  it('legacy income with no snapshot and no override: the drop user’s own default applies (USER_DEFAULT)', async () => {
    const h = build(dropWorld({}, { dropSharePercent: null, dropSharePercentSource: null }))
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h)[1]).toMatchObject({
      amount: '86.4192',
      dropSharePercent: 7,
      dropSharePercentSource: 'USER_DEFAULT',
    })
  })

  it('legacy income, no override, drop user with no default → the system default 5 %', async () => {
    const base = dropWorld({}, { dropSharePercent: null, dropSharePercentSource: null })
    const h = build({
      ...base,
      usersById: { ...base.usersById, 'drop-1': { id: 'drop-1', dropSharePercent: null } },
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h)[1]).toMatchObject({
      amount: '61.728',
      dropSharePercent: 5,
      dropSharePercentSource: 'USER_DEFAULT',
    })
  })

  it('senior share: the project override wins and is tagged PROJECT', async () => {
    const base = dropWorld()
    const proj = base.projectsById!['proj-1'] as Row
    const h = build({
      ...base,
      projectsById: { 'proj-1': { ...proj, seniorSharePercentOverride: 30 } },
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h)[0]).toMatchObject({
      amount: '370.368',
      seniorSharePercent: 30,
      seniorSharePercentSource: 'PROJECT',
    })
  })

  it('senior share: an active team override applies and is tagged TEAM (memberships are read for the project’s senior)', async () => {
    const h = build({
      ...dropWorld(),
      teamMembers: [{ team: { id: 'team-1', seniorSharePercentOverride: 12, archivedAt: null } }],
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h)[0]).toMatchObject({
      amount: '148.1472',
      seniorSharePercent: 12,
      seniorSharePercentSource: 'TEAM',
    })
  })

  it('an ADMIN senior is never owed via a company IOU: only the drop IOU is booked', async () => {
    const base = dropWorld()
    const h = build({
      ...base,
      usersById: {
        ...base.usersById,
        'senior-1': { id: 'senior-1', role: 'ADMIN', seniorSharePercent: 26 },
      },
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(iouRows(h).map((r) => r['type'])).toEqual(['DROP_PENDING_PAYOUT'])
    expect(obligations(h)).toHaveLength(1)
  })

  it('senior% + drop% > 100 → 400 SHARES_SUM_EXCEEDS_100 and nothing is booked (rolled back)', async () => {
    const base = dropWorld({}, { dropSharePercent: 80 })
    const h = build({
      ...base,
      usersById: {
        ...base.usersById,
        'senior-1': { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 30 },
      },
    })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN),
      'FINANCE_SHARES_SUM_EXCEEDS_100',
      HttpStatus.BAD_REQUEST,
    )
    expect(h.labels()).toContain('tx-rollback')
    expect(h.labels()).not.toContain('insert transactions')
  })

  it('senior% + drop% == 100 is allowed (the guard is strict >)', async () => {
    const base = dropWorld({}, { dropSharePercent: 70 })
    const h = build({
      ...base,
      usersById: {
        ...base.usersById,
        'senior-1': { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 30 },
      },
    })
    await expect(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN),
    ).resolves.toBeDefined()
    expect(iouRows(h)).toHaveLength(2)
  })

  it('drop-project settlement works the same through payPayoutRequest (DROP owner), crediting the company account', async () => {
    const h = build({ ...dropWorld(), req: requestRow({ seniorId: DROP.id }) })
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, DROP)
    expect(iouRows(h).map((r) => r['type'])).toEqual([
      'SENIOR_PENDING_PAYOUT',
      'DROP_PENDING_PAYOUT',
    ])
    expect(h.find('update transactions')[1]!.set!['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(iouRows(h)[0]!['createdBy']).toBe(DROP.id)
  })
})

describe('applyPayoutPaidCascade — failure mapping (catch block)', () => {
  const pgError = (constraint: string | undefined, wrapped = true) => {
    const raw = Object.assign(new Error('duplicate key'), {
      code: '23505',
      ...(constraint === undefined ? {} : { constraint }),
    })
    return wrapped ? Object.assign(new Error('Failed query'), { cause: raw }) : raw
  }

  it.each([
    'uq_consumed_tx_hashes_active_tx_hash',
    'uq_consumed_tx_hashes_tx_hash',
    'uq_payout_requests_txhash_paid',
  ])(
    'unique violation on %s → 400 ALREADY_CONSUMED (read through the cause chain)',
    async (constraint) => {
      const h = build({
        failOn: { label: 'insert consumed_tx_hashes', error: pgError(constraint) },
      })
      await expectApiError(
        h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH }),
        'FINANCE_TX_HASH_ALREADY_CONSUMED',
        HttpStatus.BAD_REQUEST,
      )
      expect(h.labels()).toContain('tx-rollback')
      expect(h.error).not.toHaveBeenCalled()
      expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
      expect(h.findPayoutRequest).not.toHaveBeenCalled()
    },
  )

  it('the partial-unique backstop firing on the payout flip itself maps the same way', async () => {
    const h = build({
      failOn: {
        label: 'update payout_requests',
        error: pgError('uq_payout_requests_txhash_paid', false),
      },
    })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH }),
      'FINANCE_TX_HASH_ALREADY_CONSUMED',
      HttpStatus.BAD_REQUEST,
    )
  })

  it('a unique violation on ANY OTHER index is rethrown UNCHANGED (never mislabelled as a hash reuse) and logged with the constraint and request id', async () => {
    const err = pgError('uq_receipt_unique')
    const h = build({ failOn: { label: 'insert transaction_audit_log', error: err } })
    await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)).rejects.toBe(err)
    expect(h.error).toHaveBeenCalledTimes(1)
    const msg = String(h.error.mock.calls[0]![0])
    expect(msg).toContain('uq_receipt_unique')
    expect(msg).toContain(REQUEST_ID)
    expect(msg).toContain('rethrowing')
    expect(h.labels()).toContain('tx-rollback')
  })

  it('an unattributed unique violation (no constraint name) is rethrown and logged as <unattributed>', async () => {
    const err = pgError(undefined)
    const h = build({ failOn: { label: 'insert transaction_audit_log', error: err } })
    await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)).rejects.toBe(err)
    expect(String(h.error.mock.calls[0]![0])).toContain('<unattributed>')
  })

  it('a non-unique failure is rethrown untouched and NOT logged by the cascade', async () => {
    const err = new Error('connection reset')
    const h = build({ failOn: { label: 'update transactions', error: err } })
    await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)).rejects.toBe(err)
    expect(h.error).not.toHaveBeenCalled()
    expect(h.labels()).toContain('tx-rollback')
    expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
    expect(h.findPayoutRequest).not.toHaveBeenCalled()
  })
})

describe('applyPayoutPaidCascade — post-commit tail', () => {
  it('triggers ONE aggregated PAYOUT invoice for the PAYOUT row after commit, then returns the re-read payout for the request and actor', async () => {
    const h = build()
    const out = await h.svc.manualConfirmPayout(REQUEST_ID, 'CASH', ADMIN)
    expect(h.safeAutoCreateInvoice).toHaveBeenCalledTimes(1)
    expect(h.safeAutoCreateInvoice).toHaveBeenCalledWith('PAYOUT', PAYOUT_ROW_ID)
    expect(h.findPayoutRequest).toHaveBeenCalledWith(REQUEST_ID, ADMIN)
    expect(out).toEqual({ id: REQUEST_ID, marker: 'found' })
    const labels = h.labels()
    expect(labels.indexOf('tx-commit')).toBeLessThan(
      labels.indexOf(`invoice PAYOUT ${PAYOUT_ROW_ID}`),
    )
    expect(labels.indexOf(`invoice PAYOUT ${PAYOUT_ROW_ID}`)).toBeLessThan(
      labels.indexOf('findPayoutRequest'),
    )
  })

  it('a successful settlement opens exactly one transaction', async () => {
    const h = build()
    await h.svc.payPayoutRequest(REQUEST_ID, HASH, SENIOR)
    expect(h.find('tx-begin')).toHaveLength(1)
    expect(h.find('tx-commit')).toHaveLength(1)
    expect(h.find('tx-rollback')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Pins added when the cluster moved into PayoutSettlementService: each closes a
// mutant the original net let through (column selections, falsy-but-present
// inputs, per-senior share inputs).
// ═══════════════════════════════════════════════════════════════════════════

describe('PayoutSettlementService — remaining pins', () => {
  it('the atomic claim and the PAYOUT-row flip each select exactly the id column', async () => {
    const h = build()
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    expect(h.returned).toEqual([
      { table: 'payout_requests', keys: ['id'] },
      { table: 'transactions', keys: ['id'] },
    ])
  })

  it('a manual confirmation without a hash never queries the consumed-hash registry (a synthetic marker is unique by construction)', async () => {
    const h = build({ consumed: { id: 'claim-9' } })
    await expect(h.svc.manualConfirmPayout(REQUEST_ID, 'ADMIN_USDT', ADMIN)).resolves.toBeDefined()
    expect(h.labels()).not.toContain('base query consumedTxHashes')
  })

  it('an empty-string payment date means "no date chosen": no date check, no txDate stamped', async () => {
    const h = build()
    await expect(
      h.svc.manualConfirmPayout(REQUEST_ID, 'ADMIN_USDT', ADMIN, { txDate: '' }),
    ).resolves.toBeDefined()
    expect(h.find('update transactions')[1]!.set).not.toHaveProperty('txDate')
  })

  it('fallback re-read of an already-PAID PAYOUT row is scoped to this request and the PAYOUT type', async () => {
    const h = build({ payoutUpdateRows: [] })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'ADMIN_USDT', ADMIN)
    const lastSelect = h.find('select transactions').at(-1)!
    expect(lastSelect.where!.params).toEqual([REQUEST_ID, 'PAYOUT'])
  })

  it('a PAYOUT row without a usable id triggers no invoice', async () => {
    const h = build({ payoutUpdateRows: [{ id: '' }] })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'ADMIN_USDT', ADMIN)
    expect(h.safeAutoCreateInvoice).not.toHaveBeenCalled()
  })

  it('senior share: the senior’s own percent (not the system default) prices the senior IOU', async () => {
    const base = dropWorld()
    const h = build({
      ...base,
      usersById: {
        ...base.usersById,
        'senior-1': { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 40 },
      },
    })
    await h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN)
    const [seniorIou] = h.find('insert transactions').map((e) => e.values!)
    expect(seniorIou).toMatchObject({
      amount: '493.824', // 1234.56 × 40 %
      seniorSharePercent: 40,
      seniorSharePercentSource: 'USER_DEFAULT',
    })
  })

  it('the cascade defaults are inert: with only the four mandatory arguments there is no in-transaction reuse scan, no sender and no payment date', async () => {
    // Both public entry points always pass the optional arguments explicitly, so
    // only a direct call to the private cascade can observe its defaults
    // (`guardTxHashReuse = false`, `onChainFromAddress = null`, `txDate` unset).
    // A competing PAID payout holds the hash: were the guard on by default, this
    // settlement would be refused.
    const h = build({ reusedPaid: { id: 'winner-req' } })
    const cascade = (
      h.svc as unknown as {
        payoutSettle: {
          applyPayoutPaidCascade: (
            req: Row,
            hash: string,
            funding: string | null,
            note: string | null,
            actor: SessionUser,
          ) => Promise<unknown>
        }
      }
    ).payoutSettle.applyPayoutPaidCascade
    const settle = cascade.bind((h.svc as unknown as { payoutSettle: object }).payoutSettle)
    await expect(settle(requestRow(), HASH, null, null, ADMIN)).resolves.toBeDefined()
    expect(h.find('query payoutRequests')).toHaveLength(0)
    expect(h.one('update payout_requests').set!['txFromAddress']).toBeNull()
    expect(h.find('update transactions')[1]!.set).not.toHaveProperty('txDate')
  })

  it('the sum guard uses the resolved senior percent: 40 + 61 > 100 is refused', async () => {
    const base = dropWorld({}, { dropSharePercent: 61 })
    const h = build({
      ...base,
      usersById: {
        ...base.usersById,
        'senior-1': { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 40 },
      },
    })
    await expectApiError(
      h.svc.manualConfirmPayout(REQUEST_ID, 'COMPANY_ACCOUNT', ADMIN),
      'FINANCE_SHARES_SUM_EXCEEDS_100',
      HttpStatus.BAD_REQUEST,
    )
  })
})
