/**
 * Pins the drawer animation config of ComplianceReceiverRow. Real framer-motion
 * never exposes its props in the DOM under happy-dom, so the motion element is
 * replaced by a recorder (props only — the row's behaviour is covered in
 * components.test.tsx).
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeAll(async () => {
  await loadCatalog('uk')
})

const motionProps = vi.fn()
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
      motionProps(props)
      return <div data-testid="motion-div">{children}</div>
    },
  },
}))
vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }))
vi.mock('../../finance/api', () => ({
  financeApi: { getIncomeCompliance: vi.fn() },
}))

import { ComplianceReceiverRow } from '../components/IncomeComplianceSection'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

describe('ComplianceReceiverRow drawer animation', () => {
  it('slides height/opacity open and closed over 220ms', () => {
    render(
      <ComplianceReceiverRow
        receiver={{
          userId: 'r1',
          displayName: 'Ivan Petrov',
          role: 'SENIOR',
          expected: 2,
          submitted: 0,
          pendingCount: 0,
          accruedCount: 0,
          missingProjects: [
            {
              projectId: 'p1',
              name: 'Proj',
              companyName: 'Co',
              submitted: false,
              pendingValidation: false,
              accrued: false,
            },
          ],
        }}
      />,
    )
    expect(screen.queryByTestId('motion-div')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('compliance-toggle-r1'))
    expect(screen.getByTestId('motion-div')).toBeInTheDocument()
    expect(motionProps).toHaveBeenLastCalledWith({
      initial: { height: 0, opacity: 0 },
      animate: { height: 'auto', opacity: 1 },
      exit: { height: 0, opacity: 0 },
      transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] },
      className: 'overflow-hidden',
    })
  })
})
