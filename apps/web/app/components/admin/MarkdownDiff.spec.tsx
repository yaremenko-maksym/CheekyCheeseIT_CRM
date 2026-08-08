import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarkdownDiff } from './MarkdownDiff'

describe('MarkdownDiff', () => {
  it('shows empty state when texts are identical', () => {
    render(<MarkdownDiff oldText="same content" newText="same content" />)
    expect(screen.getByTestId('markdown-diff-empty')).toBeInTheDocument()
    expect(
      screen.getByText('Изменений нет — содержимое идентично текущей версии.'),
    ).toBeInTheDocument()
  })

  it('shows initial state when oldText is empty', () => {
    render(<MarkdownDiff oldText="" newText="new content here" />)
    expect(screen.getByTestId('markdown-diff-initial')).toBeInTheDocument()
    expect(
      screen.getByText('Первая публикация — всё содержимое будет добавлено как новое.'),
    ).toBeInTheDocument()
  })

  it('renders added and removed parts for actual diff', () => {
    render(<MarkdownDiff oldText="line one" newText="line two" />)
    const diff = screen.getByTestId('markdown-diff')
    expect(diff).toBeInTheDocument()
    expect(diff).toHaveTextContent('- line one')
    expect(diff).toHaveTextContent('+ line two')
  })

  it('handles trailing whitespace gracefully (trim both sides)', () => {
    // Use template literal so \n is interpreted as real newlines
    render(<MarkdownDiff oldText={`text\n\n`} newText="text" />)
    expect(screen.getByTestId('markdown-diff-empty')).toBeInTheDocument()
  })
})
