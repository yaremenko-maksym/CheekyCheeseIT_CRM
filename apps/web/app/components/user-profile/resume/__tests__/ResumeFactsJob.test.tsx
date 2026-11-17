/**
 * `JobBlock` and its primitives on their own: every control is wired to its own
 * field path (id, error line, blur), patches only its own key, and the move /
 * remove buttons respect the block's position.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResumeFactsExperience } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { factsFieldId, focusFactsField } from '../ResumeCompletenessPanel'
import { FieldError, IconButton, JobBlock, type A11y } from '../ResumeFactsJob'

beforeAll(() => {
  // Radix Select needs these pointer APIs.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
})

beforeEach(() => loadCatalog('uk'))

const JOB: ResumeFactsExperience = {
  company: 'Acme',
  role: 'Lead',
  location: 'Kyiv',
  start: '2020-05',
  end: '2022-08',
  current: false,
  technologies: ['React', 'Go'],
  notes: ['Built X', 'Shipped Y'],
}

function renderJob(
  overrides: Partial<{
    job: Partial<ResumeFactsExperience>
    index: number
    count: number
    invalid: string[]
  }> = {},
) {
  const { index = 1, count = 3, invalid = [] } = overrides
  const onPatch = vi.fn()
  const onMove = vi.fn()
  const onRemove = vi.fn()
  const blurred: string[] = []
  const a11y: A11y = (field, extra) => {
    const bad = invalid.includes(field)
    const describedBy = [extra, bad ? `${factsFieldId(field)}-error` : undefined]
      .filter(Boolean)
      .join(' ')
    return {
      id: factsFieldId(field),
      'aria-invalid': bad ? true : undefined,
      'aria-describedby': describedBy || undefined,
      onBlur: () => blurred.push(field),
    }
  }
  render(
    <JobBlock
      job={{ ...JOB, ...overrides.job }}
      index={index}
      count={count}
      nowMonth="2026-10"
      a11y={a11y}
      fieldError={(field) => <p>error for {field}</p>}
      onPatch={onPatch}
      onMove={onMove}
      onRemove={onRemove}
    />,
    { wrapper: I18nTestProvider },
  )
  return { onPatch, onMove, onRemove, blurred }
}

const user = () => userEvent.setup()

describe('the header', () => {
  it('names the block and wires the move and remove buttons to its position', async () => {
    const { onMove, onRemove } = renderJob()
    expect(screen.getByTestId('resume-facts-job-1')).toHaveTextContent('Місце роботи 2')
    const up = screen.getByRole('button', { name: 'Перемістити місце роботи 2 вгору' })
    const down = screen.getByRole('button', { name: 'Перемістити місце роботи 2 вниз' })
    const remove = screen.getByRole('button', { name: 'Видалити місце роботи 2' })
    expect(up).toBeEnabled()
    expect(down).toBeEnabled()
    await user().click(up)
    expect(onMove).toHaveBeenLastCalledWith(0)
    await user().click(down)
    expect(onMove).toHaveBeenLastCalledWith(2)
    await user().click(remove)
    expect(onRemove).toHaveBeenCalledTimes(1)
    // Only the remove button reads as destructive.
    expect(remove).toHaveClass('text-destructive')
    expect(up).not.toHaveClass('text-destructive')
    expect(down).not.toHaveClass('text-destructive')
  })

  it('the first block cannot move up, the last cannot move down', () => {
    renderJob({ index: 0, count: 1 })
    expect(screen.getByRole('button', { name: 'Перемістити місце роботи 1 вгору' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Перемістити місце роботи 1 вниз' })).toBeDisabled()
  })

  it('a middle block of two can still move down only when it is not last', () => {
    renderJob({ index: 0, count: 2 })
    expect(screen.getByRole('button', { name: 'Перемістити місце роботи 1 вниз' })).toBeEnabled()
  })
})

describe('the text fields', () => {
  it.each([
    ['Компанія', 'company', 'Компанія, місце роботи 2', 'Acme', 'Beta', { company: 'Beta' }],
    ['Посада', 'role', 'Посада, місце роботи 2', 'Lead', 'CTO', { role: 'CTO' }],
    [
      'Локація (необов’язково)',
      'location',
      'Локація, місце роботи 2',
      'Kyiv',
      'Lviv',
      { location: 'Lviv' },
    ],
  ])(
    '%s: labelled, shows its value, patches its key and has its error line',
    (label, key, name, value, typed, patch) => {
      const { onPatch } = renderJob()
      expect(screen.getByText(label)).toHaveAttribute('for', `resume-facts-experience-1-${key}`)
      const input = screen.getByRole('textbox', { name })
      expect(input).toHaveAttribute('id', `resume-facts-experience-1-${key}`)
      expect(input).toHaveValue(value)
      fireEvent.change(input, { target: { value: typed } })
      expect(onPatch).toHaveBeenCalledWith(patch)
      expect(screen.getByText(`error for experience.1.${key}`)).toBeInTheDocument()
    },
  )

  it('a missing location shows empty', () => {
    renderJob({ job: { location: null } })
    expect(screen.getByRole('textbox', { name: 'Локація, місце роботи 2' })).toHaveValue('')
  })

  it('clearing the location stores null, not an empty string', () => {
    const { onPatch } = renderJob()
    const input = screen.getByRole('textbox', { name: 'Локація, місце роботи 2' })
    fireEvent.change(input, { target: { value: '' } })
    expect(onPatch).toHaveBeenCalledWith({ location: null })
  })

  it('notes: one per line in, one per line out', () => {
    const { onPatch } = renderJob()
    expect(screen.getByText('Нотатки про досягнення')).toHaveAttribute(
      'for',
      'resume-facts-experience-1-notes',
    )
    const notes = screen.getByTestId('resume-facts-notes-1')
    expect(notes).toHaveAccessibleName('Нотатки, місце роботи 2')
    expect(notes).toHaveAttribute('placeholder', 'Що ви зробили і з яким результатом')
    expect(notes).toHaveValue('Built X\nShipped Y')
    fireEvent.change(notes, { target: { value: 'A\nB\nC' } })
    expect(onPatch).toHaveBeenCalledWith({ notes: ['A', 'B', 'C'] })
    expect(screen.getByText('error for experience.1.notes')).toBeInTheDocument()
  })
})

describe('the period', () => {
  const month = (which: 'початку' | 'завершення') =>
    screen.getByRole('combobox', { name: `Місяць ${which}, місце роботи 2` })

  it('start and end carry their field ids, names and error lines', () => {
    const { blurred } = renderJob({ invalid: ['experience.1.start', 'experience.1.end'] })
    for (const [which, key] of [
      ['початку', 'start'],
      ['завершення', 'end'],
    ] as const) {
      const trigger = month(which)
      expect(trigger).toHaveAttribute('id', `resume-facts-experience-1-${key}`)
      expect(trigger).toHaveAttribute('aria-invalid', 'true')
      expect(trigger).toHaveAttribute('aria-describedby', `resume-facts-experience-1-${key}-error`)
      expect(screen.getByRole('combobox', { name: `Рік ${which}, місце роботи 2` })).toBeVisible()
      expect(screen.getByText(`error for experience.1.${key}`)).toBeInTheDocument()
    }
    expect(screen.getByText('Початок')).toHaveAttribute('for', 'resume-facts-experience-1-start')
    expect(screen.getByText('Кінець')).toHaveAttribute('for', 'resume-facts-experience-1-end')
    expect(blurred).toEqual([])
  })

  it('a valid start and end carry no error wiring', () => {
    renderJob()
    expect(month('початку')).not.toHaveAttribute('aria-invalid', 'true')
    expect(month('початку')).not.toHaveAttribute('aria-describedby')
  })

  it('picking a start month patches start; closing the picker blurs the start field', async () => {
    const { onPatch, blurred } = renderJob()
    const u = user()
    await u.click(month('початку'))
    await u.click(await screen.findByTestId('salary-month-option-03'))
    expect(onPatch).toHaveBeenCalledWith({ start: '2020-03' })
    expect(blurred).toContain('experience.1.start')
  })

  it('picking an end month patches end; closing the picker blurs the end field', async () => {
    const { onPatch, blurred } = renderJob()
    const u = user()
    await u.click(month('завершення'))
    await u.click(await screen.findByTestId('salary-month-option-03'))
    expect(onPatch).toHaveBeenCalledWith({ end: '2022-03' })
    expect(blurred).toContain('experience.1.end')
  })

  it('an empty start and end show the month placeholder', () => {
    renderJob({ job: { start: null, end: null } })
    expect(month('початку')).toHaveTextContent('Місяць')
    expect(month('завершення')).toHaveTextContent('Місяць')
  })

  it.each([
    ['початку', 'start'],
    ['завершення', 'end'],
  ] as const)('an empty %s picks a month in the current year', async (which, key) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') })
    try {
      const { onPatch } = renderJob({ job: { start: null, end: null } })
      const u = user()
      await u.click(month(which))
      await u.click(await screen.findByTestId('salary-month-option-03'))
      expect(onPatch).toHaveBeenCalledWith({ [key]: '2026-03' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a filled start shows its month', () => {
    renderJob()
    expect(month('початку')).not.toHaveTextContent(/^Місяць$/)
  })

  it('"current" disables the end, and switching it on clears the end', async () => {
    const { onPatch } = renderJob()
    await user().click(screen.getByRole('switch', { name: 'Працюю тут зараз' }))
    expect(onPatch).toHaveBeenCalledWith({ current: true, end: null })
  })

  it('switching "current" off keeps the end as it is', async () => {
    const { onPatch } = renderJob({ job: { current: true, end: null } })
    expect(month('завершення')).toBeDisabled()
    expect(month('початку')).toBeEnabled()
    await user().click(screen.getByRole('switch', { name: 'Працюю тут зараз' }))
    expect(onPatch).toHaveBeenCalledWith({ current: false })
  })
})

describe('the technologies', () => {
  it('a removed chip patches technologies, and the wrapper is the field focus target', async () => {
    const { onPatch } = renderJob()
    await user().click(screen.getByRole('button', { name: 'Видалити React' }))
    expect(onPatch).toHaveBeenCalledWith({ technologies: ['Go'] })
    expect(focusFactsField('experience.1.technologies')).toBe(true)
    expect(screen.getByText('error for experience.1.technologies')).toBeInTheDocument()
  })

  it('leaving the input blurs the technologies field', () => {
    const { blurred } = renderJob()
    const input = screen.getByPlaceholderText('Технології, місце роботи 2')
    fireEvent.blur(input)
    expect(blurred).toContain('experience.1.technologies')
  })

  it('an invalid list ties the input to its error line', () => {
    renderJob({ invalid: ['experience.1.technologies'] })
    expect(screen.getByPlaceholderText('Технології, місце роботи 2')).toHaveAttribute(
      'aria-describedby',
      'resume-facts-experience-1-technologies-error',
    )
  })

  it('a valid list has no error wiring', () => {
    renderJob()
    expect(screen.getByPlaceholderText('Технології, місце роботи 2')).not.toHaveAttribute(
      'aria-describedby',
    )
  })
})

describe('FieldError', () => {
  it('joins every code of a touched field with a space', () => {
    render(
      <FieldError
        field="headline"
        errors={new Map([['headline', ['HEADLINE_MISSING', 'NON_LATIN']]])}
        touched={new Set(['headline'])}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(
      screen.getByText('Вкажіть цільову посаду Пишіть лише латиницею — резюме англійською'),
    ).toHaveAttribute('id', 'resume-facts-headline-error')
  })
})

describe('IconButton', () => {
  it('is named and titled by its label, and not destructive by default', () => {
    render(
      <IconButton label="Do" onClick={() => undefined}>
        x
      </IconButton>,
    )
    const button = screen.getByRole('button', { name: 'Do' })
    expect(button).toHaveAttribute('title', 'Do')
    expect(button).toBeEnabled()
    expect(button).not.toHaveClass('text-destructive')
  })
})
