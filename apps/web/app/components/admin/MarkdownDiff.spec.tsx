import { beforeEach, describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { MarkdownDiff } from './MarkdownDiff'

const renderDiff = (ui: React.ReactElement) => render(<I18nTestProvider>{ui}</I18nTestProvider>)

describe('MarkdownDiff', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('shows empty state when texts are identical', () => {
    renderDiff(<MarkdownDiff oldText="same content" newText="same content" />)
    expect(screen.getByTestId('markdown-diff-empty')).toBeInTheDocument()
    expect(screen.getByText('Змін немає — вміст ідентичний поточній версії.')).toBeInTheDocument()
  })

  it('shows initial state when oldText is empty', () => {
    renderDiff(<MarkdownDiff oldText="" newText="new content here" />)
    expect(screen.getByTestId('markdown-diff-initial')).toBeInTheDocument()
    expect(
      screen.getByText('Перша публікація — весь вміст буде додано як новий.'),
    ).toBeInTheDocument()
  })

  it('renders added and removed parts for actual diff', () => {
    renderDiff(<MarkdownDiff oldText="line one" newText="line two" />)
    const diff = screen.getByTestId('markdown-diff')
    expect(diff).toBeInTheDocument()
    expect(diff).toHaveTextContent('- line one')
    expect(diff).toHaveTextContent('+ line two')
  })

  it('handles trailing whitespace gracefully (trim both sides)', () => {
    // Use template literal so \n is interpreted as real newlines
    renderDiff(<MarkdownDiff oldText={`text\n\n`} newText="text" />)
    expect(screen.getByTestId('markdown-diff-empty')).toBeInTheDocument()
  })
})
