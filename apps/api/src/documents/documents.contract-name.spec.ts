/**
 * п.4 — Readable contract name in listContractVirtualEntries.
 *
 * Verifies that the `name` field returned by DocumentsService for virtual
 * employee-contract entries is a human-readable Russian label instead of the
 * raw `contract-<uuid>` key, while s3Key/download paths remain unchanged.
 *
 * Strategy: mock db.query.employeeContracts.findMany to return synthetic rows
 * with signedContract eager-loaded (mirrors the `with: { signedContract: true }`
 * Drizzle query). Invoke list() with category='CONTRACT' (which routes through
 * listContractVirtualEntries) and assert on the returned name values.
 *
 * No DB, no S3, no NestJS runtime.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { DocumentsService } from './documents.service'

// ── Actors ────────────────────────────────────────────────────────────────────

const ADMIN: SessionUser = {
  id: 'admin-uuid-0001',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@example.com',
}

const SENIOR: SessionUser = {
  id: 'senior-uuid-0001',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@example.com',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContractRow(overrides: {
  id?: string
  userId?: string
  status: 'DRAFT' | 'READY_TO_SIGN' | 'SIGNED' | 'CANCELLED'
  contractNumber?: string
  createdAt?: Date
}) {
  return {
    id: overrides.id ?? `contract-${Math.random().toString(36).slice(2)}`,
    userId: overrides.userId ?? SENIOR.id,
    status: overrides.status,
    createdAt: overrides.createdAt ?? new Date('2026-06-01'),
    signedContract:
      overrides.status === 'SIGNED' && overrides.contractNumber
        ? { contractNumber: overrides.contractNumber }
        : null,
  }
}

function makeService(contractRows: ReturnType<typeof makeContractRow>[]) {
  const db = {
    db: {
      query: {
        employeeContracts: {
          findMany: vi.fn().mockResolvedValue(contractRows),
        },
        documents: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
          where: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    },
  }

  const s3 = {} as never
  const compression = {} as never
  return new DocumentsService(db as never, s3, compression)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DocumentsService — contract virtual entry readable name (п.4)', () => {
  it('SIGNED contract with contractNumber → «Трудовой договор CHK-XXXXXX»', async () => {
    const rows = [makeContractRow({ status: 'SIGNED', contractNumber: 'CHK-7F3A9C', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('Трудовой договор CHK-7F3A9C')
  })

  it('READY_TO_SIGN contract → «Трудовой договор (к подписанию)»', async () => {
    const rows = [makeContractRow({ status: 'READY_TO_SIGN', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('Трудовой договор (к подписанию)')
  })

  it('DRAFT contract (ADMIN view) → «Трудовой договор (черновик)»', async () => {
    const rows = [makeContractRow({ status: 'DRAFT', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(ADMIN, { category: 'CONTRACT' })

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('Трудовой договор (черновик)')
  })

  it('SIGNED without signedContract row → falls back to «Трудовой договор (черновик)»', async () => {
    // Edge case: signedContractId set but relation missing (orphan state)
    const rows = [
      {
        id: 'orphan-id',
        userId: SENIOR.id,
        status: 'SIGNED' as const,
        createdAt: new Date(),
        signedContract: null,
      },
    ]
    const svc = makeService(rows)

    const result = await svc.list(ADMIN, { category: 'CONTRACT' })

    // Falls back to draft label — the name does NOT expose the raw uuid
    expect(result[0]!.name).toBe('Трудовой договор (черновик)')
    expect(result[0]!.name).not.toContain(rows[0]!.id)
  })

  it('s3Key remains empty string — download path not affected', async () => {
    const rows = [makeContractRow({ status: 'SIGNED', contractNumber: 'CHK-AABBCC', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result[0]!.s3Key).toBe('')
  })

  it('multiple statuses — each gets correct label', async () => {
    const rows = [
      makeContractRow({ status: 'SIGNED', contractNumber: 'CHK-111111', userId: SENIOR.id }),
      makeContractRow({ status: 'READY_TO_SIGN', userId: SENIOR.id }),
      makeContractRow({ status: 'DRAFT', userId: SENIOR.id }),
    ]
    const svc = makeService(rows)

    // ADMIN sees all three
    const result = await svc.list(ADMIN, { category: 'CONTRACT' })

    expect(result[0]!.name).toBe('Трудовой договор CHK-111111')
    expect(result[1]!.name).toBe('Трудовой договор (к подписанию)')
    expect(result[2]!.name).toBe('Трудовой договор (черновик)')
  })

  it('name does not contain raw UUID', async () => {
    const contractId = '550e8400-e29b-41d4-a716-446655440000'
    const rows = [makeContractRow({ id: contractId, status: 'READY_TO_SIGN', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result[0]!.name).not.toContain(contractId)
  })
})
