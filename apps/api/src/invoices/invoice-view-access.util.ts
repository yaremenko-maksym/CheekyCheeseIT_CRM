import { HttpStatus } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import type { Transaction } from '../database/schema'
import { getCounterpartyId } from './invoice-counterparty.util'

/**
 * RBAC for `getInvoice`: ADMIN + ACCOUNTANT see everything; everyone else
 * must be the counterparty. Throws 403 with a Russian message.
 */
export function assertCanViewInvoice(viewer: SessionUser, tx: Transaction): void {
  if (viewer.role === 'ADMIN' || viewer.role === 'ACCOUNTANT') return
  if (getCounterpartyId(tx) === viewer.id) return
  throw apiError('INVOICE_ACCESS_DENIED', HttpStatus.FORBIDDEN)
}
