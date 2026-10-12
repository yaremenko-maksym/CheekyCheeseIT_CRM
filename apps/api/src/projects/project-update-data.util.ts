import { HttpStatus } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { CreateProjectDto, SessionUser, UpdateProjectDto } from '@crm/shared'
import { projectPaymentTypeSchema } from '@crm/shared'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { projects, users } from '../database/schema'

/**
 * Field-scoped RBAC shared by create() and update(): the senior / drop share
 * overrides and `paymentType` may only be sent by ADMIN or ACCOUNTANT (an
 * explicit `null` counts as "sent"). Checked BEFORE the role gate of the
 * caller so an HR caller gets the more specific 403.
 */
export function assertFinanceFieldsAllowed(
  data: Pick<
    CreateProjectDto | UpdateProjectDto,
    'seniorSharePercentOverride' | 'dropSharePercentOverride' | 'paymentType'
  >,
  role: SessionUser['role'],
): void {
  if (role === 'ADMIN' || role === 'ACCOUNTANT') return
  if (data.seniorSharePercentOverride !== undefined) {
    throw apiError('SENIOR_SHARE_OVERRIDE_FORBIDDEN', HttpStatus.FORBIDDEN)
  }
  if (data.dropSharePercentOverride !== undefined) {
    throw apiError('DROP_SHARE_OVERRIDE_FORBIDDEN', HttpStatus.FORBIDDEN)
  }
  if (data.paymentType !== undefined) {
    throw apiError('PAYMENT_TYPE_CHANGE_FORBIDDEN', HttpStatus.FORBIDDEN)
  }
}

/**
 * Loads the user a `dropId` points at and asserts it is an active DROP user
 * (keeps the FK invariant `projects.dropId` -> users WHERE role = DROP).
 */
export async function resolveActiveDropId(
  db: DatabaseService['db'],
  dropId: string,
): Promise<string> {
  const drop = await db.query.users.findFirst({ where: eq(users.id, dropId) })
  if (!drop) throw apiError('DROP_NOT_FOUND', HttpStatus.NOT_FOUND)
  if (drop.role !== 'DROP') throw apiError('USER_NOT_DROP', HttpStatus.BAD_REQUEST)
  if (drop.archivedAt) throw apiError('DROP_ARCHIVED', HttpStatus.BAD_REQUEST)
  return drop.id
}

/**
 * Fields an ACCOUNTANT is allowed to patch on their own: the ones the
 * field-level RBAC above already gates to ADMIN/ACCOUNTANT.
 */
const FINANCE_SCOPED_FIELDS = [
  'seniorSharePercentOverride',
  'dropSharePercentOverride',
  'paymentType',
]

/** True when every key of the patch is finance-scoped (and the patch is non-empty). */
export function isFinanceOnlyPatch(data: UpdateProjectDto): boolean {
  const dataKeys = Object.keys(data)
  return dataKeys.length > 0 && dataKeys.every((k) => FINANCE_SCOPED_FIELDS.includes(k))
}

/**
 * Builds the column patch for `ProjectsService.update`. Pure: the logo FK
 * validation and drop resolution happen in the caller BEFORE this runs.
 * `seniorSharePercentOverride` is deliberately NOT written here (it goes
 * through the pending-share proposal instead).
 */
export function buildProjectUpdateData(
  data: UpdateProjectDto,
  resolvedDropId: string | null | undefined,
  dropOverrideEffective: number | null | undefined,
): Partial<typeof projects.$inferInsert> {
  const updateData: Partial<typeof projects.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (data.name !== undefined) updateData.name = data.name
  if (data.companyName !== undefined) updateData.companyName = data.companyName
  if (data.domain !== undefined) updateData.domain = data.domain
  if (data.logoDocumentId !== undefined) {
    updateData.logoDocumentId = data.logoDocumentId ?? null
    // XOR invariant: setting documentId clears externalUrl, even when the
    // caller didn't pass externalUrl explicitly. Without this the DB CHECK
    // would block an update from "external set" to "doc set".
    if (data.logoDocumentId !== null && data.logoExternalUrl === undefined) {
      updateData.logoExternalUrl = null
    }
  }
  if (data.logoExternalUrl !== undefined) {
    updateData.logoExternalUrl = data.logoExternalUrl ?? null
    // Mirror invariant — setting external clears doc id when caller didn't
    // pass it. Skip if logoDocumentId was already set above to non-null.
    if (data.logoExternalUrl !== null && data.logoDocumentId === undefined) {
      updateData.logoDocumentId = null
    }
  }
  if (data.rate !== undefined) updateData.rate = data.rate
  if (data.currency !== undefined) updateData.currency = data.currency
  if (dropOverrideEffective !== undefined) {
    updateData.dropSharePercentOverride = dropOverrideEffective
  }
  if (resolvedDropId !== undefined) {
    updateData.dropId = resolvedDropId
  }
  if (data.techStack !== undefined) updateData.techStack = data.techStack ?? null
  if (data.teamSize !== undefined) updateData.teamSize = data.teamSize ?? null
  if (data.benefits !== undefined) updateData.benefits = data.benefits ?? null
  // paymentType is a NOT NULL enum column — validate the loose write value and
  // only apply a real value (null is ignored: you cannot clear a NOT NULL enum).
  if (data.paymentType !== undefined && data.paymentType !== null) {
    updateData.paymentType = projectPaymentTypeSchema.parse(data.paymentType)
  }
  if (data.salaryReview !== undefined) updateData.salaryReview = data.salaryReview ?? null
  if (data.corpTech !== undefined) updateData.corpTech = data.corpTech ?? null
  if (data.notesGeneral !== undefined) updateData.notesGeneral = data.notesGeneral ?? null
  return updateData
}
