import type { SeniorSelectableRole } from '@crm/shared'

/**
 * Valid SENIOR technical roles for test data: one role, the floor (`SENIOR_MIN_ROLES` in
 * @crm/shared). Use it wherever a spec creates or promotes a SENIOR for a reason other than the
 * floor itself.
 */
export const SENIOR_TECHNICAL_ROLES: SeniorSelectableRole[] = ['BACKEND_ENGINEER']
