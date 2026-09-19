import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { InvoicesController } from './invoices.controller'

/**
 * Fix-раунд 3 (task-680, SR-M-4). `sign()` forwards the WHOLE `SessionUser`
 * to `InvoicesService.signInvoice` (no field-by-field reconstruction like
 * `SignedContractsController.sign` needed for SR-H-1) — so `impersonatorId`
 * cannot be dropped in transit by construction. This test pins that wiring
 * anyway (mutation-gate cannot see `*.integration.spec.ts`, see
 * `mutation-gate-integration-specs.md`), matching the same unit-double
 * pattern used for the contracts and ToS controllers in this PR.
 */

const mkReq = (): FastifyRequest => ({}) as unknown as FastifyRequest

function makeController(service: Record<string, ReturnType<typeof vi.fn>>): InvoicesController {
  return new InvoicesController(service as never)
}

const junior: SessionUser = {
  id: 'junior-1',
  role: 'JUNIOR',
  displayName: 'Junior One',
  email: 'j@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const impersonated: SessionUser = {
  ...junior,
  impersonating: true,
  impersonatorId: 'admin-1',
}

describe('InvoicesController.sign — passes the whole SessionUser through (SR-M-4)', () => {
  it('forwards a SessionUser carrying impersonatorId to the service', () => {
    const service = { signInvoice: vi.fn().mockReturnValue('signed') }
    const controller = makeController(service)

    controller.sign('tx-1', {}, mkReq(), impersonated)

    expect(service.signInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'junior-1', impersonatorId: 'admin-1' }),
      'tx-1',
      expect.anything(),
    )
  })

  it('forwards a SessionUser with no impersonatorId when the session is not impersonated', () => {
    const service = { signInvoice: vi.fn().mockReturnValue('signed') }
    const controller = makeController(service)

    controller.sign('tx-1', {}, mkReq(), junior)

    expect(service.signInvoice).toHaveBeenCalledWith(
      expect.not.objectContaining({ impersonatorId: expect.anything() }),
      'tx-1',
      expect.anything(),
    )
  })
})
