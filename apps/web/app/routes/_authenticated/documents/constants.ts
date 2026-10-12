import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { DocumentCategory } from '@crm/shared'
import type { CategoryFilter, DocumentView, Role, StatusTab } from './types'

// Deep-link params:
//   - `openDocId` — open DocumentDetailDialog for the matching document
//     id once the list query resolves (used by audit/restore links).
//   - `openTx` — INVOICE-only: open InvoiceDetailDialog for that
//     transaction id (used by notifications «инвойс подписан» / «ожидает
//     подписи»). Also auto-narrows the category filter to INVOICE so the
//     surrounding list reflects the deep-link target.
export const VIEW_STORAGE_KEY = 'crm.documents.view'

export function getStoredView(): DocumentView {
  try {
    const v = typeof window !== 'undefined' ? localStorage.getItem(VIEW_STORAGE_KEY) : null
    return v === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

export function setStoredView(v: DocumentView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, v)
  } catch {
    // ignore — storage may be blocked
  }
}

// task-i18n-stage3e-pr1: the page's OWN local category map is gone —
// category text now comes from the shared hub (`CATEGORY_LABEL_MESSAGES`,
// `components/documents/document-labels.ts`), the single canon
// `upload-document-dialog.tsx`/`document-detail-dialog.tsx` migrate onto in
// their own PRs (COPY-H-docs-3).

/**
 * Status-tab labels (ADMIN-only tri-state toggle above the toolbar). Kept
 * local to this route — unlike the category/status canon in `document-
 * labels.ts`, nothing else in the wave (e) perimeter renders these three
 * words.
 */
export const STATUS_TAB_LABEL_MESSAGES = {
  ALL: msg`Усі`,
  ACTIVE: msg`Активні`,
  ARCHIVED: msg`Архів`,
} satisfies Record<StatusTab, MessageDescriptor>

/**
 * RBAC visibility per spec table «Видимость табов по ролям».
 * Maps Role → set of categories that role may see in the dropdown.
 * INVOICE is exposed to all roles except HR — the backend scopes the list
 * to "own invoices" for non-ADMIN/ACCOUNTANT (where ownerId == viewer.id),
 * and HR is never an invoice owner, so the tab would always be empty for HR.
 */
export const TAB_VISIBILITY: Record<Role, DocumentCategory[]> = {
  ADMIN: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
  SENIOR: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
  JUNIOR: ['RESUME', 'SCAN', 'CONTRACT', 'INVOICE'],
  HR: ['RESUME', 'SCAN', 'CONTRACT'],
  ACCOUNTANT: ['SCAN', 'RECEIPT', 'INVOICE'],
  // Drop role - phase 1 (backend): documents UX for DROP ships in a later
  // phase. Mirror the SENIOR set so the page renders without runtime crash.
  DROP: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
}

/**
 * Which categories does this role actually upload through /documents?
 * (RECEIPT is uploaded from the Finance dialogs; ACCOUNTANT does not upload
 * at all from this page.)
 */
export const UPLOADABLE_PER_ROLE: Record<Role, DocumentCategory[]> = {
  ADMIN: ['RESUME', 'SCAN', 'CONTRACT'],
  SENIOR: ['RESUME', 'SCAN', 'CONTRACT'],
  JUNIOR: ['RESUME', 'SCAN'],
  HR: ['RESUME', 'SCAN'],
  ACCOUNTANT: [],
  // Drop role - phase 1 (backend): drop document UX ships in a later phase.
  DROP: ['RESUME', 'SCAN', 'CONTRACT'],
}

export function canSeeOwnerFilter(role: Role): boolean {
  return role === 'ADMIN' || role === 'HR'
}

/**
 * Returns the initial category filter for the documents page.
 *
 * Priority:
 *   1. Explicit deep-link `?category=<X>` — always wins.
 *   2. Role-based default: ACCOUNTANT → 'RECEIPT' (primary workflow: validating
 *      receipts as proof of income). All other roles → 'ALL'.
 *
 * Note: 'RECEIPT' is in TAB_VISIBILITY['ACCOUNTANT'], so the downstream
 * reset-to-ALL effect (which fires when the selected category is not in
 * availableCategories) will never override this default. No conflict.
 *
 * Exported for unit testing; no React dependencies.
 */
export function initialCategoryForRole(
  role: Role,
  deepLinkCategory: DocumentCategory | undefined,
): CategoryFilter {
  if (deepLinkCategory !== undefined) return deepLinkCategory
  // AC3: default = 'ALL' for ALL roles (including ACCOUNTANT).
  // Previously ACCOUNTANT defaulted to 'RECEIPT'; now every role starts
  // on "Все категории" and narrows down via the dropdown.
  void role // role kept in signature for possible future per-role defaults
  return 'ALL'
}
