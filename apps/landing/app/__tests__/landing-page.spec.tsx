/**
 * UI primitive smoke tests (task-landing-redesign.md — updated for the
 * redesign's component set). `Badge` is kept for potential future use but is
 * no longer used on the redesigned marketing surface (superseded by `Tag`/
 * `Chip`/`SectionEyebrow` — docs/design/landing-redesign.md §2.3); its test
 * stays as a plain component-level check.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BrandMark } from '@/components/brand-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Chip } from '@/components/ui/chip'

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

  it('renders as child element when asChild is true (mailto CTA pattern)', () => {
    const { container } = render(
      <Button asChild>
        <a href="mailto:hr@cheekycheese.tech">Contact Us</a>
      </Button>,
    )
    const anchor = container.querySelector('a')
    expect(anchor).toBeTruthy()
    expect(anchor?.getAttribute('href')).toBe('mailto:hr@cheekycheese.tech')
  })

  it('block variant renders full-width (mobile nav CTA)', () => {
    const { getByRole } = render(<Button block>Start a project</Button>)
    expect(getByRole('button').className).toContain('w-full')
  })
})

describe('Card', () => {
  it('renders children', () => {
    const { getByText } = render(<Card>Selected work</Card>)
    expect(getByText('Selected work')).toBeTruthy()
  })
})

describe('Tag', () => {
  it('renders domain variant text', () => {
    const { getByText } = render(<Tag variant="ai">AI / ML</Tag>)
    expect(getByText('AI / ML')).toBeTruthy()
  })
})

describe('Chip', () => {
  it('renders with a dot indicator', () => {
    const { container, getByText } = render(<Chip>TypeScript</Chip>)
    expect(getByText('TypeScript')).toBeTruthy()
    expect(container.querySelector('span[aria-hidden="true"]')).toBeTruthy()
  })
})
