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
    const { container } = render(<MarkdownDiff oldText="line one" newText="line two" />)
    expect(container.querySelector('[data-testid="markdown-diff"]')).toBeInTheDocument()
    expect(container.textContent).toContain('- line one')
    expect(container.textContent).toContain('+ line two')
  })

  it('handles trailing whitespace gracefully (trim both sides)', () => {
    render(<MarkdownDiff oldText="text\n\n" newText="text" />)
    expect(screen.getByTestId('markdown-diff-empty')).toBeInTheDocument()
  })
})
