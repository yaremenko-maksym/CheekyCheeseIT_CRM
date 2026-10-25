import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { JobSourceAdminController } from './job-source-admin.controller'
import type { JobSourceAdminService } from './job-source-admin.service'

/**
 * Unit doubles for the T9 controller (the mutation gate never runs the integration specs). The
 * guard chain itself is pinned by job-source-admin-rbac.integration.spec.ts.
 */
const ADMIN = { id: 'a', role: 'ADMIN' } as SessionUser
const SOURCE = '11111111-2222-4333-8444-555555555555'

function harness() {
  const service = {
    listExcluded: vi.fn(async () => []),
    resetFailures: vi.fn(async () => undefined),
  }
  return {
    controller: new JobSourceAdminController(service as unknown as JobSourceAdminService),
    service,
  }
}

describe('JobSourceAdminController', () => {
  it('wraps the listing in { items } and passes the caller', async () => {
    const h = harness()
    expect(await h.controller.listExcluded(ADMIN)).toEqual({ items: [] })
    expect(h.service.listExcluded).toHaveBeenCalledWith(ADMIN)
  })

  it('parses the reset body (trimmed) and passes id, body and caller', async () => {
    const h = harness()
    await h.controller.resetFailures(SOURCE, { reason: ' fixed ' }, ADMIN)
    expect(h.service.resetFailures).toHaveBeenCalledWith(SOURCE, { reason: 'fixed' }, ADMIN)
  })

  it.each([undefined, {}, { reason: '' }, { reason: 'x'.repeat(501) }])(
    'refuses body %j before the service is called',
    async (body) => {
      const h = harness()
      await expect(h.controller.resetFailures(SOURCE, body, ADMIN)).rejects.toThrow(ZodError)
      expect(h.service.resetFailures).not.toHaveBeenCalled()
    },
  )
})
