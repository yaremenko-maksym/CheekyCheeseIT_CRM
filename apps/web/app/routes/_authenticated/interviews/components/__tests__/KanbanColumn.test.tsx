/**
 * task-i18n-3c-pr1 (Step 2) — the kanban column header reads its stage
 * label from `STAGE_LABEL_MESSAGES` (the `msg`-descriptor map `constants.ts`
 * moves to) against the ACTIVE catalog, not a hardcoded English/Russian
 * literal. `it.each` covers ALL NINE stages on `uk` — the mutation gate
 * (`pnpm mutation:changed`) turned every stage NOT covered here into a
 * `Survived` StringLiteral mutant (`msg\`Фінальна\`` → `msg\`\``, etc. —
 * with only 3/9 stages under test the first local run left exactly the
 * other 6 survived), so every entry of the map needs its own assertion, not
 * a representative sample. One `en` case (`TECH_INTERVIEW`) additionally
 * proves the second-language catalog resolves through the same map. Also
 * asserts the rendered text never contains a raw stage enum or the legacy
 * English/Russian column label — the exact regression `constants.ts`'s old
 * `STAGE_LABELS` (half English literals, half Russian) would reintroduce.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { KanbanColumn } from '../KanbanColumn'

const RAW_STAGE =
  /HR_SCREEN|TECH_INTERVIEW|OFFER_RECEIVED|HR Screen|\bTech\b|\bOffer\b|\bFinal\b|\bClient\b|\bEnglish\b|Нанят|Отказ|Архив\b/

describe('KanbanColumn — stage label from the catalog (COPY-H-proj-1)', () => {
  it.each([
    ['uk', 'HR_SCREEN', 'HR-скринінг'],
    ['uk', 'ENGLISH_CHECK', 'Англійська'],
    ['uk', 'TECH_INTERVIEW', 'Технічна'],
    ['uk', 'FINAL_INTERVIEW', 'Фінальна'],
    ['uk', 'CLIENT_INTERVIEW', 'З клієнтом'],
    ['uk', 'OFFER_RECEIVED', 'Оффер'],
    ['uk', 'HIRED', 'Найнято'],
    ['uk', 'REJECTED', 'Відмова'],
    ['uk', 'ARCHIVED', 'Архів'],
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
