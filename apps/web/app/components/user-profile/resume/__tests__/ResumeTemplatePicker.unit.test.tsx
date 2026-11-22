/**
 * `ResumeTemplatePicker` on its own: which tile commits, which key only moves
 * focus, and how the current and disabled tiles read.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResumeTemplateName } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeTemplatePicker } from '../ResumeTemplatePicker'

beforeEach(() => loadCatalog('uk'))

function renderPicker(
  overrides: Partial<{ value: ResumeTemplateName | null; disabled: boolean }> = {},
) {
  const onChange = vi.fn()
  render(
    <>
      <ResumeTemplatePicker
        value="classic"
        disabled={false}
        busy={false}
        verified={false}
        onChange={onChange}
        {...overrides}
      />
      <button type="button">outside</button>
    </>,
    { wrapper: I18nTestProvider },
  )
  return { onChange, group: screen.getByRole('radiogroup', { name: 'Шаблон' }) }
}

const tile = (name: RegExp) => screen.getByRole('radio', { name })

describe('the tiles', () => {
  it('every template has its own description and test id', () => {
    renderPicker()
    const expected = {
      classic: 'Шрифт із засічками, ім’я по центру',
      modern: 'Без засічок, акцентна лінія під заголовками',
      compact: 'Щільний макет, менші відступи',
      technical: 'Зелений акцент, без ліній під заголовками',
    }
    for (const [name, desc] of Object.entries(expected)) {
      expect(within(screen.getByTestId(`resume-template-${name}`)).getByText(desc)).toBeVisible()
    }
  })

  it('only the current tile is highlighted', () => {
    renderPicker({ value: 'modern' })
    expect(tile(/Сучасний/)).toHaveClass('border-primary', 'ring-primary')
    expect(tile(/Класичний/)).not.toHaveClass('border-primary')
    expect(tile(/Класичний/)).not.toHaveClass('ring-primary')
  })

  it('a catalog template shows no custom-template note and an enabled group', () => {
    const { group } = renderPicker()
    expect(screen.queryByTestId('resume-template-custom-note')).toBeNull()
    expect(group).not.toHaveAttribute('aria-disabled')
    expect(tile(/Сучасний/)).not.toHaveAttribute('aria-disabled')
  })

  it('a disabled picker marks the group and tiles and dims them', () => {
    const { group } = renderPicker({ disabled: true })
    expect(group).toHaveAttribute('aria-disabled', 'true')
    expect(tile(/Сучасний/)).toHaveAttribute('aria-disabled', 'true')
    expect(tile(/Сучасний/)).toHaveClass('aria-disabled:opacity-50')
  })
})

describe('what commits', () => {
  it('Enter on the current tile sends nothing', () => {
    const { onChange } = renderPicker()
    fireEvent.keyDown(tile(/Класичний/), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Enter on another tile of a disabled picker sends nothing', () => {
    const { onChange } = renderPicker({ disabled: true })
    fireEvent.keyDown(tile(/Сучасний/), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Enter on another tile commits it', () => {
    const { onChange } = renderPicker()
    fireEvent.keyDown(tile(/Сучасний/), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('modern')
  })

  it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])(
    '%s only moves focus, it commits nothing',
    async (key) => {
      const { onChange } = renderPicker({ value: 'modern' })
      const modern = tile(/Сучасний/)
      modern.focus()
      // Held down, as in a browser: Radix checks the tile it lands on only while the arrow is down.
      await userEvent.keyboard(`{${key}>}`)
      expect(modern).not.toHaveFocus()
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  // fireEvent.click, not userEvent: userEvent's pointer sequence resets the arrow flag itself,
  // which would hide whether key-up or focus-out did.
  it('a click after an arrow key was released commits', () => {
    const { onChange, group } = renderPicker()
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    fireEvent.keyUp(group, { key: 'ArrowRight' })
    fireEvent.click(tile(/Стислий/))
    expect(onChange).toHaveBeenCalledWith('compact')
  })

  it('a click after focus left the picker mid-arrow commits', () => {
    const { onChange, group } = renderPicker()
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    fireEvent.focusOut(tile(/Класичний/), {
      relatedTarget: screen.getByRole('button', { name: 'outside' }),
    })
    fireEvent.click(tile(/Технічний/))
    expect(onChange).toHaveBeenCalledWith('technical')
  })
})
