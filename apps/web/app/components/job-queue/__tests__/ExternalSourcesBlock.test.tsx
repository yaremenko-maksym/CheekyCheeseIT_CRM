import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EXTERNAL_FEEDS, type TechnicalRole } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { ExternalSourcesBlock } from '../ExternalSourcesBlock'

const renderBlock = (
  props: {
    roles?: readonly TechnicalRole[]
    seniorName?: string | undefined
    onRegister?: () => void
  } = {},
) =>
  render(
    <I18nTestProvider>
      <ExternalSourcesBlock
        roles={props.roles ?? []}
        seniorName={props.seniorName}
        onRegister={props.onRegister ?? (() => {})}
      />
    </I18nTestProvider>,
  )

beforeEach(async () => {
  await loadCatalog('uk')
})
afterEach(cleanup)

describe('ExternalSourcesBlock', () => {
  it('starts closed and opens on the summary', async () => {
    const user = userEvent.setup({ delay: null })
    renderBlock()
    const section = screen.getByTestId('external-sources')
    expect(section).not.toHaveAttribute('open')
    await user.click(within(section).getByTestId('external-sources-title'))
    expect(section).toHaveAttribute('open')
  })

  it("one link per feed, built from the senior's roles, opened in a new tab without an opener", () => {
    renderBlock({ roles: ['DEVOPS_ENGINEER', 'QA_ENGINEER'], seniorName: 'Senior A' })
    const links = within(screen.getByTestId('external-sources-links')).getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual(EXTERNAL_FEEDS.map((f) => f.label))
    links.forEach((a, i) => {
      expect(a).toHaveAttribute(
        'href',
        EXTERNAL_FEEDS[i]!.buildUrl({ roles: ['DEVOPS_ENGINEER', 'QA_ENGINEER'] }),
      )
      expect(a).toHaveAttribute('target', '_blank')
      expect(a).toHaveAttribute('rel', 'noopener noreferrer')
    })
  })

  it('names the senior whose roles drive the filters', () => {
    renderBlock({ roles: ['DEVOPS_ENGINEER'], seniorName: 'Senior A' })
    const filters = screen.getByTestId('external-sources-filters')
    expect(filters).toHaveTextContent('Senior A')
    expect(filters).toHaveAttribute('data-filters', 'role')
  })

  it('no senior: general filters, and the summary says so', () => {
    renderBlock()
    const links = within(screen.getByTestId('external-sources-links')).getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', 'https://jobs.dou.ua/vacancies/?exp=5plus&remote')
    expect(screen.getByTestId('external-sources-filters')).not.toHaveTextContent('Senior A')
    expect(screen.getByTestId('external-sources-filters')).toHaveAttribute(
      'data-filters',
      'general',
    )
  })

  it('a senior without roles also falls back to general filters but is still named', () => {
    renderBlock({ roles: [], seniorName: 'Senior B' })
    const links = within(screen.getByTestId('external-sources-links')).getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', 'https://jobs.dou.ua/vacancies/?exp=5plus&remote')
    const filters = screen.getByTestId('external-sources-filters')
    expect(filters).toHaveTextContent('Senior B')
    expect(filters).toHaveAttribute('data-filters', 'no-roles')
  })

  it('the register button calls onRegister', async () => {
    const user = userEvent.setup({ delay: null })
    const onRegister = vi.fn()
    renderBlock({ onRegister })
    await user.click(screen.getByTestId('external-sources-title'))
    await user.click(screen.getByTestId('external-sources-register'))
    expect(onRegister).toHaveBeenCalledTimes(1)
  })
})
