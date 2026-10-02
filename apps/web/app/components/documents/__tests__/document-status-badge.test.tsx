/**
 * DocumentStatusBadge — unit tests (Task 4 — PR-2; i18n wave (e) PR2).
 *
 * Every {kind, state} combination maps to the right label on BOTH locales
 * (resolved through the real compiled catalog), the right tone class, and
 * the data-badge-* attributes. The labels are asserted against independent
 * literals — `READY_TO_SIGN` must read «Готовий до підпису» for a contract
 * (COPY-H-docs-4 one canon) and the invoice's «ready» state reads
 * «Очікує підпису», never the contract wording.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { StatusBadge } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { DocumentStatusBadge } from '../document-status-badge'

beforeEach(async () => {
  await loadCatalog('uk')
})

function renderBadge(badge: StatusBadge) {
  return render(<DocumentStatusBadge badge={badge} />, { wrapper: I18nTestProvider })
}

// [badge, uk label, en label, tone class]
const CASES: Array<[StatusBadge, string, string, RegExp]> = [
  [{ kind: 'contract', state: 'draft' }, 'Чернетка', 'Draft', /muted-foreground/],
  [{ kind: 'contract', state: 'ready' }, 'Готовий до підпису', 'Ready to sign', /amber/],
  [{ kind: 'contract', state: 'signed' }, 'Підписано', 'Signed', /emerald/],
  [{ kind: 'invoice', state: 'ready' }, 'Очікує підпису', 'Awaiting signature', /amber/],
  [{ kind: 'invoice', state: 'signed' }, 'Підписано', 'Signed', /emerald/],
  [{ kind: 'receipt', state: 'pending' }, 'Очікує підтвердження', 'Awaiting validation', /amber/],
  [{ kind: 'receipt', state: 'validated' }, 'Підтверджено', 'Validated', /emerald/],
]

describe('DocumentStatusBadge — label + tone per {kind, state}', () => {
  for (const [badge, uk, , tone] of CASES) {
    it(`uk: ${badge.kind}/${badge.state} → «${uk}»`, () => {
      renderBadge(badge)
      const el = screen.getByTestId('document-status-badge')
      expect(el).toHaveTextContent(new RegExp(`^${uk}$`))
      expect(el.className).toMatch(tone)
      expect(el).toHaveAttribute('data-badge-kind', badge.kind)
      expect(el).toHaveAttribute('data-badge-state', badge.state)
    })
  }

  for (const [badge, , en] of CASES) {
    it(`en: ${badge.kind}/${badge.state} → «${en}»`, async () => {
      await loadCatalog('en')
      renderBadge(badge)
      expect(screen.getByTestId('document-status-badge')).toHaveTextContent(new RegExp(`^${en}$`))
    })
  }

  it('never shows a raw enum value or the legacy transliteration «Драфт»', () => {
    for (const [badge] of CASES) {
      const { unmount } = renderBadge(badge)
      const text = screen.getByTestId('document-status-badge').textContent ?? ''
      expect(text).not.toMatch(/draft|ready|signed|pending|validated|Драфт/i)
      unmount()
    }
  })
})

describe('DocumentStatusBadge — className passthrough', () => {
  it('appends the caller className after the tone classes', () => {
    render(<DocumentStatusBadge badge={{ kind: 'invoice', state: 'signed' }} className="w-fit" />, {
      wrapper: I18nTestProvider,
    })
    const el = screen.getByTestId('document-status-badge')
    expect(el.className).toMatch(/emerald.* w-fit$/)
  })
})
