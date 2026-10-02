/**
 * document-labels.test.tsx — task-i18n-stage3e-pr1, AC2. Pins every entry of
 * the hub's four maps on BOTH locales, resolved through the REAL compiled
 * catalog (`loadCatalog`/`i18n._`, same pattern as `routes/_authenticated/
 * finance/__tests__/constants.i18n.test.ts`) — not read as a plain object
 * property, so a mutated/emptied `msg` template (StringLiteral mutant) is
 * caught rather than silently passing. `satisfies` (no `as const`) keeps
 * every literal visible to Stryker (lesson #707) — this file is what makes
 * that visibility pay off: every key gets its own assertion.
 */
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import type { DocumentCategory } from '@crm/shared'
import { loadCatalog } from '@/test/i18n'
import {
  CATEGORY_LABEL_MESSAGES,
  CATEGORY_LABEL_MESSAGES_LOWER,
  DOCUMENT_STATUS_MESSAGES,
  DELETE_CONFIRM_MESSAGES,
  DELETE_UNAVAILABLE_MESSAGES,
  type DocumentStatusMessageKey,
  type DeleteConfirmMessageKey,
} from '../document-labels'

const CATEGORY_EXPECTED: Record<DocumentCategory, [uk: string, en: string]> = {
  // en "Resume" (no accent) — dedup with the already-established catalog
  // entry from `UserProfileShell.tsx` (same uk source text "Резюме" shares
  // ONE msgid across every consumer); the wave (e) plan's draft canon
  // ("Résumé") is overridden by what the catalog already says everywhere
  // else, recorded as such in CONTEXT.md.
  RESUME: ['Резюме', 'Resume'],
  SCAN: ['Скан', 'Scan'],
  CONTRACT: ['Договір', 'Contract'],
  RECEIPT: ['Чек', 'Receipt'],
  AVATAR: ['Аватар', 'Avatar'],
  LOGO: ['Логотип', 'Logo'],
  INVOICE: ['Рахунок', 'Invoice'],
}

const CATEGORY_LOWER_EXPECTED: Record<DocumentCategory, [uk: string, en: string]> = {
  RESUME: ['резюме', 'resume'],
  SCAN: ['скан', 'scan'],
  CONTRACT: ['договір', 'contract'],
  RECEIPT: ['чек', 'receipt'],
  AVATAR: ['аватар', 'avatar'],
  LOGO: ['логотип', 'logo'],
  INVOICE: ['рахунок', 'invoice'],
}

const STATUS_EXPECTED: Record<DocumentStatusMessageKey, [uk: string, en: string]> = {
  DRAFT: ['Чернетка', 'Draft'],
  READY_TO_SIGN: ['Готовий до підпису', 'Ready to sign'],
  SIGNED: ['Підписано', 'Signed'],
  AWAITING_SIGNATURE: ['Очікує підпису', 'Awaiting signature'],
  ARCHIVED: ['В архіві', 'Archived'],
}

const DELETE_CONFIRM_EXPECTED: Record<DeleteConfirmMessageKey, [uk: string, en: string]> = {
  ARCHIVE_BODY: [
    'Документ піде в архів. Повернути його може адмін',
    'The document goes to the archive. An admin can restore it',
  ],
  PERMANENT_BODY: [
    'Файл буде видалено без можливості відновлення',
    'The file will be deleted permanently',
  ],
}

const RAW_ENUM_RE = /\b(RESUME|SCAN|CONTRACT|RECEIPT|AVATAR|LOGO|INVOICE)\b/

describe('CATEGORY_LABEL_MESSAGES — every DocumentCategory, uk + en, no raw enum', () => {
  it('uk', async () => {
    await loadCatalog('uk')
    for (const [cat, [uk]] of Object.entries(CATEGORY_EXPECTED) as [
      DocumentCategory,
      [string, string],
    ][]) {
      const resolved = i18n._(CATEGORY_LABEL_MESSAGES[cat])
      expect(resolved).toBe(uk)
      expect(resolved).not.toMatch(RAW_ENUM_RE)
    }
  })

  it('en', async () => {
    await loadCatalog('en')
    for (const [cat, [, en]] of Object.entries(CATEGORY_EXPECTED) as [
      DocumentCategory,
      [string, string],
    ][]) {
      const resolved = i18n._(CATEGORY_LABEL_MESSAGES[cat])
      expect(resolved).toBe(en)
      expect(resolved).not.toMatch(RAW_ENUM_RE)
    }
  })

  it('INVOICE reads «Рахунок»/"Invoice", never «Інвойс» (COPY-H-docs-5)', async () => {
    await loadCatalog('uk')
    expect(i18n._(CATEGORY_LABEL_MESSAGES.INVOICE)).toBe('Рахунок')
    expect(i18n._(CATEGORY_LABEL_MESSAGES.INVOICE)).not.toMatch(/Інвойс/i)
  })
})

describe('CATEGORY_LABEL_MESSAGES_LOWER — every DocumentCategory, uk + en', () => {
  it('uk', async () => {
    await loadCatalog('uk')
    for (const [cat, [uk]] of Object.entries(CATEGORY_LOWER_EXPECTED) as [
      DocumentCategory,
      [string, string],
    ][]) {
      expect(i18n._(CATEGORY_LABEL_MESSAGES_LOWER[cat])).toBe(uk)
    }
  })

  it('en', async () => {
    await loadCatalog('en')
    for (const [cat, [, en]] of Object.entries(CATEGORY_LOWER_EXPECTED) as [
      DocumentCategory,
      [string, string],
    ][]) {
      expect(i18n._(CATEGORY_LABEL_MESSAGES_LOWER[cat])).toBe(en)
    }
  })

  it('is never derived by .toLowerCase() on CATEGORY_LABEL_MESSAGES — every entry differs in source, not just casing rules', async () => {
    await loadCatalog('uk')
    for (const cat of Object.keys(CATEGORY_LABEL_MESSAGES) as DocumentCategory[]) {
      const upper = i18n._(CATEGORY_LABEL_MESSAGES[cat])
      const lower = i18n._(CATEGORY_LABEL_MESSAGES_LOWER[cat])
      expect(lower).toBe(upper.toLowerCase())
    }
  })
})

describe('DOCUMENT_STATUS_MESSAGES — every status key, uk + en, no raw enum', () => {
  it('uk', async () => {
    await loadCatalog('uk')
    for (const [key, [uk]] of Object.entries(STATUS_EXPECTED) as [
      DocumentStatusMessageKey,
      [string, string],
    ][]) {
      const resolved = i18n._(DOCUMENT_STATUS_MESSAGES[key])
      expect(resolved).toBe(uk)
      expect(resolved).not.toBe(key)
    }
  })

  it('en', async () => {
    await loadCatalog('en')
    for (const [key, [, en]] of Object.entries(STATUS_EXPECTED) as [
      DocumentStatusMessageKey,
      [string, string],
    ][]) {
      const resolved = i18n._(DOCUMENT_STATUS_MESSAGES[key])
      expect(resolved).toBe(en)
      expect(resolved).not.toBe(key)
    }
  })
})

describe('DELETE_CONFIRM_MESSAGES — archive + permanent, uk + en', () => {
  it('uk', async () => {
    await loadCatalog('uk')
    for (const [key, [uk]] of Object.entries(DELETE_CONFIRM_EXPECTED) as [
      DeleteConfirmMessageKey,
      [string, string],
    ][]) {
      expect(i18n._(DELETE_CONFIRM_MESSAGES[key])).toBe(uk)
    }
  })

  it('en', async () => {
    await loadCatalog('en')
    for (const [key, [, en]] of Object.entries(DELETE_CONFIRM_EXPECTED) as [
      DeleteConfirmMessageKey,
      [string, string],
    ][]) {
      expect(i18n._(DELETE_CONFIRM_MESSAGES[key])).toBe(en)
    }
  })

  it('ARCHIVE_BODY never says "S3"/"database" and PERMANENT_BODY never says "S3" (COPY-M-docs-9)', async () => {
    await loadCatalog('uk')
    const archiveText = i18n._(DELETE_CONFIRM_MESSAGES.ARCHIVE_BODY)
    const permanentText = i18n._(DELETE_CONFIRM_MESSAGES.PERMANENT_BODY)
    expect(archiveText).not.toMatch(/S3|бази даних/i)
    expect(permanentText).not.toMatch(/S3|бази даних/i)
  })
})

describe('DELETE_UNAVAILABLE_MESSAGES — receipt + invoice, uk + en, reason included', () => {
  const EXPECTED = {
    RECEIPT: [
      'Видалити не можна: чек видаляється разом із транзакцією',
      'Can’t delete: a receipt is deleted together with its transaction',
    ],
    INVOICE: [
      'Видалити не можна: рахунок видаляється разом із транзакцією',
      'Can’t delete: an invoice is deleted together with its transaction',
    ],
  } as const

  it('uk', async () => {
    await loadCatalog('uk')
    expect(i18n._(DELETE_UNAVAILABLE_MESSAGES.RECEIPT)).toBe(EXPECTED.RECEIPT[0])
    expect(i18n._(DELETE_UNAVAILABLE_MESSAGES.INVOICE)).toBe(EXPECTED.INVOICE[0])
  })

  it('en', async () => {
    await loadCatalog('en')
    expect(i18n._(DELETE_UNAVAILABLE_MESSAGES.RECEIPT)).toBe(EXPECTED.RECEIPT[1])
    expect(i18n._(DELETE_UNAVAILABLE_MESSAGES.INVOICE)).toBe(EXPECTED.INVOICE[1])
  })
})
