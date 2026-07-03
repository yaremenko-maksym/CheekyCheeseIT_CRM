import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { ConflictException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ContractTemplatesService } from './contract-templates.service'
import type { DatabaseService } from '../database/database.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmpl-1',
    targetRole: 'SENIOR' as const,
    version: 1,
    bodyMarkdown: '# MSA SENIOR\n\n{{employeeName}}',
    isActive: true,
    createdByUserId: 'admin-1',
    customVariables: [] as Array<{ key: string; label: string; defaultValue?: string }>,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

interface MockDb {
  db: {
    query: {
      contractTemplates: {
        findMany: ReturnType<typeof vi.fn>
        findFirst: ReturnType<typeof vi.fn>
      }
    }
    transaction: ReturnType<typeof vi.fn>
    insert: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

function makeDb({
  templates = [makeTemplate()],
  insertResult = [makeTemplate({ id: 'tmpl-new', version: 2 })],
  maxVersion = 1,
}: {
  templates?: ReturnType<typeof makeTemplate>[]
  insertResult?: ReturnType<typeof makeTemplate>[]
  maxVersion?: number
} = {}): MockDb {
  const findManyMock = vi.fn().mockResolvedValue(templates)

  const txInsertReturning = vi.fn().mockResolvedValue(insertResult)
  const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })
  const txInsert = vi.fn().mockReturnValue({ values: txInsertValues })

  const txUpdateWhere = vi.fn().mockResolvedValue([])
  const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere })
  const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet })

  const txSelectFromExecute = vi.fn().mockResolvedValue([{ max: maxVersion }])
  const txSelectFrom = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ execute: txSelectFromExecute }),
    execute: txSelectFromExecute,
  })
  const txSelect = vi.fn().mockReturnValue({ from: txSelectFrom })

  const tx = {
    select: txSelect,
    insert: txInsert,
    update: txUpdate,
  }

  return {
    db: {
      query: {
        contractTemplates: {
          findMany: findManyMock,
          findFirst: vi
            .fn()
            .mockImplementation(async (args: Record<string, unknown> | undefined) => {
              if (!args) return templates[0]
              const whereFn = args['where'] as
                | ((cols: Record<string, unknown>, helpers: Record<string, unknown>) => unknown)
                | undefined
              if (!whereFn) return templates[0]
              return templates[0]
            }),
        },
      },
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
      insert: txInsert,
      update: txUpdate,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContractTemplatesService', () => {
  describe('listAll', () => {
    it('returns all templates ordered by role+version', async () => {
      const mockDb = makeDb({
        templates: [makeTemplate(), makeTemplate({ id: 'tmpl-2', targetRole: 'JUNIOR' })],
      })
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      const result = await service.listAll()

      expect(result).toHaveLength(2)
      expect(mockDb.db.query.contractTemplates.findMany).toHaveBeenCalled()
    })
  })

  describe('getCurrentForRole', () => {
    it('returns active template for given non-ADMIN role', async () => {
      const senior = makeTemplate({ targetRole: 'SENIOR', isActive: true })
      const mockDb = makeDb({ templates: [senior] })
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      const result = await service.getCurrentForRole('SENIOR')

      expect(result).toEqual(senior)
    })

    it('returns null when no active template exists for role', async () => {
      const mockDb = makeDb({ templates: [] })
      mockDb.db.query.contractTemplates.findFirst.mockResolvedValue(undefined)
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      const result = await service.getCurrentForRole('JUNIOR')

      expect(result).toBeNull()
    })

    it('throws when role is ADMIN (DB CHECK boundary)', async () => {
      const mockDb = makeDb()
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      // ADMIN never has a template — service should refuse fetch, not silently return null
      await expect(service.getCurrentForRole('ADMIN' as never)).rejects.toThrow(ForbiddenException)
    })
  })

  describe('getById', () => {
    it('returns template when found', async () => {
      const tmpl = makeTemplate({ id: 'specific-id' })
      const mockDb = makeDb({ templates: [tmpl] })
      mockDb.db.query.contractTemplates.findFirst.mockResolvedValue(tmpl)
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      const result = await service.getById('specific-id')

      expect(result).toEqual(tmpl)
    })

    it('throws NotFoundException when row missing', async () => {
      const mockDb = makeDb({ templates: [] })
      mockDb.db.query.contractTemplates.findFirst.mockResolvedValue(undefined)
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      await expect(service.getById('nope')).rejects.toThrow(NotFoundException)
    })
  })

  describe('publish', () => {
    it('atomically deactivates previous active and inserts new version=max+1', async () => {
      const mockDb = makeDb({ maxVersion: 3 })
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      const inserted = makeTemplate({ id: 'tmpl-new', version: 4, isActive: true })
      // override final insert returning result
      const txInsertReturning = vi.fn().mockResolvedValue([inserted])
      const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })
      const txUpdateWhere = vi.fn().mockResolvedValue([])
      const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere })

      mockDb.db.transaction.mockImplementation(async (fn) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([{ max: 3 }]),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({ set: txUpdateSet }),
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
        }
        return fn(tx as never)
      })

      const result = await service.publish({
        targetRole: 'SENIOR',
        bodyMarkdown: '# new body',
        createdByUserId: 'admin-1',
      })

      expect(result.version).toBe(4)
      expect(result.isActive).toBe(true)
      expect(txUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }))
      expect(txInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRole: 'SENIOR',
          version: 4,
          isActive: true,
          bodyMarkdown: '# new body',
          createdByUserId: 'admin-1',
        }),
      )
    })

    it('refuses to publish for ADMIN role', async () => {
      const mockDb = makeDb()
      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      await expect(
        service.publish({
          targetRole: 'ADMIN' as never,
          bodyMarkdown: '# body',
          createdByUserId: 'admin-1',
        }),
      ).rejects.toThrow(ForbiddenException)
    })

    it('starts version at 1 when no previous template exists for role', async () => {
      const mockDb = makeDb()
      const inserted = makeTemplate({ id: 'first', targetRole: 'HR', version: 1, isActive: true })
      const txInsertReturning = vi.fn().mockResolvedValue([inserted])
      const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })

      mockDb.db.transaction.mockImplementation(async (fn) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([{ max: null }]),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
          }),
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
        }
        return fn(tx as never)
      })

      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)
      const result = await service.publish({
        targetRole: 'HR',
        bodyMarkdown: '# body',
        createdByUserId: 'admin-1',
      })

      expect(result.version).toBe(1)
      expect(txInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ targetRole: 'HR', version: 1, isActive: true }),
      )
    })

    it('passes customVariables to the insert values', async () => {
      const mockDb = makeDb({ maxVersion: 1 })
      const customVars = [
        { key: 'projectName', label: 'Название проекта' },
        { key: 'endDate', label: 'Дата окончания', defaultValue: '31.12.2026' },
      ]
      const inserted = makeTemplate({
        id: 'tmpl-cv',
        version: 2,
        isActive: true,
        customVariables: customVars,
      })
      const txInsertReturning = vi.fn().mockResolvedValue([inserted])
      const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })
      const txUpdateWhere = vi.fn().mockResolvedValue([])
      const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere })

      mockDb.db.transaction.mockImplementation(async (fn) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([{ max: 1 }]),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({ set: txUpdateSet }),
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
        }
        return fn(tx as never)
      })

      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)
      const result = await service.publish({
        targetRole: 'SENIOR',
        bodyMarkdown: '# body with {{projectName}}',
        createdByUserId: 'admin-1',
        customVariables: customVars,
      })

      // Result carries the custom variables through
      expect(result.customVariables).toEqual(customVars)
      // Insert was called with customVariables in the values
      expect(txInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          customVariables: customVars,
        }),
      )
    })

    it('defaults customVariables to [] when not provided', async () => {
      const mockDb = makeDb({ maxVersion: 0 })
      const inserted = makeTemplate({ id: 'tmpl-no-cv', version: 1, isActive: true })
      const txInsertReturning = vi.fn().mockResolvedValue([inserted])
      const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning })

      mockDb.db.transaction.mockImplementation(async (fn) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([{ max: 0 }]),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
          }),
          insert: vi.fn().mockReturnValue({ values: txInsertValues }),
        }
        return fn(tx as never)
      })

      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)
      await service.publish({
        targetRole: 'JUNIOR',
        bodyMarkdown: '# body',
        createdByUserId: 'admin-1',
        // customVariables omitted
      })

      expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ customVariables: [] }))
    })

    it('MED-2: throws ConflictException (409) when concurrent publish hits unique violation', async () => {
      // Simulate race: tx.insert throws a PG 23505 because another concurrent
      // publish already inserted an active row for the same role between our
      // deactivate UPDATE and this INSERT.
      const pgUniqueError = Object.assign(new Error('unique violation'), { code: '23505' })

      const mockDb = makeDb({ maxVersion: 1 })
      mockDb.db.transaction.mockImplementation(async (fn) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([{ max: 1 }]),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockRejectedValue(pgUniqueError),
            }),
          }),
        }
        return fn(tx as never)
      })

      const service = new ContractTemplatesService(mockDb as unknown as DatabaseService)

      await expect(
        service.publish({
          targetRole: 'SENIOR',
          bodyMarkdown: '# body',
          createdByUserId: 'admin-1',
        }),
      ).rejects.toThrow(ConflictException)
    })
  })
})
