/**
 * п.4 → i18n server-text PR2 — contract name in listContractVirtualEntries.
 *
 * The server no longer composes a Russian label for virtual employee-contract
 * entries: it ships `nameKind` (+ `contractNumber` for SIGNED) and the client
 * renders the words in the viewer's locale (`CONTRACT_NAME_MESSAGES`). `name`
 * stays a non-empty, ASCII, prose-free marker (the DTO requires min(1)); it
 * must never expose the raw uuid. s3Key/download paths remain unchanged.
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
  pdfSizeBytes?: number | null
}) {
  return {
    id: overrides.id ?? `contract-${Math.random().toString(36).slice(2)}`,
    userId: overrides.userId ?? SENIOR.id,
    status: overrides.status,
    createdAt: overrides.createdAt ?? new Date('2026-06-01'),
    signedContract:
      overrides.status === 'SIGNED' && overrides.contractNumber
        ? { contractNumber: overrides.contractNumber, pdfSizeBytes: overrides.pdfSizeBytes ?? null }
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
        // AC6: buildContractVirtualEntries resolves owner display names via
        // users.findMany. These name-focused tests don't assert on the owner
        // label, so an empty result (→ uploadedByDisplayName null) is enough.
        users: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([]),
              }),
            }),
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
  // task-file-storage-hardening HIGH-1: DocumentsService now injects
  // HrAccessService (getTeammateIds' team-overlap step). This suite's SENIOR
  // actor never has an active team in these fixtures — an empty peer list
  // is the correct/only relevant shape for tests that don't exercise §1.
  const hrAccess = { getActiveTeamPeers: vi.fn().mockResolvedValue([]) } as never
  return new DocumentsService(db as never, s3, compression, hrAccess)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DocumentsService — contract virtual entry structured name (PR2)', () => {
  it('SIGNED contract with contractNumber → nameKind CONTRACT_SIGNED + contractNumber, no Russian name', async () => {
    const rows = [
      makeContractRow({ status: 'SIGNED', contractNumber: 'CHK-7F3A9C', userId: SENIOR.id }),
    ]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result).toHaveLength(1)
    expect(result[0]!.nameKind).toBe('CONTRACT_SIGNED')
    expect(result[0]!.contractNumber).toBe('CHK-7F3A9C')
    expect(result[0]!.name).not.toMatch(/[а-яА-ЯёЁіїєґІЇЄҐ]/)
  })

  it('READY_TO_SIGN contract → nameKind CONTRACT_TO_SIGN, no number', async () => {
    const rows = [makeContractRow({ status: 'READY_TO_SIGN', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result).toHaveLength(1)
    expect(result[0]!.nameKind).toBe('CONTRACT_TO_SIGN')
    expect(result[0]!.contractNumber).toBeNull()
  })

  it('DRAFT contract (ADMIN view) → nameKind CONTRACT_DRAFT, no number', async () => {
    const rows = [makeContractRow({ status: 'DRAFT', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(ADMIN, { category: 'CONTRACT' })

    expect(result).toHaveLength(1)
    expect(result[0]!.nameKind).toBe('CONTRACT_DRAFT')
    expect(result[0]!.contractNumber).toBeNull()
  })

  it('SIGNED without signedContract row → neutral CONTRACT, not DRAFT', async () => {
    // Edge case: signedContractId set but relation missing (orphan state).
    // LOW-fix: SIGNED without the relation → neutral kind CONTRACT, never
    // CONTRACT_DRAFT (semantically wrong for a signed document).
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

    // Falls back to the neutral kind — nothing exposes the raw uuid
    expect(result[0]!.nameKind).toBe('CONTRACT')
    expect(result[0]!.contractNumber).toBeNull()
    expect(result[0]!.name).not.toContain(rows[0]!.id)
  })

  it('s3Key is absent from public DTO — not exposed to callers (s3/documents hygiene)', async () => {
    const rows = [
      makeContractRow({ status: 'SIGNED', contractNumber: 'CHK-AABBCC', userId: SENIOR.id }),
    ]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    // s3Key intentionally omitted from the public document DTO; must not be present
    expect(result[0]).not.toHaveProperty('s3Key')
  })

  it('multiple statuses — each gets the correct kind', async () => {
    const rows = [
      makeContractRow({ status: 'SIGNED', contractNumber: 'CHK-111111', userId: SENIOR.id }),
      makeContractRow({ status: 'READY_TO_SIGN', userId: SENIOR.id }),
      makeContractRow({ status: 'DRAFT', userId: SENIOR.id }),
    ]
    const svc = makeService(rows)

    // ADMIN sees all three
    const result = await svc.list(ADMIN, { category: 'CONTRACT' })

    expect(result.map((r) => r.nameKind)).toEqual([
      'CONTRACT_SIGNED',
      'CONTRACT_TO_SIGN',
      'CONTRACT_DRAFT',
    ])
    expect(result.map((r) => r.contractNumber)).toEqual(['CHK-111111', null, null])
  })

  it('name does not contain raw UUID', async () => {
    const contractId = '550e8400-e29b-41d4-a716-446655440000'
    const rows = [makeContractRow({ id: contractId, status: 'READY_TO_SIGN', userId: SENIOR.id })]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result[0]!.name).not.toContain(contractId)
  })
})

// task-junior-ut-round2 §7 — real PDF size in the documents list (no more 0 B).
describe('DocumentsService — contract virtual entry PDF size (§7)', () => {
  it('SIGNED with pdfSizeBytes → maps the real size, not 0', async () => {
    const rows = [
      makeContractRow({
        status: 'SIGNED',
        contractNumber: 'CHK-SIZE01',
        userId: SENIOR.id,
        pdfSizeBytes: 48213,
      }),
    ]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result[0]!.sizeBytes).toBe(48213)
  })

  it('SIGNED without computed size yet (null) → falls back to 0 (no crash, no fake number)', async () => {
    const rows = [
      makeContractRow({
        status: 'SIGNED',
        contractNumber: 'CHK-SIZE02',
        userId: SENIOR.id,
        pdfSizeBytes: null,
      }),
    ]
    const svc = makeService(rows)

    const result = await svc.list(SENIOR, { category: 'CONTRACT' })

    expect(result[0]!.sizeBytes).toBe(0)
  })

  it('DRAFT / READY_TO_SIGN (no signed_contract) → size 0 (never blocks list on generation)', async () => {
    const rows = [
      makeContractRow({ status: 'READY_TO_SIGN', userId: SENIOR.id }),
      makeContractRow({ status: 'DRAFT', userId: SENIOR.id }),
    ]
    const svc = makeService(rows)

    const result = await svc.list(ADMIN, { category: 'CONTRACT' })

    expect(result[0]!.sizeBytes).toBe(0)
    expect(result[1]!.sizeBytes).toBe(0)
  })
})
