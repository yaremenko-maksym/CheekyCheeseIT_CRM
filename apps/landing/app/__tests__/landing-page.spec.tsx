import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BrandMark } from '@/components/brand-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

describe('BrandMark', () => {
  it('renders outline variant svg with aria-label', () => {
    const { container } = render(<BrandMark className="h-8 w-8" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('aria-label')).toBe('CheekyCheeseIT')
  })

  it('renders flat variant svg', () => {
    const { container } = render(<BrandMark variant="flat" className="h-6 w-6" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
  })
})

describe('Badge', () => {
  it('renders children text', () => {
    const { container } = render(<Badge>Outsource · Outstaffing</Badge>)
    expect(container.textContent).toContain('Outsource · Outstaffing')
  })

  it('renders outline variant', () => {
    const { container } = render(
      <Badge variant="outline" className="border-primary/30 text-primary">
        We&apos;re hiring
      </Badge>,
    )
    expect(container.textContent).toContain("We're hiring")
  })
})

describe('Button', () => {
  it('renders as button element by default', () => {
    const { getByRole } = render(<Button>Contact Us</Button>)
    expect(getByRole('button', { name: /contact us/i })).toBeTruthy()
  })

  it('renders as child element when asChild is true', () => {
    const { container } = render(
      <Button asChild>
        <a href="mailto:contact@cheekycheeseit.com">Contact Us</a>
      </Button>,
    )
    const anchor = container.querySelector('a')
    expect(anchor).toBeTruthy()
    expect(anchor?.href).toContain('mailto:')
  })
})
