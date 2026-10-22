import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SafeHttpLink } from './SafeHttpLink'

describe('SafeHttpLink', () => {
  it('renders an external link for https URLs', () => {
    render(<SafeHttpLink url="https://meet.google.com/abc-defg-hij" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://meet.google.com/abc-defg-hij')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'not a url'])(
    'renders %s as inert text without a link',
    (url) => {
      render(<SafeHttpLink url={url} />)
      expect(screen.queryByRole('link')).toBeNull()
      expect(screen.getByText(url).tagName).toBe('SPAN')
    },
  )
})
