import { describe, expect, it } from 'vitest'
import { CompanyAccountController } from './company-account.controller'

/**
 * AC4 — getDepositStatus throttle.
 *
 * GET /company-account/deposits/:id/status is a polling endpoint that calls
 * verifyDeposit on every request. Without throttling a client can spam it and
 * trigger excessive Etherscan API calls (rate-limit abuse). A RelaxableThrottle
 * decorator must be present on the handler.
 *
 * We check via NestJS's metadata system: @Throttle() stores its config on the
 * method descriptor's metadata under the ThrottlerModule key. If the decorator
 * is absent the metadata will be undefined.
 *
 * Note: We test the PRESENCE of the throttle metadata (structural assertion),
 * not the actual throttling behaviour (that is covered by
 * contracts/throttle.integration.spec.ts for other endpoints).
 */

// NestJS @Throttle() stores config under this metadata key (ThrottlerGuard reads it)
const THROTTLER_METADATA_KEY = 'THROTTLE_METADATA:global'

describe('AC4: CompanyAccountController.getDepositStatus — @RelaxableThrottle present', () => {
  it('getDepositStatus has throttle metadata on its handler', () => {
    const prototype = CompanyAccountController.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getDepositStatus')

    expect(descriptor).toBeDefined()

    // @Throttle() decorates the handler; Reflect.getMetadata reads its config.
    // 'THROTTLE_METADATA:global' is the key NestJS ThrottlerModule uses internally.
    // If the decorator is absent this returns undefined.
    const meta = Reflect.getMetadata(THROTTLER_METADATA_KEY, descriptor!.value as object)

    expect(meta).toBeDefined()
    expect(meta).toMatchObject({
      limit: expect.any(Function),
      ttl: expect.any(Function),
    })
  })

  it('getDepositStatus throttle limit function returns a positive number', () => {
    const prototype = CompanyAccountController.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getDepositStatus')!
    const meta = Reflect.getMetadata(THROTTLER_METADATA_KEY, descriptor.value as object)

    // The limit callback (Resolvable<number>) must return a positive number
    const limit = (meta as { limit: () => number }).limit()
    expect(typeof limit).toBe('number')
    expect(limit).toBeGreaterThan(0)
  })
})
