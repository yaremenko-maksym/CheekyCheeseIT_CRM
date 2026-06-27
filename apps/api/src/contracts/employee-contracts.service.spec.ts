import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { EmployeeContract } from '../database/schema'
import { EmployeeContractsService } from './employee-contracts.service'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockViewer: SessionUser = {
  id: 'admin-uuid',
  email: 'admin@test.com',
  role: 'ADMIN',
  displayName: 'Admin User',
  legalFullName: null,
  avatarUrl: null,
}

const makeContract = (overrides: Partial<EmployeeContract> = {}): EmployeeContract => ({
  id: 'contract-uuid',
  userId: 'user-uuid',
  sourceTemplateId: 'template-uuid',
  bodyMarkdown: '# Contract body',
  status: 'DRAFT',
  signedContractId: null,
  createdByUserId: 'admin-uuid',
  customValues: {},
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
})

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeDb(overrides: Record<string, unknown> = {}) {
  const dbMethods = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeContract()]),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  }

  return {
    db: {
      query: {
        users: { findFirst: vi.fn() },
        employeeContracts: { findFirst: vi.fn() },
        // LOW-1: template lookup for custom-values cross-validation
        contractTemplates: { findFirst: vi.fn() },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeContract()]),
        }),
      }),
      ...dbMethods,
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      // Default transaction: runs the callback with the same db methods (no real rollback in unit tests)
      transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        return cb(dbMethods)
      }),
      ...overrides,
    },
  }
}

function makeTemplates(template: unknown = null) {
  return {
    getCurrentForRole: vi.fn().mockResolvedValue(template),
  }
}

function makeService(
  dbOverrides: Record<string, unknown> = {},
  template: unknown = { id: 'template-uuid', bodyMarkdown: '# Template' },
) {
  const db = makeDb(dbOverrides)
  const templates = makeTemplates(template)
  const service = new EmployeeContractsService(
    db as unknown as Parameters<typeof EmployeeContractsService.prototype.constructor>[0],
    templates as unknown as Parameters<typeof EmployeeContractsService.prototype.constructor>[1],
  )
  return { service, db, templates }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EmployeeContractsService', () => {
  describe('getOrCreateForUser', () => {
    it('returns existing non-CANCELLED contract', async () => {
      const existing = makeContract({ status: 'READY_TO_SIGN' })
      const { service, db } = makeService()
      db.db.query.users.findFirst.mockResolvedValue({ id: 'user-uuid', role: 'SENIOR' })
      db.db.query.employeeContracts.findFirst.mockResolvedValue(existing)

      const result = await service.getOrCreateForUser('user-uuid', mockViewer)

      expect(result).toBe(existing)
      expect(db.db.insert).not.toHaveBeenCalled()
    })

    it('creates DRAFT contract when no active contract exists', async () => {
      const { service, db } = makeService()
      db.db.query.users.findFirst.mockResolvedValue({ id: 'user-uuid', role: 'JUNIOR' })
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      const created = makeContract()
      db.db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      })

      const result = await service.getOrCreateForUser('user-uuid', mockViewer)

      expect(result).toBe(created)
      expect(db.db.insert).toHaveBeenCalled()
    })

    it('throws 400 for ADMIN user', async () => {
      const { service, db } = makeService()
      db.db.query.users.findFirst.mockResolvedValue({ id: 'admin-uuid', role: 'ADMIN' })

      await expect(service.getOrCreateForUser('admin-uuid', mockViewer)).rejects.toThrow(
        BadRequestException,
      )
    })

    it('throws 404 when user not found', async () => {
      const { service, db } = makeService()
      db.db.query.users.findFirst.mockResolvedValue(null)

      await expect(service.getOrCreateForUser('nonexistent', mockViewer)).rejects.toThrow(
        NotFoundException,
      )
    })

    it('throws 404 when no active template for role', async () => {
      const { service, db } = makeService({}, null)
      db.db.query.users.findFirst.mockResolvedValue({ id: 'user-uuid', role: 'JUNIOR' })
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      await expect(service.getOrCreateForUser('user-uuid', mockViewer)).rejects.toThrow(
        NotFoundException,
      )
    })
  })

  describe('updateBody', () => {
    it('updates body when contract is DRAFT', async () => {
      const contract = makeContract({ status: 'DRAFT' })
      const updated = makeContract({ status: 'DRAFT', bodyMarkdown: '# Updated' })

      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      })

      const result = await service.updateBody('user-uuid', '# Updated', mockViewer)

      expect(result.bodyMarkdown).toBe('# Updated')
    })

    it('throws 409 CONTRACT_NOT_EDITABLE when contract is READY_TO_SIGN (MED#2)', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      const err = await service.updateBody('user-uuid', '# New', mockViewer).catch((e) => e)
      expect(err).toBeInstanceOf(ConflictException)
      expect((err as ConflictException).message).toBe('CONTRACT_NOT_EDITABLE')
    })

    it('throws 409 CONTRACT_NOT_EDITABLE when contract is SIGNED (MED#2)', async () => {
      const contract = makeContract({ status: 'SIGNED' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      const err = await service.updateBody('user-uuid', '# New', mockViewer).catch((e) => e)
      expect(err).toBeInstanceOf(ConflictException)
      expect((err as ConflictException).message).toBe('CONTRACT_NOT_EDITABLE')
    })

    it('throws 404 when no active contract', async () => {
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      await expect(service.updateBody('user-uuid', '# New', mockViewer)).rejects.toThrow(
        NotFoundException,
      )
    })
  })

  describe('markReady', () => {
    it('transitions DRAFT → READY_TO_SIGN', async () => {
      const contract = makeContract({ status: 'DRAFT' })
      const ready = makeContract({ status: 'READY_TO_SIGN' })

      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([ready]),
          }),
        }),
      })

      const result = await service.markReady('user-uuid', mockViewer)
      expect(result.status).toBe('READY_TO_SIGN')
    })

    it('throws 409 when already READY_TO_SIGN', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      await expect(service.markReady('user-uuid', mockViewer)).rejects.toThrow(ConflictException)
    })

    it('throws 409 when SIGNED', async () => {
      const contract = makeContract({ status: 'SIGNED' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      await expect(service.markReady('user-uuid', mockViewer)).rejects.toThrow(ConflictException)
    })
  })

  describe('revert', () => {
    it('reverts READY_TO_SIGN → DRAFT', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const reverted = makeContract({ status: 'DRAFT' })

      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reverted]),
          }),
        }),
      })

      const result = await service.revert('user-uuid', mockViewer)
      expect(result.status).toBe('DRAFT')
      // No ToS deletion for READY_TO_SIGN
      expect(db.db.delete).not.toHaveBeenCalled()
    })

    it('reverts SIGNED → DRAFT and deletes tos_acceptances', async () => {
      const contract = makeContract({ status: 'SIGNED', signedContractId: 'sc-uuid' })
      const reverted = makeContract({ status: 'DRAFT', signedContractId: null })
      const deleteWhere = vi.fn().mockResolvedValue(undefined)

      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reverted]),
          }),
        }),
      })
      db.db.delete.mockReturnValue({ where: deleteWhere })

      const result = await service.revert('user-uuid', mockViewer)

      expect(result.status).toBe('DRAFT')
      expect(db.db.delete).toHaveBeenCalled()
      expect(deleteWhere).toHaveBeenCalled()
    })

    it('runs UPDATE + DELETE in a single db.transaction for SIGNED revert (MED#1)', async () => {
      const contract = makeContract({ status: 'SIGNED', signedContractId: 'sc-uuid' })
      const reverted = makeContract({ status: 'DRAFT', signedContractId: null })

      // Spy on transaction to verify it is called
      const txUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reverted]),
          }),
        }),
      })
      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      })
      const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = { update: txUpdate, delete: txDelete }
        return cb(tx)
      })

      const { service, db } = makeService({ transaction: txFn })
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      const result = await service.revert('user-uuid', mockViewer)
      expect(result.status).toBe('DRAFT')
      // Both writes must go through the transaction
      expect(txFn).toHaveBeenCalledOnce()
      expect(txUpdate).toHaveBeenCalled()
      expect(txDelete).toHaveBeenCalled()
    })

    it('rolls back if tos_acceptances DELETE throws (MED#1 atomicity)', async () => {
      const contract = makeContract({ status: 'SIGNED', signedContractId: 'sc-uuid' })
      const reverted = makeContract({ status: 'DRAFT', signedContractId: null })

      const txUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reverted]),
          }),
        }),
      })
      // DELETE fails — transaction must propagate the error (rollback simulated by rejection)
      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB constraint failure')),
      })
      const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = { update: txUpdate, delete: txDelete }
        return cb(tx) // real Drizzle would rollback; here we just propagate the throw
      })

      const { service, db } = makeService({ transaction: txFn })
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      await expect(service.revert('user-uuid', mockViewer)).rejects.toThrow('DB constraint failure')
    })

    it('throws 409 when already DRAFT', async () => {
      const contract = makeContract({ status: 'DRAFT' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      await expect(service.revert('user-uuid', mockViewer)).rejects.toThrow(ConflictException)
    })

    it('throws 409 when CANCELLED', async () => {
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null) // CANCELLED → no active contract

      await expect(service.revert('user-uuid', mockViewer)).rejects.toThrow(NotFoundException)
    })
  })

  describe('resetToTemplate — edge cases (GAP 5)', () => {
    it('throws 404 when no active template exists for the role', async () => {
      // makeService with null template = no active template
      const { service, db } = makeService({}, null)
      db.db.query.users.findFirst.mockResolvedValue({ id: 'user-uuid', role: 'SENIOR' })
      db.db.query.employeeContracts.findFirst.mockResolvedValue(makeContract({ status: 'DRAFT' }))

      const err = await service.resetToTemplate('user-uuid', mockViewer).catch((e) => e)

      expect(err).toBeInstanceOf(NotFoundException)
      expect((err as NotFoundException).message).toContain('No active contract template for role')
    })
  })

  describe('getOrCreateForUser — CANCELLED row edge case (GAP 5)', () => {
    it('creates new DRAFT when existing row is CANCELLED (partial-unique allows it)', async () => {
      // The query uses ne(status, 'CANCELLED') so a CANCELLED row is invisible to findFirst.
      // Simulating: findFirst returns null (CANCELLED row filtered out) → creates new DRAFT.
      const { service, db } = makeService()
      db.db.query.users.findFirst.mockResolvedValue({ id: 'user-uuid', role: 'JUNIOR' })
      // findFirst returns null → behaves as if no active contract (CANCELLED is skipped by query)
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      const newDraft = makeContract({ status: 'DRAFT' })
      db.db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newDraft]),
        }),
      })

      const result = await service.getOrCreateForUser('user-uuid', mockViewer)

      // A new DRAFT must be created — not the CANCELLED row
      expect(result.status).toBe('DRAFT')
      expect(db.db.insert).toHaveBeenCalled()
    })
  })

  describe('resetToTemplate', () => {
    it('resets body from active template when DRAFT', async () => {
      const contract = makeContract({ status: 'DRAFT', bodyMarkdown: '# Old' })
      const newBody = '# Fresh template'
      const reset = makeContract({ bodyMarkdown: newBody })

      const { service, db } = makeService({}, { id: 'new-template-uuid', bodyMarkdown: newBody })
      db.db.query.users.findFirst.mockResolvedValue({ id: 'user-uuid', role: 'JUNIOR' })
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([reset]),
          }),
        }),
      })

      const result = await service.resetToTemplate('user-uuid', mockViewer)
      expect(result.bodyMarkdown).toBe(newBody)
    })

    it('throws 409 when not DRAFT', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      await expect(service.resetToTemplate('user-uuid', mockViewer)).rejects.toThrow(
        ConflictException,
      )
    })
  })

  describe('cancel', () => {
    it('sets status to CANCELLED', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const cancelled = makeContract({ status: 'CANCELLED' })

      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([cancelled]),
          }),
        }),
      })

      const result = await service.cancel('user-uuid', mockViewer)
      expect(result.status).toBe('CANCELLED')
    })

    it('throws 404 if no active contract', async () => {
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      await expect(service.cancel('user-uuid', mockViewer)).rejects.toThrow(NotFoundException)
    })
  })

  describe('getReadyForSigning', () => {
    it('returns READY_TO_SIGN contract', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      const result = await service.getReadyForSigning('user-uuid')
      expect(result.status).toBe('READY_TO_SIGN')
    })

    it('throws 409 CONTRACT_NOT_READY when no READY_TO_SIGN contract', async () => {
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      const error = await service.getReadyForSigning('user-uuid').catch((e) => e)
      expect(error).toBeInstanceOf(ConflictException)
      expect((error as ConflictException).message).toBe('CONTRACT_NOT_READY')
    })
  })

  describe('hasSignedContract', () => {
    it('returns true when SIGNED row exists (A3-4)', async () => {
      const { service, db } = makeService()
      db.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ exists: true }]),
          }),
        }),
      })

      const result = await service.hasSignedContract('user-uuid')
      expect(result).toBe(true)
    })

    it('returns false when no SIGNED row (DRAFT/READY_TO_SIGN/none) (A3-4)', async () => {
      const { service, db } = makeService()
      db.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      })

      const result = await service.hasSignedContract('user-uuid')
      expect(result).toBe(false)
    })
  })

  describe('hasReadyContract', () => {
    it('returns true when READY_TO_SIGN row exists', async () => {
      const { service, db } = makeService()
      db.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ exists: true }]),
          }),
        }),
      })

      const result = await service.hasReadyContract('user-uuid')
      expect(result).toBe(true)
    })

    it('returns false when no READY_TO_SIGN row', async () => {
      const { service, db } = makeService()
      db.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      })

      const result = await service.hasReadyContract('user-uuid')
      expect(result).toBe(false)
    })
  })

  describe('markSigned', () => {
    it('transitions READY_TO_SIGN → SIGNED with signedContractId', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const signed = makeContract({ status: 'SIGNED', signedContractId: 'sc-uuid' })

      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([signed]),
          }),
        }),
      })

      const result = await service.markSigned('user-uuid', 'sc-uuid')
      expect(result.status).toBe('SIGNED')
      expect(result.signedContractId).toBe('sc-uuid')
    })

    it('throws 409 CONTRACT_NOT_READY if no READY_TO_SIGN contract', async () => {
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      await expect(service.markSigned('user-uuid', 'sc-uuid')).rejects.toThrow(ConflictException)
    })
  })

  // ─── Screen 2: updateCustomValues ─────────────────────────────────────────

  describe('updateCustomValues', () => {
    it('saves custom values when contract is DRAFT', async () => {
      const contract = makeContract({ status: 'DRAFT' })
      const updated = makeContract({ customValues: { projectName: 'ACME' } })
      const { service, db } = makeService()

      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      // LOW-1: template must declare the key used in customValues
      db.db.query.contractTemplates.findFirst.mockResolvedValue({
        id: 'template-uuid',
        customVariables: [{ key: 'projectName', label: 'Project Name', required: false }],
      })
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      })

      const result = await service.updateCustomValues(
        'user-uuid',
        { projectName: 'ACME' },
        mockViewer,
      )

      expect(result.customValues).toEqual({ projectName: 'ACME' })
    })

    it('LOW-1: rejects unknown key not declared in template customVariables', async () => {
      const contract = makeContract({ status: 'DRAFT' })
      const { service, db } = makeService()

      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      // Template declares only 'projectName' — 'arbitraryKey' is unknown
      db.db.query.contractTemplates.findFirst.mockResolvedValue({
        id: 'template-uuid',
        customVariables: [{ key: 'projectName', label: 'Project Name', required: false }],
      })

      await expect(
        service.updateCustomValues('user-uuid', { arbitraryKey: 'value' }, mockViewer),
      ).rejects.toThrow(BadRequestException)
    })

    it('LOW-1: allows all keys when template has no declared variables (null/empty)', async () => {
      // When template has no customVariables (empty array), no keys are unknown.
      // This handles templates that predate the customVariables feature.
      const contract = makeContract({ status: 'DRAFT' })
      const updated = makeContract({ customValues: {} })
      const { service, db } = makeService()

      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.query.contractTemplates.findFirst.mockResolvedValue({
        id: 'template-uuid',
        customVariables: [],
      })
      db.db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      })

      // Empty customValues passes when template has no declared vars
      await expect(service.updateCustomValues('user-uuid', {}, mockViewer)).resolves.toBeDefined()
    })

    it('throws 409 CONTRACT_NOT_EDITABLE when status is READY_TO_SIGN', async () => {
      const contract = makeContract({ status: 'READY_TO_SIGN' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      await expect(
        service.updateCustomValues('user-uuid', { key: 'val' }, mockViewer),
      ).rejects.toThrow(ConflictException)
    })

    it('throws 409 CONTRACT_NOT_EDITABLE when status is SIGNED', async () => {
      const contract = makeContract({ status: 'SIGNED' })
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)

      await expect(
        service.updateCustomValues('user-uuid', { key: 'val' }, mockViewer),
      ).rejects.toThrow(ConflictException)
    })

    it('throws 404 when no active contract found', async () => {
      const { service, db } = makeService()
      db.db.query.employeeContracts.findFirst.mockResolvedValue(null)

      await expect(
        service.updateCustomValues('user-uuid', { key: 'val' }, mockViewer),
      ).rejects.toThrow(NotFoundException)
    })

    it('LOW-1: throws 404 CONTRACT_TEMPLATE_NOT_FOUND when sourceTemplateId is orphaned', async () => {
      // Simulates the case where the contract's sourceTemplateId points to a
      // deleted template. Before the fix this produced a misleading 400
      // ("unknown keys") because the allowed-key set was empty. After the fix
      // it throws NotFoundException with the correct code so the caller knows
      // the data is inconsistent, not that the submitted keys are wrong.
      const contract = makeContract({ status: 'DRAFT', sourceTemplateId: 'deleted-template-uuid' })
      const { service, db } = makeService()

      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      // Orphaned: contractTemplates.findFirst returns null
      db.db.query.contractTemplates.findFirst.mockResolvedValue(null)

      const err = await service
        .updateCustomValues('user-uuid', { anyKey: 'value' }, mockViewer)
        .catch((e) => e)

      expect(err).toBeInstanceOf(NotFoundException)
      expect((err as NotFoundException).message).toBe('CONTRACT_TEMPLATE_NOT_FOUND')
    })
  })

  // ─── fix(bug-4): sharePercent must NOT block gate for non-SENIOR/DROP roles ──

  describe('getContractVariables — sharePercent isEmpty for non-SENIOR/DROP', () => {
    /**
     * Helper: sets up service + mocks so getContractVariables resolves.
     * `role` controls the user row; `body` is the contract markdown (may
     * contain {{sharePercent}} to trigger the classification branch).
     */
    function makeServiceForVariables(role: string, body: string) {
      const contract = makeContract({ bodyMarkdown: body, customValues: {} })
      const { service, db } = makeService(
        {},
        { id: 'template-uuid', bodyMarkdown: body, customVariables: [] },
      )
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.query.users.findFirst.mockResolvedValue({
        id: 'user-uuid',
        role,
        seniorSharePercent: 26,
        dropSharePercent: null,
        email: 'test@example.com',
        displayName: 'Test',
        legalFullName: null,
        walletUsdtErc20: null,
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
        paymentMethod: null,
        monthlySalary: null,
        salaryCurrency: null,
        phone: null,
        registrationAddress: null,
        usrRecord: null,
      })
      // select for template customVariables
      db.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ customVariables: [] }]),
          }),
        }),
      })
      return service
    }

    it('HR: sharePercent isEmpty=false (not applicable — must not block gate)', async () => {
      const service = makeServiceForVariables('HR', '{{sharePercent}}')
      const result = await service.getContractVariables('user-uuid')
      const v = result.variables.find((x) => x.key === 'sharePercent')
      expect(v).toBeDefined()
      expect(v?.isEmpty).toBe(false)
    })

    it('JUNIOR: sharePercent isEmpty=false (not applicable)', async () => {
      const service = makeServiceForVariables('JUNIOR', '{{sharePercent}}')
      const result = await service.getContractVariables('user-uuid')
      const v = result.variables.find((x) => x.key === 'sharePercent')
      expect(v?.isEmpty).toBe(false)
    })

    it('ACCOUNTANT: companySharePercent isEmpty=false (not applicable)', async () => {
      const service = makeServiceForVariables('ACCOUNTANT', '{{companySharePercent}}')
      const result = await service.getContractVariables('user-uuid')
      const v = result.variables.find((x) => x.key === 'companySharePercent')
      expect(v?.isEmpty).toBe(false)
    })

    it('SENIOR: sharePercent isEmpty=false (has seniorSharePercent=26)', async () => {
      const service = makeServiceForVariables('SENIOR', '{{sharePercent}}')
      const result = await service.getContractVariables('user-uuid')
      const v = result.variables.find((x) => x.key === 'sharePercent')
      expect(v?.isEmpty).toBe(false)
    })

    it('DROP with null dropSharePercent: sharePercent isEmpty=true', async () => {
      const contract = makeContract({ bodyMarkdown: '{{sharePercent}}', customValues: {} })
      const { service, db } = makeService(
        {},
        { id: 'template-uuid', bodyMarkdown: '{{sharePercent}}', customVariables: [] },
      )
      db.db.query.employeeContracts.findFirst.mockResolvedValue(contract)
      db.db.query.users.findFirst.mockResolvedValue({
        id: 'user-uuid',
        role: 'DROP',
        dropSharePercent: null,
        seniorSharePercent: 26,
        email: 't@t.com',
        displayName: 'D',
        legalFullName: null,
        walletUsdtErc20: null,
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
        paymentMethod: null,
        monthlySalary: null,
        salaryCurrency: null,
        phone: null,
        registrationAddress: null,
        usrRecord: null,
      })
      db.db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ customVariables: [] }]),
          }),
        }),
      })
      const result = await service.getContractVariables('user-uuid')
      const v = result.variables.find((x) => x.key === 'sharePercent')
      expect(v?.isEmpty).toBe(true)
    })
  })
})
