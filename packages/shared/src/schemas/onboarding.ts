import { z } from 'zod'
import { contractTemplateSchema } from './contracts'
import { tosVersionSchema } from './tos'

/**
 * Onboarding Phase 6A — `GET /api/onboarding/status` payload.
 *
 * Resolves the user's onboarding state. Used by:
 * - frontend gate in `routes/crm/route.tsx` to redirect to `/crm/onboarding`
 *   when contract OR ToS is required
 * - soft-notify banner for ToS-update-available
 * - onboarding wizard to render the current MSA template + ToS version
 *
 * ADMIN: all fields collapse to `false` / `null` — they bypass the gate
 * entirely and never sign MSA / accept ToS.
 *
 * For non-ADMIN:
 *   - `requiresContract = !exists signed_contracts for active template`
 *   - `requiresTos      = !exists tos_acceptances for active ToS version`
 *   - `tosUpdateAvailable = (user accepted an older version AND current active is newer)`
 *   - `contractTemplate / tosVersion` populated only when corresponding require flag is true
 *   - `latestTosVersion` always set when there is an active ToS (used by banner)
 */

export const onboardingStatusSchema = z.object({
  requiresContract: z.boolean(),
  requiresTos: z.boolean(),
  /** A3-1: true when user has a READY_TO_SIGN employee_contract (ready to sign). */
  contractReady: z.boolean(),
  contractTemplate: contractTemplateSchema.nullable(),
  tosVersion: tosVersionSchema.nullable(),
  tosUpdateAvailable: z.boolean(),
  latestTosVersion: tosVersionSchema.nullable(),
})

export type OnboardingStatusDto = z.infer<typeof onboardingStatusSchema>
