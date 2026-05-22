import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Coins, Landmark } from 'lucide-react'
import { SegmentedToggle } from '../segmented-toggle'

type Method = 'USDT_ERC20' | 'BANK_UAH_FOP'

const OPTIONS = [
  { value: 'USDT_ERC20' as const, label: 'USDT ERC-20', icon: Coins },
  { value: 'BANK_UAH_FOP' as const, label: 'Bank UAH (ФОП)', icon: Landmark },
]

function Controlled({
  initial = 'USDT_ERC20' as Method,
  onChange,
  disabled = false,
}: {
  initial?: Method
  onChange?: (v: Method) => void
  disabled?: boolean
}) {
  const [value, setValue] = React.useState<Method>(initial)
  return (
    <SegmentedToggle
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
      options={OPTIONS}
      ariaLabel="Способ оплаты"
      layoutId="test-pill"
      testId="payment-method"
      disabled={disabled}
    />
  )
}

describe('SegmentedToggle', () => {
  it('renders as ARIA radiogroup with provided label', () => {
    render(<Controlled />)
    const group = screen.getByRole('radiogroup', { name: 'Способ оплаты' })
    expect(group).toBeInTheDocument()
  })

  it('renders one radio per option with correct aria-checked', () => {
    render(<Controlled initial="USDT_ERC20" />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
    expect(radios[1]).toHaveAttribute('aria-checked', 'false')
  })

  it('emits onChange when an inactive option is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    await user.click(screen.getByTestId('payment-method-BANK_UAH_FOP'))
    expect(onChange).toHaveBeenCalledWith('BANK_UAH_FOP')
  })

  it('does NOT emit onChange when the active option is clicked again', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    await user.click(screen.getByTestId('payment-method-USDT_ERC20'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves aria-checked when selection changes', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Controlled />)
    await user.click(screen.getByTestId('payment-method-BANK_UAH_FOP'))
    const radios = screen.getAllByRole('radio')
    expect(radios[0]).toHaveAttribute('aria-checked', 'false')
    expect(radios[1]).toHaveAttribute('aria-checked', 'true')
  })

  it('respects the disabled prop on the container — clicks are no-ops', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled disabled onChange={onChange} />)
    await user.click(screen.getByTestId('payment-method-BANK_UAH_FOP'))
    expect(onChange).not.toHaveBeenCalled()
    const radios = screen.getAllByRole('radio')
    for (const r of radios) {
      expect(r).toBeDisabled()
    }
  })

  it('applies per-button data-testid using value as default suffix', () => {
    render(<Controlled />)
    expect(screen.getByTestId('payment-method-USDT_ERC20')).toBeInTheDocument()
    expect(screen.getByTestId('payment-method-BANK_UAH_FOP')).toBeInTheDocument()
  })

  it('uses testIdSuffix override when provided', () => {
    function ControlledWithSuffix() {
      const [v, setV] = React.useState<'a' | 'b'>('a')
      return (
        <SegmentedToggle
          value={v}
          onChange={setV}
          options={[
            { value: 'a', label: 'A', testIdSuffix: 'first' },
            { value: 'b', label: 'B', testIdSuffix: 'second' },
          ]}
          ariaLabel="Letters"
          testId="letters"
        />
      )
    }
    render(<ControlledWithSuffix />)
    expect(screen.getByTestId('letters-first')).toBeInTheDocument()
    expect(screen.getByTestId('letters-second')).toBeInTheDocument()
  })

  it('uses option.ariaLabel to override the accessible name (icon-only)', () => {
    function IconOnly() {
      const [v, setV] = React.useState<'asc' | 'desc'>('asc')
      return (
        <SegmentedToggle
          value={v}
          onChange={setV}
          options={[
            { value: 'asc', label: '', ariaLabel: 'По возрастанию' },
            { value: 'desc', label: '', ariaLabel: 'По убыванию' },
          ]}
          ariaLabel="Сортировка"
          testId="sort-dir"
        />
      )
    }
    render(<IconOnly />)
    // Screen-reader name comes from ariaLabel, NOT the enum value.
    expect(screen.getByRole('radio', { name: 'По возрастанию' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'По убыванию' })).toBeInTheDocument()
    // Defensive: enum value must not leak into accessible name.
    expect(screen.queryByRole('radio', { name: 'asc' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'desc' })).not.toBeInTheDocument()
  })

  it('disables a single option via option.disabled without disabling the rest', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    function ControlledPartial() {
      const [v, setV] = React.useState<'a' | 'b'>('a')
      return (
        <SegmentedToggle
          value={v}
          onChange={(nv) => {
            setV(nv)
            onChange(nv)
          }}
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', disabled: true },
          ]}
          ariaLabel="Letters"
          testId="letters"
        />
      )
    }
    render(<ControlledPartial />)
    await user.click(screen.getByTestId('letters-b'))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('letters-b')).toBeDisabled()
    expect(screen.getByTestId('letters-a')).not.toBeDisabled()
  })

  it('Enter key activates an inactive option via native button semantics', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    const second = screen.getByTestId('payment-method-BANK_UAH_FOP')
    second.focus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('BANK_UAH_FOP')
  })

  it('Space key activates an inactive option via native button semantics', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    const second = screen.getByTestId('payment-method-BANK_UAH_FOP')
    second.focus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledWith('BANK_UAH_FOP')
  })

  it('supports a 3-option layout (sm size)', () => {
    function ThreeOptions() {
      const [v, setV] = React.useState<'l' | 'c' | 'r'>('c')
      return (
        <SegmentedToggle
          value={v}
          onChange={setV}
          options={[
            { value: 'l', label: 'Left' },
            { value: 'c', label: 'Center' },
            { value: 'r', label: 'Right' },
          ]}
          ariaLabel="Alignment"
          testId="align"
          size="sm"
        />
      )
    }
    render(<ThreeOptions />)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByTestId('align-c')).toHaveAttribute('aria-checked', 'true')
  })

  // ut-33: tabs variant — page-level segmented control. Container is a real
  // ARIA tablist, items expose role="tab" + aria-selected, and the active
  // pill uses the more saturated primary tint so it reads as a focal page
  // control instead of an inline helper.
  describe('variant="tabs"', () => {
    function TabsLayout({ initial = 'ALL' as 'ALL' | 'ACTIVE' }: { initial?: 'ALL' | 'ACTIVE' }) {
      const [v, setV] = React.useState(initial)
      return (
        <SegmentedToggle
          value={v}
          onChange={setV}
          options={[
            { value: 'ALL', label: 'Все' },
            { value: 'ACTIVE', label: 'Активные' },
          ]}
          ariaLabel="Фильтр"
          variant="tabs"
          testId="status-tabs"
        />
      )
    }

    it('renders as ARIA tablist + role="tab" items with aria-selected', () => {
      render(<TabsLayout />)
      expect(screen.getByRole('tablist', { name: 'Фильтр' })).toBeInTheDocument()
      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(2)
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
      // Never expose radio semantics when we're using tabs.
      expect(screen.queryAllByRole('radio')).toHaveLength(0)
    })

    it('moves aria-selected when a different tab is clicked', async () => {
      const user = userEvent.setup({ delay: null })
      render(<TabsLayout />)
      await user.click(screen.getByTestId('status-tabs-ACTIVE'))
      const tabs = screen.getAllByRole('tab')
      expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    })

    it('uses the more saturated primary/25 pill (vs pill variant primary/15)', () => {
      const { rerender } = render(<TabsLayout />)
      // Active pill is rendered inside the active button as the first child
      // motion.div. We assert via class names since framer's layout id is
      // an implementation detail.
      const activeButton = screen.getByTestId('status-tabs-ALL')
      const tabsPill = activeButton.querySelector('[class*="bg-primary/25"]')
      expect(tabsPill).not.toBeNull()

      // Swap to the default variant and confirm the active pill uses the
      // subtler primary/15 surface instead.
      function PillLayout() {
        const [v, setV] = React.useState<'ALL' | 'ACTIVE'>('ALL')
        return (
          <SegmentedToggle
            value={v}
            onChange={setV}
            options={[
              { value: 'ALL', label: 'Все' },
              { value: 'ACTIVE', label: 'Активные' },
            ]}
            ariaLabel="Фильтр"
            testId="status-pill"
          />
        )
      }
      rerender(<PillLayout />)
      const pillActive = screen.getByTestId('status-pill-ALL')
      expect(pillActive.querySelector('[class*="bg-primary/15"]')).not.toBeNull()
      expect(pillActive.querySelector('[class*="bg-primary/25"]')).toBeNull()
    })
  })

  // ut-33: per-option `testId` override — for E2E selectors that predate
  // SegmentedToggle adoption (e.g. legacy `toggle-archived-projects`).
  it('honors per-option testId override independently of the container testId', () => {
    function WithOverride() {
      const [v, setV] = React.useState<'a' | 'b'>('a')
      return (
        <SegmentedToggle
          value={v}
          onChange={setV}
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', testId: 'legacy-selector' },
          ]}
          ariaLabel="Letters"
          testId="container-id"
        />
      )
    }
    render(<WithOverride />)
    // Option without override uses the container-derived id.
    expect(screen.getByTestId('container-id-a')).toBeInTheDocument()
    // Option with override uses its own id verbatim.
    expect(screen.getByTestId('legacy-selector')).toBeInTheDocument()
    // And does NOT also generate the prefixed id.
    expect(screen.queryByTestId('container-id-b')).not.toBeInTheDocument()
  })
})
