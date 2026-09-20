import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
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

  // PR #696 fix-round 1 (CR-M-2, via UX-H-1): ARIA APG roving-tabindex —
  // one tab stop on the active radio, Arrow/Home/End moves BOTH focus and
  // selection between options in a single keystroke.
  describe('roving tabindex + arrow/home/end (radio pairing only)', () => {
    it('gives the active option tabIndex=0 and the rest tabIndex=-1', () => {
      render(<Controlled initial="USDT_ERC20" />)
      expect(screen.getByTestId('payment-method-USDT_ERC20')).toHaveAttribute('tabIndex', '0')
      expect(screen.getByTestId('payment-method-BANK_UAH_FOP')).toHaveAttribute('tabIndex', '-1')
    })

    it('ArrowRight moves selection AND focus to the next option', async () => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn()
      render(<Controlled onChange={onChange} />)
      screen.getByTestId('payment-method-USDT_ERC20').focus()
      await user.keyboard('{ArrowRight}')
      expect(onChange).toHaveBeenCalledWith('BANK_UAH_FOP')
      expect(screen.getByTestId('payment-method-BANK_UAH_FOP')).toHaveFocus()
    })

    it('ArrowLeft/ArrowUp/ArrowDown wrap around at the ends', async () => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn()
      render(<Controlled initial="USDT_ERC20" onChange={onChange} />)
      screen.getByTestId('payment-method-USDT_ERC20').focus()
      // Only two options — ArrowLeft from the first wraps to the last.
      await user.keyboard('{ArrowLeft}')
      expect(onChange).toHaveBeenLastCalledWith('BANK_UAH_FOP')
      expect(screen.getByTestId('payment-method-BANK_UAH_FOP')).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(onChange).toHaveBeenLastCalledWith('USDT_ERC20')
      expect(screen.getByTestId('payment-method-USDT_ERC20')).toHaveFocus()
    })

    it('Home/End jump to the first/last option', async () => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn()
      render(<Controlled initial="BANK_UAH_FOP" onChange={onChange} />)
      screen.getByTestId('payment-method-BANK_UAH_FOP').focus()
      await user.keyboard('{Home}')
      expect(onChange).toHaveBeenLastCalledWith('USDT_ERC20')
      expect(screen.getByTestId('payment-method-USDT_ERC20')).toHaveFocus()
      await user.keyboard('{End}')
      expect(onChange).toHaveBeenLastCalledWith('BANK_UAH_FOP')
      expect(screen.getByTestId('payment-method-BANK_UAH_FOP')).toHaveFocus()
    })

    it('does nothing when the whole toggle is disabled', async () => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn()
      render(<Controlled disabled onChange={onChange} />)
      screen.getByTestId('payment-method-USDT_ERC20').focus()
      await user.keyboard('{ArrowRight}')
      expect(onChange).not.toHaveBeenCalled()
    })

    // Three options, controlled, with per-option `disabled` support —
    // needed to distinguish arrow direction (two options wrap identically
    // either way) and to exercise the disabled-option skip/edge-case paths
    // below (PR #696 fix-round 1, mutation-gate findings on `enabledOptions`
    // filtering, the `currentIndex === -1` fallback, and the ArrowUp case).
    type Letter = 'a' | 'b' | 'c'
    function ThreeLetters({
      initial = 'a' as Letter,
      onChange,
      disabledValues = [],
    }: {
      initial?: Letter
      onChange?: (v: Letter) => void
      disabledValues?: Letter[]
    }) {
      const [v, setV] = React.useState<Letter>(initial)
      return (
        <SegmentedToggle
          value={v}
          onChange={(nv) => {
            setV(nv)
            onChange?.(nv)
          }}
          options={[
            { value: 'a', label: 'A', disabled: disabledValues.includes('a') },
            { value: 'b', label: 'B', disabled: disabledValues.includes('b') },
            { value: 'c', label: 'C', disabled: disabledValues.includes('c') },
          ]}
          ariaLabel="Letters"
          testId="letters3"
        />
      )
    }

    it('ArrowLeft/ArrowUp move to the PREVIOUS option, not the next (arithmetic direction)', async () => {
      const user = userEvent.setup({ delay: null })
      const onChangeLeft = vi.fn()
      const { unmount } = render(<ThreeLetters initial="b" onChange={onChangeLeft} />)
      screen.getByTestId('letters3-b').focus()
      await user.keyboard('{ArrowLeft}')
      expect(onChangeLeft).toHaveBeenCalledWith('a')
      unmount()

      const onChangeUp = vi.fn()
      render(<ThreeLetters initial="b" onChange={onChangeUp} />)
      screen.getByTestId('letters3-b').focus()
      await user.keyboard('{ArrowUp}')
      expect(onChangeUp).toHaveBeenCalledWith('a')
      expect(screen.getByTestId('letters3-a')).toHaveFocus()
    })

    it('keyboard navigation skips a disabled option in the middle', async () => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn()
      render(<ThreeLetters initial="a" onChange={onChange} disabledValues={['b']} />)
      screen.getByTestId('letters3-a').focus()
      await user.keyboard('{ArrowRight}')
      expect(onChange).toHaveBeenCalledWith('c')
      expect(screen.getByTestId('letters3-c')).toHaveFocus()
    })

    it('falls back to the first enabled option when the currently active option is itself disabled', async () => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn()
      // Synthetic edge case: the active value's own option is disabled, so
      // it is excluded from `enabledOptions` and `currentIndex` is -1.
      render(<ThreeLetters initial="a" onChange={onChange} disabledValues={['a']} />)
      screen.getByTestId('letters3-b').focus()
      await user.keyboard('{ArrowRight}')
      // From the -1 fallback (treated as index 0 = 'b'), ArrowRight goes to 'c'.
      expect(onChange).toHaveBeenCalledWith('c')
    })

    it('does nothing and does not crash when every option is individually disabled', () => {
      const onChange = vi.fn()
      render(<ThreeLetters initial="a" onChange={onChange} disabledValues={['a', 'b', 'c']} />)
      // Every button is HTML-`disabled` here, so none of them is a valid
      // focus target (a disabled element cannot receive real focus) — fire
      // the keydown directly on the container, same node the handler is
      // actually attached to, instead of routing it through `.focus()`.
      const container = screen.getByTestId('letters3')
      expect(() => fireEvent.keyDown(container, { key: 'ArrowRight' })).not.toThrow()
      expect(onChange).not.toHaveBeenCalled()
    })

    it('does not call onChange when Arrow navigation lands back on the only enabled (already-active) option', async () => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn()
      render(<ThreeLetters initial="b" onChange={onChange} disabledValues={['a', 'c']} />)
      screen.getByTestId('letters3-b').focus()
      await user.keyboard('{ArrowRight}')
      expect(onChange).not.toHaveBeenCalled()
    })

    it('variant="tabs" is unaffected — every tab keeps its own tab stop, arrows do nothing', async () => {
      const user = userEvent.setup({ delay: null })
      function TabsLayout() {
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
            variant="tabs"
            testId="status-tabs"
          />
        )
      }
      render(<TabsLayout />)
      const tabs = screen.getAllByRole('tab')
      // Native per-button tabbing — tabIndex left undefined (browser default 0),
      // NOT the roving -1/0 pattern used for the radio pairing.
      for (const tab of tabs) {
        expect(tab).not.toHaveAttribute('tabindex')
      }
      screen.getByTestId('status-tabs-ALL').focus()
      await user.keyboard('{ArrowRight}')
      expect(screen.getByTestId('status-tabs-ALL')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('status-tabs-ACTIVE')).toHaveAttribute('aria-selected', 'false')
    })
  })

  // PR #696 fix-round 1 (CR-M-3/UX-M-1, via UX-H-1) — 44px touch target on
  // mobile only; desktop keeps the pre-existing height.
  it('size="md" buttons carry the mobile-only 44px touch target class', () => {
    render(<Controlled />)
    expect(screen.getByTestId('payment-method-USDT_ERC20').className).toContain('min-h-11')
    expect(screen.getByTestId('payment-method-USDT_ERC20').className).toContain('sm:min-h-0')
  })

  it('size="sm" buttons do NOT carry the 44px touch target class', () => {
    function ThreeOptionsSmall() {
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
          testId="align-sm"
          size="sm"
        />
      )
    }
    render(<ThreeOptionsSmall />)
    expect(screen.getByTestId('align-sm-c').className).not.toContain('min-h-11')
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

    it('renders the solid brand-yellow pill in both variants, with a stronger shadow for tabs', () => {
      // Owner request 2026-07-24: the active tab is the solid brand yellow
      // (`bg-primary`, same fill as Button/Badge default) in every variant —
      // no more translucent primary/15 vs primary/25 tint split. 'tabs'
      // keeps a slightly stronger shadow so page-level tabs still read as
      // more focal than the inline 'pill' default.
      const { rerender } = render(<TabsLayout />)
      const activeButton = screen.getByTestId('status-tabs-ALL')
      expect(activeButton.querySelector('[class*="bg-primary"]')).not.toBeNull()
      expect(activeButton.querySelector('[class*="shadow-md"]')).not.toBeNull()
      // Text/icon on the solid yellow pill must be the near-black
      // primary-foreground, not the theme foreground (contrast).
      expect(activeButton.className).toContain('text-primary-foreground')

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
      expect(pillActive.querySelector('[class*="bg-primary"]')).not.toBeNull()
      // Pill variant keeps the subtler shadow-sm — no shadow-md.
      expect(pillActive.querySelector('[class*="shadow-md"]')).toBeNull()
      expect(pillActive.className).toContain('text-primary-foreground')
    })
  })

  // task-crm-vacancies-ui (§3.2): per-option `activeVariant: 'destructive'` —
  // renders a red pill for just that option instead of the container's
  // normal gold pill, without affecting the other options' active color.
  describe('activeVariant="destructive"', () => {
    function StatusLayout({ initial = 'NEW' as 'NEW' | 'REJECTED' }) {
      const [v, setV] = React.useState(initial)
      return (
        <SegmentedToggle
          value={v}
          onChange={setV}
          options={[
            { value: 'NEW', label: 'Новый' },
            { value: 'REJECTED', label: 'Отклонено', activeVariant: 'destructive' },
          ]}
          ariaLabel="Статус"
          testId="app-status"
          size="sm"
        />
      )
    }

    it('renders a red pill (and theme foreground text, not primary-foreground) when the destructive option is active', () => {
      render(<StatusLayout initial="REJECTED" />)
      const activeButton = screen.getByTestId('app-status-REJECTED')
      expect(activeButton.querySelector('[class*="bg-destructive/20"]')).not.toBeNull()
      // Destructive stays red even though the default active pill went
      // solid brand-yellow (owner request 2026-07-24) — must NOT pick up
      // the yellow-pill text color.
      expect(activeButton.className).toContain('text-foreground')
      expect(activeButton.className).not.toContain('text-primary-foreground')
    })

    it('does not render the red pill when a non-destructive option is active — uses the solid yellow pill instead', () => {
      render(<StatusLayout initial="NEW" />)
      const activeButton = screen.getByTestId('app-status-NEW')
      expect(activeButton.querySelector('[class*="bg-destructive/20"]')).toBeNull()
      expect(activeButton.querySelector('[class*="bg-primary"]')).not.toBeNull()
      expect(activeButton.className).toContain('text-primary-foreground')
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
