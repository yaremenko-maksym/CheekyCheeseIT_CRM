/**
 * document-labels.ts — single source of truth for the copy shared across
 * the /documents screen and its components (task-i18n-stage3e-pr1,
 * COPY-H-docs-3/-4/-5/-1/-9).
 *
 * Before this file, THREE separate per-file `Record<DocumentCategory,
 * string>` maps lived in `documents.tsx`, `upload-document-dialog.tsx` and
 * `document-detail-dialog.tsx` — and disagreed with each other on the same
 * category (`CONTRACT`: «Договоры» / «Договор» / «Контракт», three different
 * words for the same enum value — COPY-H-docs-3). `CATEGORY_LABEL_MESSAGES`
 * below is the ONE canon, in the forms `CONTEXT.md` «Волна e — web-docs-
 * notify» records: one word per category, singular nominative (dropdown
 * item / detail-dialog header style), sourced in `uk`
 * (`sourceLocale: 'uk'`) with `en` as the second original.
 *
 * PR1 migrated `documents.tsx` onto the hub, PR2 migrated the card, row,
 * detail dialog and status badge, and PR3 the upload dialog — the last local
 * copy. Every consumer now reads this hub, so a second category map cannot
 * reappear without disagreeing with it.
 *
 * `CATEGORY_LABEL_MESSAGES_LOWER` exists ONLY because `.toLowerCase()` on
 * the RESULT of `i18n._()` is banned (Global Constraints, this wave's plan):
 * calling `.toLowerCase()` on a resolved uk/en string can corrupt letters
 * Lingui's macro never sees (and produces text no catalog entry pins), so
 * every lower-case rendering gets its OWN `msg` template instead of being
 * derived at runtime. `documents.tsx`'s document-count chip
 * (`· <category>`) is the only current consumer.
 *
 * `DOCUMENT_STATUS_MESSAGES` and `DELETE_CONFIRM_MESSAGES` are defined here
 * and consumed by `document-status-badge.tsx`, `document-card.tsx`,
 * `document-row.tsx` and `document-detail-dialog.tsx` (PR2); `upload-
 * document-dialog.tsx` (PR3) imports the same canon instead of
 * re-inventing its own wording — the exact failure the per-file maps
 * had (COPY-H-docs-4: `READY_TO_SIGN` reads "Готово к подписи" in one place
 * and "Ожидает подписи" in another for the same semantic status).
 */
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { DocumentCategory } from '@crm/shared'

// ---------------------------------------------------------------------------
// Category labels (COPY-H-docs-3, COPY-H-docs-5)
// ---------------------------------------------------------------------------

/**
 * One word per `DocumentCategory`, singular nominative. `INVOICE` reads
 * «Рахунок» — NOT «Інвойс»/«Invoice-невірний переклад» (COPY-H-docs-5,
 * `CONTEXT.md` glossary term «Счёт» = «Рахунок») — the three legacy maps
 * disagreed here too (`INVOICE: 'Инвойсы'` in `documents.tsx`, `'Инвойс'`
 * elsewhere).
 *
 * `RECEIPT` has no existing entry in the wave (e) plan's canon table (draft
 * covered only INVOICE/CONTRACT/RESUME/SCAN/AVATAR/LOGO) — «Чек»/«Receipt»
 * added here to keep the map total over `DocumentCategory`; recorded in
 * `CONTEXT.md` as this PR's own addition, final wording still
 * `copy-reviewer`'s call like the rest of the draft forms.
 */
export const CATEGORY_LABEL_MESSAGES = {
  RESUME: msg`Резюме`,
  SCAN: msg`Скан`,
  CONTRACT: msg`Договір`,
  RECEIPT: msg`Чек`,
  AVATAR: msg`Аватар`,
  LOGO: msg`Логотип`,
  INVOICE: msg`Рахунок`,
} satisfies Record<DocumentCategory, MessageDescriptor>

/**
 * Lower-case counterpart of `CATEGORY_LABEL_MESSAGES`, its OWN `msg`
 * template per entry — never `.toLowerCase()` on `i18n._(CATEGORY_LABEL_
 * MESSAGES[cat])` (see file header). Used by the /documents count chip
 * (`«12 документів · договір»`).
 */
export const CATEGORY_LABEL_MESSAGES_LOWER = {
  RESUME: msg`резюме`,
  SCAN: msg`скан`,
  CONTRACT: msg`договір`,
  RECEIPT: msg`чек`,
  AVATAR: msg`аватар`,
  LOGO: msg`логотип`,
  INVOICE: msg`рахунок`,
} satisfies Record<DocumentCategory, MessageDescriptor>

// ---------------------------------------------------------------------------
// Status canon (COPY-H-docs-4)
// ---------------------------------------------------------------------------

/**
 * Semantic status keys shared by `contract`/`invoice` `StatusBadge` states
 * (`packages/shared/src/schemas/documents.ts`) and by the pending-approval
 * rows (`PendingItemRow`, wave (e) PR4). `READY_TO_SIGN` is the SAME text
 * for a contract in state `'ready'` and an invoice in state `'ready'` — the
 * legacy `document-status-badge.tsx` said «Готово к подписи» for one and
 * «Ожидает подписи» for the other; one canon closes that split.
 * `AWAITING_SIGNATURE` covers the separate «invoice pending signature» chip
 * (COPY-M-docs-15) that reads `Document.invoicePendingSignature`, not the
 * `StatusBadge` discriminated union.
 */
export type DocumentStatusMessageKey =
  | 'DRAFT'
  | 'READY_TO_SIGN'
  | 'SIGNED'
  | 'AWAITING_SIGNATURE'
  | 'ARCHIVED'

export const DOCUMENT_STATUS_MESSAGES = {
  DRAFT: msg`Чернетка`,
  READY_TO_SIGN: msg`Готовий до підпису`,
  SIGNED: msg`Підписано`,
  AWAITING_SIGNATURE: msg`Очікує підпису`,
  // A soft-deleted document lives in the «Архів» view (task-i18n-stage3e-pr2):
  // one word for the badge on card, row and detail dialog — the old copies said
  // «Удалён» (card/row) and «В корзине» (detail) for the same state.
  ARCHIVED: msg`В архіві`,
} satisfies Record<DocumentStatusMessageKey, MessageDescriptor>

// ---------------------------------------------------------------------------
// Delete-confirmation canon (COPY-H-docs-1, COPY-M-docs-9)
// ---------------------------------------------------------------------------

/**
 * `ARCHIVE_BODY` fixes COPY-H-docs-1 (the soft-delete confirmation promised
 * restoration to the wrong addressee — "you can restore it later" when only
 * an admin can). `PERMANENT_BODY` fixes COPY-M-docs-9 (naming the storage
 * backend — "…from S3 and the database" — on a user-facing confirm dialog).
 * `document-card.tsx`/`document-row.tsx`/`document-detail-dialog.tsx` (PR2)
 * all render these two bodies.
 */
export type DeleteConfirmMessageKey = 'ARCHIVE_BODY' | 'PERMANENT_BODY'

export const DELETE_CONFIRM_MESSAGES = {
  ARCHIVE_BODY: msg`Документ піде в архів. Повернути його може адмін`,
  PERMANENT_BODY: msg`Файл буде видалено без можливості відновлення`,
} satisfies Record<DeleteConfirmMessageKey, MessageDescriptor>

// ---------------------------------------------------------------------------
// «Delete is unavailable» canon (COPY-L-docs-20, task-i18n-stage3e-pr2)
// ---------------------------------------------------------------------------

/**
 * Receipts and invoices are deleted only together with their transaction.
 * The disabled trash button on `document-card.tsx` and `document-row.tsx`
 * used to say three different things (card: «…недоступно для чеков» /
 * «…для инвойсов», row: bare «Удалить (недоступно)» with NO reason) — one
 * sentence per category now serves BOTH as the tooltip and as the button's
 * accessible name, so a screen-reader user hears the same reason a sighted
 * user sees.
 */
export const DELETE_UNAVAILABLE_MESSAGES = {
  RECEIPT: msg`Видалити не можна: чек видаляється разом із транзакцією`,
  INVOICE: msg`Видалити не можна: рахунок видаляється разом із транзакцією`,
} satisfies Record<'RECEIPT' | 'INVOICE', MessageDescriptor>
