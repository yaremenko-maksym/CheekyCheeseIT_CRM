/**
 * UI primitive smoke tests (task-landing-redesign.md — updated for the
 * redesign's component set). `Badge` is kept for potential future use but is
 * no longer used on the redesigned marketing surface (superseded by `Tag`/
 * `Chip`/`SectionEyebrow` — docs/design/landing-redesign.md §2.3); its test
 * stays as a plain component-level check.
 *
 * Queries go through `screen`, not through `container` or destructured
 * `render()` results (task-lint-teeth). `screen` is bound to `document.body`,
 * so it also sees content rendered through a portal — the blindness that made
 * a whole XSS-sanitisation suite pass against an unprotected dialog on
 * 2026-08-07. These primitives do not portal today, but the habit is the point:
 * the rules are on repo-wide, and one file exempting itself is how the pattern
 * came back last time.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrandMark } from '@/components/brand-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Chip } from '@/components/ui/chip'

describe('BrandMark', () => {
  it('renders outline variant svg with aria-label', () => {
    render(<BrandMark className="h-8 w-8" />)
    // The mark exposes itself as an image with an accessible name — assert the
    // contract a screen reader sees, rather than reaching for the raw <svg>.
    expect(screen.getByRole('img', { name: 'CheekyCheeseIT' })).toBeTruthy()
  })

  it('renders flat variant svg', () => {
    render(<BrandMark variant="flat" className="h-6 w-6" />)
    expect(screen.getByRole('img', { name: 'CheekyCheeseIT' })).toBeTruthy()
  })
})

describe('Badge', () => {
  it('renders children text', () => {
    render(<Badge>Outsource · Outstaffing</Badge>)
    expect(screen.getByText('Outsource · Outstaffing')).toBeTruthy()
  })

  it('renders outline variant', () => {
    render(
      <Badge variant="outline" className="border-primary/30 text-primary">
        We&apos;re hiring
      </Badge>
    )
    expect(screen.getByText("We're hiring")).toBeTruthy()
  })
})

describe('Button', () => {
  it('renders as button element by default', () => {
    render(<Button>Contact Us</Button>)
    expect(screen.getByRole('button', { name: /contact us/i })).toBeTruthy()
  })

  it('renders as child element when asChild is true (mailto CTA pattern)', () => {
    render(
      <Button asChild>
        <a href="mailto:hr@cheekycheese.tech">Contact Us</a>
      </Button>
    )
    // `asChild` must render the anchor itself, not wrap it in a <button> —
    // asserting the link role proves exactly that.
    expect(screen.getByRole('link', { name: 'Contact Us' })).toHaveAttribute(
      'href',
      'mailto:hr@cheekycheese.tech'
    )
  })

  it('block variant renders full-width (mobile nav CTA)', () => {
    render(<Button block>Start a project</Button>)
    expect(screen.getByRole('button').className).toContain('w-full')
  })
})

describe('Card', () => {
  it('renders children', () => {
    render(<Card>Selected work</Card>)
    expect(screen.getByText('Selected work')).toBeTruthy()
  })
})

describe('Tag', () => {
  it('renders domain variant text', () => {
    render(<Tag variant="ai">AI / ML</Tag>)
    expect(screen.getByText('AI / ML')).toBeTruthy()
  })
})

describe('Chip', () => {
  it('renders with a dot indicator', () => {
    const { container } = render(<Chip>TypeScript</Chip>)
    expect(screen.getByText('TypeScript')).toBeTruthy()

    // The dot is purely decorative and carries `aria-hidden="true"` (chip.tsx),
    // which is correct: a screen reader must not announce it. That also puts it
    // permanently out of reach of every accessible `screen` query — there is no
    // role, no name and no text to match. This is the one case where a
    // container query is the honest tool rather than a shortcut, so the rules
    // are relaxed for this single expression with the reason stated, not for
    // the file. (task-lint-teeth)
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.querySelector('span[aria-hidden="true"]')).toBeTruthy()
  })
})
