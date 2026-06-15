/**
 * task-accountant-create-transaction — GET /api/users list RBAC.
 *
 * WHY this exists (RBAC widening, finance/RBAC mandatory coverage):
 *   ACCOUNTANT gains create-parity with ADMIN on the finance page.
 *   CreateTransactionDialog needs the user directory (GET /api/users) for the
 *   admin set — SALARY receiver picker, ADMIN_TRANSFER party picker, and
 *   identifying admin-owned projects for ACCOUNTANT-registered ADMIN_INCOME.
 *   This PR therefore widens `UsersController.findAll` to also allow ACCOUNTANT.
 *
 * The role gate lives in the controller method BODY (not a decorator), so this
 * spec drives the REAL `UsersController.findAll` directly (the service list
 * methods are stubbed and tag which branch ran). This avoids the Nest test-
 * module decorator-metadata pitfall (esbuild does not emit `design:paramtypes`
 * for controller constructor injection) while still exercising the production
 * gate code, not a copy:
 *
 *   ACCOUNTANT → findAllIncludingAdmin (admins visible for transfer/owner) — NEW
 *   ADMIN      → findAllIncludingAdmin (regression)
 *   HR         → findAll (admins excluded — regression, unchanged)
 *   SENIOR / JUNIOR / DROP → ForbiddenException (no over-grant)
 */

import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { UsersController } from './users.controller'
import { UsersService } from './users.service'
import { AuditLogService } from './audit-log.service'
import { UsersAccessService } from './users-access.service'

function persona(role: SessionUser['role']): SessionUser {
  return {
    id: `5f1c0000-0000-4000-aa00-00000000000${role.length}`,
    email: `users-list-${role.toLowerCase()}@test.spec`,
    displayName: `Users List ${role}`,
    avatarUrl: null,
    role,
    seniorSharePercent: 0,
    legalFullName: null,
  }
}

describe('UsersController.findAll — list RBAC gate', () => {
  const findAllIncludingAdmin = vi.fn(() =>
    Promise.resolve([{ listMethod: 'findAllIncludingAdmin' }]),
  )
  const findAll = vi.fn(() => Promise.resolve([{ listMethod: 'findAll' }]))

  const usersService = { findAllIncludingAdmin, findAll } as unknown as UsersService
  const controller = new UsersController(
    usersService,
    {} as unknown as AuditLogService,
    {} as unknown as UsersAccessService,
  )

  beforeEach(() => {
    findAllIncludingAdmin.mockClear()
    findAll.mockClear()
  })

  // ── Allowed ─────────────────────────────────────────────────────────────────
  it('ACCOUNTANT → findAllIncludingAdmin (admins visible) — NEW parity', async () => {
    const res = (await controller.findAll(persona('ACCOUNTANT'))) as Array<{ listMethod: string }>
    expect(findAllIncludingAdmin).toHaveBeenCalledTimes(1)
    expect(findAll).not.toHaveBeenCalled()
    expect(res[0]?.listMethod).toBe('findAllIncludingAdmin')
  })

  it('ADMIN → findAllIncludingAdmin (regression)', async () => {
    await controller.findAll(persona('ADMIN'))
    expect(findAllIncludingAdmin).toHaveBeenCalledTimes(1)
    expect(findAll).not.toHaveBeenCalled()
  })

  it('HR → findAll (admins excluded — regression, unchanged)', async () => {
    await controller.findAll(persona('HR'))
    expect(findAll).toHaveBeenCalledTimes(1)
    expect(findAllIncludingAdmin).not.toHaveBeenCalled()
  })

  // ── Forbidden (no over-grant; directory never enumerated) ───────────────────
  for (const role of ['SENIOR', 'JUNIOR', 'DROP'] as const) {
    it(`${role} → ForbiddenException (and no service call)`, async () => {
      await expect(controller.findAll(persona(role))).rejects.toBeInstanceOf(ForbiddenException)
      expect(findAll).not.toHaveBeenCalled()
      expect(findAllIncludingAdmin).not.toHaveBeenCalled()
    })
  }

  // ── archived filter passthrough (regression) ────────────────────────────────
  it('passes the tri-state archived filter through to the service', async () => {
    await controller.findAll(persona('ADMIN'), 'all')
    expect(findAllIncludingAdmin).toHaveBeenCalledWith({ archived: 'all' })
  })
})
