import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../database/schema'
import { documents } from '../database/schema'

type Db = NodePgDatabase<typeof schema>

/**
 * task-receipts-backend. Shared receipt-document bind guard — the SINGLE
 * implementation used by TransactionsService (create/update flows + the generic
 * attach/replace endpoint) and PendingSettlementService (senior/drop IOU settle
 * with an ADMIN_PERSONAL file receipt). Extracted so the ownership + category
 * check never drifts between call-sites (DRY).
 *
 * Rules:
 *   - the document must exist (404 otherwise);
 *   - it must be a RECEIPT (400 otherwise — cannot bind an arbitrary document);
 *   - it must be owned by the expected owner:
 *       - `opts.expectedOwnerId` when provided (ADMIN binding a RECEIPT owned by
 *         the transaction receiver), else the caller themselves.
 */
export async function assertReceiptDocumentBindable(
  db: Db,
  docId: string,
  currentUser: { id: string },
  opts: { expectedOwnerId?: string } = {},
): Promise<void> {
  const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) })

  if (!doc) throw new NotFoundException('Receipt document not found')
  if (doc.category !== 'RECEIPT') {
    throw new BadRequestException('Document must be a RECEIPT to be attached to a transaction')
  }

  const expectedOwner = opts.expectedOwnerId ?? currentUser.id
  if (doc.ownerId !== expectedOwner) {
    throw new ForbiddenException('You do not have permission to attach this receipt document')
  }
}
