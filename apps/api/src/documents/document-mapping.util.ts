import type {
  ContractNameKind,
  Document as DocumentDto,
  DocumentCategory,
  DocumentSource,
  StatusBadge,
} from '@crm/shared'
import type { documents } from '../database/schema'

/**
 * i18n server-text PR2: `name` of a virtual employee-contract entry. The DTO
 * requires a non-empty name, but the human label is client-owned
 * (`CONTRACT_NAME_MESSAGES`, selected by `nameKind`) — this is a fixed ASCII
 * marker, not prose and never the raw uuid.
 */
export const VIRTUAL_CONTRACT_NAME_MARKER = 'employee-contract'

/**
 * Map a `documents` row into the API DTO.
 *
 * @param row                       the `documents` row as returned by Drizzle
 * @param uploaderName              display name resolved via a join (callers
 *                                  that already issued the join pass it in;
 *                                  callers that only have the row can pass
 *                                  `null` and the UI will fall back to a
 *                                  short id)
 * @param invoiceTransactionId      for INVOICE category only — the parent
 *                                  transaction id resolved via
 *                                  `transactions.invoice_document_id`. Null
 *                                  for non-INVOICE rows and for callers that
 *                                  did not issue the join.
 * @param invoicePendingSignature   computed by `list()` only: true when the
 *                                  viewer is the expected counterparty and
 *                                  no COUNTERPARTY signature exists yet.
 *                                  Other callers (`upload`, `restore`, etc.)
 *                                  pass `false` since the flag is purely a
 *                                  viewer-relative UI hint.
 */
export function mapDocument(
  row: typeof documents.$inferSelect,
  uploaderName: string | null = null,
  invoiceTransactionId: string | null = null,
  invoicePendingSignature: boolean = false,
  source: DocumentSource = 'file',
  statusBadge: StatusBadge | null = null,
): DocumentDto {
  return {
    id: row.id,
    ownerId: row.ownerId,
    projectId: row.projectId ?? null,
    category: row.category as DocumentCategory,
    name: row.name,
    originalName: row.originalName ?? null,
    // s3Key omitted — internal storage key, not part of the public DTO (s3/documents hygiene)
    thumbnailS3Key: row.thumbnailS3Key ?? null,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    uploadedBy: row.uploadedBy,
    uploadedByDisplayName: uploaderName,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    deletedBy: row.deletedBy ?? null,
    createdAt: row.createdAt.toISOString(),
    invoiceTransactionId,
    invoicePendingSignature,
    source,
    statusBadge,
    // i18n server-text PR2: real uploads carry a filename in `name`, not a
    // contract-name structure — the client renders the structure only when
    // `nameKind` is non-null.
    nameKind: null,
    contractNumber: null,
  }
}

/**
 * Derive the semantic statusBadge for a document row.
 * Returns null for categories that carry no badge (RESUME, SCAN, CONTRACT uploads, AVATAR, LOGO).
 */
export function deriveStatusBadge(
  category: DocumentCategory,
  invoiceSigned: boolean,
  receiptTxStatus: string | null,
): StatusBadge | null {
  if (category === 'INVOICE') {
    return { kind: 'invoice', state: invoiceSigned ? 'signed' : 'ready' }
  }
  if (category === 'RECEIPT') {
    if (!receiptTxStatus) return null
    // Income lifecycle: PENDING → VALIDATED → PENDING_PAYMENT → PAID
    // Only PENDING means «awaiting admin confirmation».
    // VALIDATED / PENDING_PAYMENT / PAID = already approved / in progress / settled.
    // REJECTED = needs re-confirmation → pending.
    const validatedStatuses = new Set(['VALIDATED', 'PENDING_PAYMENT', 'PAID'])
    return {
      kind: 'receipt',
      state: validatedStatuses.has(receiptTxStatus) ? 'validated' : 'pending',
    }
  }
  // RESUME, SCAN, CONTRACT (uploaded file), AVATAR, LOGO — no badge
  return null
}

/**
 * Map an employee_contracts row to a DocumentDto virtual entry.
 * The entry gets a synthetic id = the contract's id, ownerId = userId,
 * category = 'CONTRACT' (for consistent filter/grouping), and
 * source = 'employee_contract' (discriminator).
 *
 * i18n server-text PR2: the server composes NO prose. It ships a stable
 * `nameKind` discriminant (+ `contractNumber` for SIGNED) and the client
 * renders `CONTRACT_NAME_MESSAGES[nameKind]` in the viewer's locale.
 *   - SIGNED + number: CONTRACT_SIGNED (contract_number from signed_contracts)
 *   - SIGNED, no relation: CONTRACT (neutral — never DRAFT for a signed doc)
 *   - READY_TO_SIGN: CONTRACT_TO_SIGN
 *   - otherwise: CONTRACT_DRAFT
 * `name` (DTO requires min(1)) is a fixed ASCII marker that the client
 * ignores whenever `nameKind` is set; it never carries the raw uuid.
 * s3Key / download paths are not touched.
 */
export function mapContractVirtualEntry(
  contract: {
    id: string
    userId: string
    status: string
    createdAt: Date
    signedContract?: {
      contractNumber: string
      signedTypedName: string | null
      signedAt: Date | string | null
      pdfSizeBytes?: number | null
    } | null
  },
  actorUserDisplayNames: Record<string, string>,
): DocumentDto {
  const state: StatusBadge['state'] =
    contract.status === 'SIGNED'
      ? 'signed'
      : contract.status === 'READY_TO_SIGN'
        ? 'ready'
        : 'draft'

  // Name structure (PR2). SIGNED contracts carry the stable contract number
  // so the entry is identifiable without exposing the raw uuid. A SIGNED
  // contract without a signedContract relation (legacy data / relation not
  // eagerly loaded) gets the neutral CONTRACT kind rather than CONTRACT_DRAFT,
  // which would be semantically wrong for a signed document.
  const contractNumber =
    contract.status === 'SIGNED' ? (contract.signedContract?.contractNumber ?? null) : null
  const nameKind: ContractNameKind =
    contract.status === 'SIGNED'
      ? contractNumber
        ? 'CONTRACT_SIGNED'
        : 'CONTRACT'
      : contract.status === 'READY_TO_SIGN'
        ? 'CONTRACT_TO_SIGN'
        : 'CONTRACT_DRAFT'

  const uploadedByDisplayName = actorUserDisplayNames[contract.userId] ?? null

  // AC6: for SIGNED contracts, surface who signed and when.
  const signedByName =
    contract.status === 'SIGNED' ? (contract.signedContract?.signedTypedName ?? null) : null
  const signedAtIso =
    contract.status === 'SIGNED' && contract.signedContract?.signedAt
      ? new Date(contract.signedContract.signedAt).toISOString()
      : null

  return {
    id: contract.id,
    ownerId: contract.userId,
    projectId: null,
    category: 'CONTRACT',
    name: VIRTUAL_CONTRACT_NAME_MARKER,
    originalName: null,
    nameKind,
    contractNumber,
    // s3Key omitted — not part of public DTO; virtual employee_contract entries
    // are served via a separate PDF endpoint, not direct S3 download.
    thumbnailS3Key: null,
    // task-junior-ut-round2 §7: real PDF size from the signed contract. Filled at
    // signing time; lazily backfilled on first download for legacy rows. For
    // DRAFT/READY_TO_SIGN (no signed_contract yet) and legacy rows not yet
    // downloaded, fall back to 0 — never block the list on PDF generation.
    sizeBytes: contract.signedContract?.pdfSizeBytes ?? 0,
    mimeType: 'application/pdf',
    uploadedBy: contract.userId,
    uploadedByDisplayName,
    deletedAt: null,
    deletedBy: null,
    createdAt: (contract.createdAt ?? new Date()).toISOString(),
    invoiceTransactionId: null,
    invoicePendingSignature: false,
    source: 'employee_contract' as DocumentSource,
    statusBadge: { kind: 'contract', state },
    signedByName,
    signedAt: signedAtIso,
  }
}
