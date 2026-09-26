/**
 * task-i18n-3c-pr1 (Step 2) — the kanban column header reads its stage
 * label from `STAGE_LABEL_MESSAGES` (the `msg`-descriptor map `constants.ts`
 * moves to) against the ACTIVE catalog, not a hardcoded English/Russian
 * literal. `it.each` covers one `uk` and one `en` case per the plan's Step
 * 2 pseudo-code, plus asserts the rendered text never contains a raw stage
 * enum or the legacy English column label — the exact regression `constants.ts`'s
 * old `STAGE_LABELS` (half English literals, half Russian) would reintroduce.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { KanbanColumn } from '../KanbanColumn'

const RAW_STAGE = /HR_SCREEN|TECH_INTERVIEW|OFFER_RECEIVED|HR Screen|\bTech\b|\bOffer\b|Нанят/

describe('KanbanColumn — stage label from the catalog (COPY-H-proj-1)', () => {
  it.each([
    ['uk', 'HR_SCREEN', 'HR-скринінг'],
    ['uk', 'HIRED', 'Найнято'],
    ['en', 'TECH_INTERVIEW', 'Technical'],
  ] as const)(
    '%s: stage %s reads %s, no raw enum or legacy literal',
    async (locale, stage, label) => {
      await loadCatalog(locale)
      const { container } = render(
        <KanbanColumn stage={stage} interviews={[]} onCardClick={() => {}} />,
        { wrapper: I18nTestProvider },
      )
      expect(screen.getByText(label)).toBeInTheDocument()
      expect(container.textContent ?? '').not.toMatch(RAW_STAGE)
    },
  )
})
