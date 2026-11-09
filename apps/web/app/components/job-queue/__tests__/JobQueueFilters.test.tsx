import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import {
  JobQueueAppliedFilters,
  JobQueueFilters,
  appliedFilterCount,
  type JobQueueFilterValue,
} from '../JobQueueFilters'

const SENIOR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SENIOR_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UNKNOWN_SENIOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OPTIONS = [
  { id: SENIOR_A, name: 'Анна Коваль', teamName: 'Команда А' },
  { id: SENIOR_B, name: 'Богдан Шевченко', teamName: 'Команда А' },
]
const loaded = { items: OPTIONS, isError: false, onRetry: () => {} }

describe('appliedFilterCount', () => {
  it.each<[JobQueueFilterValue, number]>([
    [{}, 0],
    [{ source: [] }, 0],
    [{ source: ['DOU_RSS', 'LEVER_ATS', 'REMOTEOK_API'] }, 1],
    [{ eligibility: ['LEAD'] }, 1],
    [{ availability: ['OPEN', 'CLOSED'] }, 1],
    [{ source: ['DOU_RSS'], eligibility: ['LEAD'], availability: ['OPEN'] }, 3],
    [{ seniorIds: [] }, 0],
    [{ seniorIds: [SENIOR_A, SENIOR_B] }, 1],
    [
      { source: ['DOU_RSS'], eligibility: ['LEAD'], availability: ['OPEN'], seniorIds: [SENIOR_A] },
      4,
    ],
  ])('%j counts %i groups', (value, expected) => {
    expect(appliedFilterCount(value)).toBe(expected)
  })
})

describe('JobQueueFilters', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('summarizes the applied groups in source · eligibility · availability order', async () => {
    const onReset = vi.fn()
    render(
      <JobQueueAppliedFilters
        value={{ availability: ['OPEN', 'CLOSED'], eligibility: ['TRIAGE'], source: ['DOU_RSS'] }}
        onReset={onReset}
      />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
      'Застосовано: DOU · Потребує розгляду · Відкрита, Закрита',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Скинути фільтри' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('keeps the reset inline: the row does not wrap, the summary wraps, the reset holds its size', () => {
    render(<JobQueueAppliedFilters value={{ source: ['DOU_RSS'] }} onReset={vi.fn()} />, {
      wrapper: I18nTestProvider,
    })
    const row = screen.getByTestId('job-queue-applied')
    expect(row).not.toHaveClass('flex-wrap')
    expect(row).toHaveClass('flex', 'items-baseline', 'justify-between')
    expect(screen.getByText(/Застосовано/)).toHaveClass('min-w-0', 'flex-1', 'break-words')
    expect(screen.getByRole('button', { name: 'Скинути фільтри' })).toHaveClass(
      'shrink-0',
      'whitespace-nowrap',
      'min-h-11',
    )
  })

  it('renders no summary while nothing is applied', () => {
    render(<JobQueueAppliedFilters value={{ source: [] }} onReset={vi.fn()} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.queryByTestId('job-queue-applied')).toBeNull()
  })

  it('applies the picked selection only on «Застосувати»', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={onApply} />, { wrapper: I18nTestProvider })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    expect(screen.getByTestId('job-queue-filters-panel')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Потребує розгляду' }))
    await user.click(screen.getByRole('checkbox', { name: 'Закрита' }))
    await user.click(screen.getByRole('checkbox', { name: 'DOU' }))
    expect(onApply).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({
      eligibility: ['TRIAGE'],
      availability: ['CLOSED'],
      source: ['DOU_RSS'],
    })
  })

  it('caps the panel to the viewport and keeps Apply/Clear outside the scroll region', async () => {
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={vi.fn()} />, { wrapper: I18nTestProvider })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    expect(screen.getByTestId('job-queue-filters-panel')).toHaveClass(
      'max-h-[var(--radix-popover-content-available-height)]',
      'overflow-hidden',
    )
    const body = screen.getByTestId('job-queue-filters-body')
    const footer = screen.getByTestId('job-queue-filters-footer')
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain')
    expect(footer).toHaveClass('shrink-0')
    expect(body).toContainElement(screen.getByRole('checkbox', { name: 'DOU' }))
    for (const id of ['job-queue-filters-apply', 'job-queue-filters-clear']) {
      expect(footer).toContainElement(screen.getByTestId(id))
      expect(body).not.toContainElement(screen.getByTestId(id))
    }
  })

  it('unchecking the last value of a group drops the group', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{ eligibility: ['LEAD'] }} onApply={onApply} />, {
      wrapper: I18nTestProvider,
    })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    const lead = screen.getByRole('checkbox', { name: 'Збіг за стеком' })
    expect(lead).toBeChecked()
    await user.click(lead)
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({})
  })

  it('shows how many filters are applied and «Скинути вибір» clears the draft', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(
      <JobQueueFilters
        value={{ eligibility: ['TRIAGE'], availability: ['OPEN', 'UNKNOWN'] }}
        onApply={onApply}
      />,
      { wrapper: I18nTestProvider },
    )
    // the badge counts groups (eligibility + availability), not options
    // visible: «Фільтри» + «2»; screen readers also hear what the 2 means
    const button = screen.getByTestId('job-queue-filters-button')
    expect(button).toHaveTextContent('Фільтри2Активних фільтрів: 2')
    expect(screen.getByText('2')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('Активних фільтрів: 2')).toHaveClass('sr-only')
    await user.click(screen.getByTestId('job-queue-filters-button'))
    await user.click(screen.getByTestId('job-queue-filters-clear'))
    expect(screen.getByRole('checkbox', { name: 'Потребує розгляду' })).not.toBeChecked()
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({})
  })

  it('unchecking one value keeps the rest of its group, and «Застосувати» closes the panel', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{ availability: ['OPEN', 'CLOSED'] }} onApply={onApply} />, {
      wrapper: I18nTestProvider,
    })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    await user.click(screen.getByRole('checkbox', { name: 'Відкрита' }))
    await user.click(screen.getByTestId('job-queue-filters-apply'))
    expect(onApply).toHaveBeenCalledWith({ availability: ['CLOSED'] })
    expect(screen.queryByTestId('job-queue-filters-panel')).toBeNull()
  })

  it('discards an unapplied draft when the panel closes', async () => {
    const onApply = vi.fn()
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={onApply} />, { wrapper: I18nTestProvider })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    await user.click(screen.getByRole('checkbox', { name: 'Закрита' }))
    expect(screen.getByRole('checkbox', { name: 'Закрита' })).toBeChecked()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('job-queue-filters-panel')).toBeNull()
    await user.click(screen.getByTestId('job-queue-filters-button'))
    expect(screen.getByRole('checkbox', { name: 'Закрита' })).not.toBeChecked()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('has one scroll region: no filter group scrolls on its own', async () => {
    const user = userEvent.setup()
    render(<JobQueueFilters value={{}} onApply={vi.fn()} seniors={loaded} />, {
      wrapper: I18nTestProvider,
    })
    await user.click(screen.getByTestId('job-queue-filters-button'))
    for (const name of ['Джерело', 'Статус на джерелі', 'Підходить сеньйору']) {
      // eslint-disable-next-line testing-library/no-node-access
      expect(screen.getByRole('group', { name }).querySelector('div')).not.toHaveAttribute('class')
    }
  })

  it('names the unknown and expired availability values', () => {
    render(
      <JobQueueAppliedFilters value={{ availability: ['UNKNOWN', 'EXPIRED'] }} onReset={vi.fn()} />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
      /^Застосовано: Невідомо, ПростроченаСкинути фільтри$/,
    )
  })

  it('shows no count when nothing is applied', () => {
    render(<JobQueueFilters value={{}} onApply={() => {}} />, { wrapper: I18nTestProvider })
    expect(screen.getByTestId('job-queue-filters-button')).toHaveTextContent(/^Фільтри$/)
  })

  describe('«Підходить сеньйору»', () => {
    const open = async (
      seniors: Parameters<typeof JobQueueFilters>[0]['seniors'],
      value: JobQueueFilterValue = {},
      onApply: (next: JobQueueFilterValue) => void = vi.fn(),
    ) => {
      const user = userEvent.setup()
      render(<JobQueueFilters value={value} onApply={onApply} seniors={seniors} />, {
        wrapper: I18nTestProvider,
      })
      await user.click(screen.getByTestId('job-queue-filters-button'))
      return user
    }

    it('summarizes the seniors by name, last, and never shows an id', () => {
      render(
        <JobQueueAppliedFilters
          value={{ seniorIds: [SENIOR_B, SENIOR_A], source: ['DOU_RSS'] }}
          seniors={OPTIONS}
          onReset={vi.fn()}
        />,
        { wrapper: I18nTestProvider },
      )
      expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
        /^Застосовано: DOU · Сеньйори: Богдан Шевченко, Анна КовальСкинути фільтри$/,
      )
    })

    it('prefixes one named senior with the singular «Сеньйор:»', () => {
      render(
        <JobQueueAppliedFilters
          value={{ seniorIds: [SENIOR_A] }}
          seniors={OPTIONS}
          onReset={vi.fn()}
        />,
        { wrapper: I18nTestProvider },
      )
      expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
        /^Застосовано: Сеньйор: Анна КовальСкинути фільтри$/,
      )
    })

    it('keeps one team (every HR) a flat list without a team heading', async () => {
      await open(loaded)
      const group = screen.getByRole('group', { name: 'Підходить сеньйору' })
      expect(within(group).queryByRole('group', { name: 'Команда А' })).toBeNull()
      expect(group).not.toHaveTextContent('Команда А')
    })

    it('groups the studio (ADMIN) by team, in the server order', async () => {
      const studio = [
        { id: SENIOR_A, name: 'Анна Коваль', teamName: 'Альфа' },
        { id: UNKNOWN_SENIOR, name: 'Віра Бондар', teamName: 'Альфа' },
        { id: SENIOR_B, name: 'Богдан Шевченко', teamName: 'Бета' },
      ]
      await open({ items: studio, isError: false, onRetry: vi.fn() })
      const alpha = screen.getByRole('group', { name: 'Альфа' })
      const beta = screen.getByRole('group', { name: 'Бета' })
      expect(within(alpha).getAllByRole('checkbox')).toHaveLength(2)
      expect(within(alpha).getByRole('checkbox', { name: 'Анна Коваль' })).toBeInTheDocument()
      expect(within(alpha).getByRole('checkbox', { name: 'Віра Бондар' })).toBeInTheDocument()
      expect(within(beta).getAllByRole('checkbox')).toHaveLength(1)
      expect(within(beta).getByRole('checkbox', { name: 'Богдан Шевченко' })).toBeInTheDocument()
      expect(alpha.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('puts the seniors with no team in a last group headed «Без команди» (SO2-1)', async () => {
      const studio = [
        { id: SENIOR_A, name: 'Анна Коваль', teamName: 'Альфа' },
        { id: SENIOR_B, name: 'Богдан Шевченко', teamName: null },
      ]
      await open({ items: studio, isError: false, onRetry: vi.fn() })
      const alpha = screen.getByRole('group', { name: 'Альфа' })
      const none = screen.getByRole('group', { name: 'Без команди' })
      expect(none).toHaveTextContent(/^Без команди/)
      expect(within(none).getByRole('checkbox', { name: 'Богдан Шевченко' })).toBeInTheDocument()
      expect(within(none).getAllByRole('checkbox')).toHaveLength(1)
      expect(alpha.compareDocumentPosition(none) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    const options = (length: number) => ({
      items: Array.from({ length }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        name: `Сеньйор ${i}`,
        teamName: 'Команда А',
      })),
      isError: false,
      onRetry: vi.fn(),
    })

    it('says only the first 200 seniors show when the picker reaches its cap (CR-L-2)', async () => {
      await open(options(200))
      expect(screen.getByTestId('job-queue-filters-seniors-truncated')).toHaveTextContent(
        'Показано перших 200 сеньйорів',
      )
    })

    it('shows no cap note below 200 seniors', async () => {
      await open(options(199))
      expect(screen.queryByTestId('job-queue-filters-seniors-truncated')).toBeNull()
    })

    it.each([
      [[SENIOR_A], '1 сеньйор'],
      [[SENIOR_A, SENIOR_B], '2 сеньйори'],
      [[SENIOR_A, SENIOR_B, UNKNOWN_SENIOR, 'd', 'e'], '5 сеньйорів'],
    ])('without a picker answer, %j count as «%s»; the reset stays', async (seniorIds, count) => {
      const onReset = vi.fn()
      render(<JobQueueAppliedFilters value={{ seniorIds }} onReset={onReset} />, {
        wrapper: I18nTestProvider,
      })
      expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
        new RegExp(`^Застосовано: ${count}Скинути фільтри$`),
      )
      await userEvent.click(screen.getByRole('button', { name: 'Скинути фільтри' }))
      expect(onReset).toHaveBeenCalledOnce()
    })

    it('counts every senior as soon as one name is missing, and never shows an id', () => {
      render(
        <JobQueueAppliedFilters
          value={{ seniorIds: [SENIOR_B, UNKNOWN_SENIOR], source: ['DOU_RSS'] }}
          seniors={OPTIONS}
          onReset={vi.fn()}
        />,
        { wrapper: I18nTestProvider },
      )
      expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
        /^Застосовано: DOU · 2 сеньйориСкинути фільтри$/,
      )
    })

    it('counts a senior whose display name is empty', () => {
      render(
        <JobQueueAppliedFilters
          value={{ seniorIds: [SENIOR_A] }}
          seniors={[{ id: SENIOR_A, name: '', teamName: 'Команда А' }]}
          onReset={vi.fn()}
        />,
        { wrapper: I18nTestProvider },
      )
      expect(screen.getByTestId('job-queue-applied')).toHaveTextContent(
        /^Застосовано: 1 сеньйорСкинути фільтри$/,
      )
    })

    it('renders no section without a picker', async () => {
      await open(undefined)
      expect(screen.queryByRole('group', { name: 'Підходить сеньйору' })).toBeNull()
    })

    it('lists the seniors in the scroll region and applies the picked ids', async () => {
      const onApply = vi.fn()
      const user = await open(loaded, {}, onApply)
      const anna = screen.getByRole('checkbox', { name: 'Анна Коваль' })
      expect(screen.getByTestId('job-queue-filters-body')).toContainElement(anna)
      expect(anna).not.toBeChecked()
      expect(anna).toBeEnabled()
      await user.click(anna)
      await user.click(screen.getByRole('checkbox', { name: 'Богдан Шевченко' }))
      await user.click(screen.getByTestId('job-queue-filters-apply'))
      expect(onApply).toHaveBeenCalledWith({ seniorIds: [SENIOR_A, SENIOR_B] })
    })

    it('a row keeps a 44 px target and exposes the truncated name as a title', async () => {
      await open(loaded)
      const name = screen.getByTitle('Анна Коваль')
      expect(name).toHaveClass('min-w-0', 'truncate')
      // eslint-disable-next-line testing-library/no-node-access -- the row label has no role query of its own
      expect(name.closest('label')).toHaveClass('min-h-11')
    })

    it('the group fieldset can shrink, so a long name truncates instead of scrolling sideways', async () => {
      await open(loaded)
      expect(screen.getByRole('group', { name: 'Підходить сеньйору' })).toHaveClass('min-w-0')
    })

    it('reopens with the applied seniors checked and «Скинути вибір» clears them', async () => {
      const onApply = vi.fn()
      const user = await open(loaded, { seniorIds: [SENIOR_A] }, onApply)
      expect(screen.getByRole('checkbox', { name: 'Анна Коваль' })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'Богдан Шевченко' })).not.toBeChecked()
      await user.click(screen.getByTestId('job-queue-filters-clear'))
      expect(screen.getByRole('checkbox', { name: 'Анна Коваль' })).not.toBeChecked()
      await user.click(screen.getByTestId('job-queue-filters-apply'))
      expect(onApply).toHaveBeenCalledWith({})
    })

    it('a failed load shows an inline error with a retry, and the panel keeps working', async () => {
      const onApply = vi.fn()
      const onRetry = vi.fn()
      const user = await open({ items: undefined, isError: true, onRetry }, {}, onApply)
      const group = screen.getByRole('group', { name: 'Підходить сеньйору' })
      expect(within(group).getByRole('alert')).toHaveTextContent('Не вдалося завантажити сеньйорів')
      await user.click(within(group).getByRole('button', { name: 'Спробувати ще раз' }))
      expect(onRetry).toHaveBeenCalledTimes(1)
      await user.click(screen.getByRole('checkbox', { name: 'DOU' }))
      await user.click(screen.getByTestId('job-queue-filters-apply'))
      expect(onApply).toHaveBeenCalledWith({ source: ['DOU_RSS'] })
    })

    it('keeps the loaded rows when only a refetch failed', async () => {
      await open({ items: OPTIONS, isError: true, onRetry: vi.fn() })
      expect(screen.getByRole('checkbox', { name: 'Анна Коваль' })).toBeInTheDocument()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('shows a placeholder and no rows while the picker loads', async () => {
      await open({ items: undefined, isError: false, onRetry: vi.fn() })
      const group = screen.getByRole('group', { name: 'Підходить сеньйору' })
      expect(within(group).getByTestId('job-queue-filters-seniors-loading')).toBeInTheDocument()
      expect(within(group).queryByRole('checkbox')).toBeNull()
      expect(within(group).queryByRole('alert')).toBeNull()
    })

    it('marks the senior group busy only while the picker loads', async () => {
      await open({ items: undefined, isError: false, onRetry: vi.fn() })
      expect(screen.getByRole('group', { name: 'Підходить сеньйору' })).toHaveAttribute(
        'aria-busy',
        'true',
      )
      expect(screen.getByRole('group', { name: 'Тип збігу' })).not.toHaveAttribute('aria-busy')
    })

    it.each([
      ['loaded with items', { items: OPTIONS, isError: false, onRetry: vi.fn() }],
      ['loaded empty', { items: [], isError: false, onRetry: vi.fn() }],
      ['failed', { items: undefined, isError: true, onRetry: vi.fn() }],
    ])('does not mark the senior group busy when %s', async (_state, picker) => {
      await open(picker)
      expect(screen.getByRole('group', { name: 'Підходить сеньйору' })).not.toHaveAttribute(
        'aria-busy',
      )
    })

    it('says so when the scope has no seniors', async () => {
      await open({ items: [], isError: false, onRetry: vi.fn() })
      expect(screen.getByRole('group', { name: 'Підходить сеньйору' })).toHaveTextContent(
        'Немає сеньйорів',
      )
    })

    it('disables only the unchecked rows at the API limit of 50', async () => {
      const many = Array.from({ length: 51 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        name: `Сеньйор ${i}`,
        teamName: 'Команда А',
      }))
      const user = await open(
        { items: many, isError: false, onRetry: vi.fn() },
        { seniorIds: many.slice(0, 50).map((s) => s.id) },
      )
      const last = screen.getByRole('checkbox', { name: 'Сеньйор 50' })
      const first = screen.getByRole('checkbox', { name: 'Сеньйор 0' })
      expect(last).toBeDisabled()
      expect(first).toBeEnabled()
      await user.click(first)
      expect(last).toBeEnabled()
    })

    it('keeps 49 selected rows from disabling the rest', async () => {
      const many = Array.from({ length: 50 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        name: `Сеньйор ${i}`,
        teamName: 'Команда А',
      }))
      await open(
        { items: many, isError: false, onRetry: vi.fn() },
        { seniorIds: many.slice(0, 49).map((s) => s.id) },
      )
      expect(screen.getByRole('checkbox', { name: 'Сеньйор 49' })).toBeEnabled()
    })
  })
})
