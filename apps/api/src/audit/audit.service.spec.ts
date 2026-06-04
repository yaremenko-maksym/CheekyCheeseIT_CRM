import { describe, expect, it, vi } from 'vitest'
import { AuditService } from './audit.service'
import type { DatabaseService } from '../database/database.service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-15T10:00:00Z')
const EARLIER = new Date('2026-01-10T08:00:00Z')

const SIGNED_CONTRACT_ROW = {
  id: 'sc-1',
  contractNumber: 'CHK-1-2026',
  signedAt: NOW,
  signedTypedName: 'Ivan Petrenko',
  signedIp: '192.168.1.1',
  bodyMarkdownSnapshot: '# MSA\n\nИмя: Ivan Petrenko',
  templateRole: 'SENIOR',
  templateVersion: 1,
}

const TOS_ROW = {
  id: 'ta-1',
  acceptedAt: EARLIER,
  acceptedIp: '10.0.0.1',
  tosVersion: 2,
  tosBodyMarkdown: '# Terms of Service v2\n\nAll rights reserved.',
}

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

/**
 * Creates a Drizzle-like query builder chain that resolves to `rows`.
 * Each method returns `this` for chaining; the chain itself is a thenable
 * Promise so both `.limit(n)` (thenable) and `.orderBy(...)` (thenable) work.
 */
function makeQueryChain(rows: unknown[]) {
  // Use a real Promise as the base so await works on the chain directly.
  const p = Promise.resolve(rows)
  const chain: Record<string, unknown> = {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  }
  const methods = ['from', 'innerJoin', 'where', 'orderBy', 'limit']
  methods.forEach((m) => {
    chain[m] = vi.fn().mockReturnValue(chain)
  })
  return chain
}

function makeDrizzleMock({
  contractRows = [SIGNED_CONTRACT_ROW],
  tosRows = [TOS_ROW],
}: {
  contractRows?: unknown[]
  tosRows?: unknown[]
} = {}) {
  let callCount = 0
  const db = {
    select: vi.fn().mockImplementation(() => {
      callCount++
      // Odd calls → contracts, even calls → tos
      const rows = callCount % 2 !== 0 ? contractRows : tosRows
      return makeQueryChain(rows)
    }),
  }
  return db
}

function makeService(dbMock: { select: ReturnType<typeof vi.fn> }) {
  const dbService = { db: dbMock } as unknown as DatabaseService
  return new AuditService(dbService)
}

// ---------------------------------------------------------------------------
// getUserAudit
// ---------------------------------------------------------------------------

describe('AuditService.getUserAudit', () => {
  it('returns only rows for the requested userId', async () => {
    const db = makeDrizzleMock()
    const service = makeService(db)

    const result = await service.getUserAudit('user-1')

    expect(result.signedContracts).toHaveLength(1)
    expect(result.signedContracts[0]?.contractNumber).toBe('CHK-1-2026')
    expect(result.signedContracts[0]?.type).toBe('contract')
    expect(result.tosAcceptances).toHaveLength(1)
    expect(result.tosAcceptances[0]?.tosVersion).toBe(2)
    expect(result.tosAcceptances[0]?.type).toBe('tos')
  })

  it('maps signedAt / acceptedAt to ISO strings', async () => {
    const db = makeDrizzleMock()
    const service = makeService(db)

    const result = await service.getUserAudit('user-1')

    expect(result.signedContracts[0]?.signedAt).toBe(NOW.toISOString())
    expect(result.tosAcceptances[0]?.acceptedAt).toBe(EARLIER.toISOString())
  })

  it('returns empty arrays when user has no compliance records', async () => {
    const db = makeDrizzleMock({ contractRows: [], tosRows: [] })
    const service = makeService(db)

    const result = await service.getUserAudit('user-unknown')

    expect(result.signedContracts).toHaveLength(0)
    expect(result.tosAcceptances).toHaveLength(0)
  })

  it('handles null IP addresses gracefully', async () => {
    const rowWithNullIp = { ...SIGNED_CONTRACT_ROW, signedIp: null }
    const db = makeDrizzleMock({ contractRows: [rowWithNullIp] })
    const service = makeService(db)

    const result = await service.getUserAudit('user-1')

    expect(result.signedContracts[0]?.signedIp).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getAllAudit
// ---------------------------------------------------------------------------

describe('AuditService.getAllAudit', () => {
  it('returns merged events sorted by date DESC', async () => {
    const db = makeDrizzleMock()
    const service = makeService(db)

    const result = await service.getAllAudit({ limit: 50, offset: 0 })

    expect(result.total).toBe(2)
    // contract (NOW=Jan 15) should come before tos (EARLIER=Jan 10)
    expect(result.items[0]?.type).toBe('contract')
    expect(result.items[1]?.type).toBe('tos')
  })

  it('applies offset pagination correctly', async () => {
    const db = makeDrizzleMock()
    const service = makeService(db)

    const result = await service.getAllAudit({ limit: 1, offset: 1 })

    expect(result.total).toBe(2)
    expect(result.items).toHaveLength(1)
    // After skipping the first (contract), we get the tos row
    expect(result.items[0]?.type).toBe('tos')
  })

  it('returns empty items and total=0 when no records exist', async () => {
    const db = makeDrizzleMock({ contractRows: [], tosRows: [] })
    const service = makeService(db)

    const result = await service.getAllAudit({ limit: 50, offset: 0 })

    expect(result.total).toBe(0)
    expect(result.items).toHaveLength(0)
  })

  it('fetches only contract rows when type=contract', async () => {
    const db = makeDrizzleMock()
    const service = makeService(db)

    // Spy: with type='contract', only first .select() call happens
    const result = await service.getAllAudit({ limit: 50, offset: 0, type: 'contract' })

    // All items must be contract type
    result.items.forEach((item) => expect(item.type).toBe('contract'))
  })

  it('fetches only tos rows when type=tos', async () => {
    // When type=tos, contractRows are skipped (Promise.resolve([])), tosRows used
    const db = {
      select: vi.fn().mockImplementation(() => makeQueryChain([TOS_ROW])),
    }
    const service = makeService(db)

    const result = await service.getAllAudit({ limit: 50, offset: 0, type: 'tos' })

    expect(result.items.every((i) => i.type === 'tos')).toBe(true)
  })
})
