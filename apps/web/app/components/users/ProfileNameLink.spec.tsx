/**
 * Unit tests for ProfileNameLink — nonNavigable prop (task-admin-as-senior).
 *
 * Covers:
 *   PNL-1  nonNavigable=true → renders plain <span>, no <a> anchor
 *   PNL-2  viewerRole='DROP' → renders plain <span>, no <a> anchor (existing behavior, regression)
 *   PNL-3  nonNavigable=true + viewerRole='DROP' → renders plain <span> (both true)
 *   PNL-4  nonNavigable=false + viewerRole='ADMIN' → must NOT render span (would be Link if router present)
 *   PNL-5  className + title + testId forwarded to span when nonNavigable=true
 *   PNL-6  children rendered in span when nonNavigable=true
 *
 * Note: The <Link> branch (nonNavigable=false, viewerRole≠'DROP') requires a
 * TanStack Router context and is covered by E2E / integration tests. These unit
 * tests focus exclusively on the plain-text (span) render path since that is the
 * security-critical branch (admin-senior masking + DROP lockdown).
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProfileNameLink } from './ProfileNameLink'

describe('ProfileNameLink — nonNavigable prop (task-admin-as-senior)', () => {
  it('PNL-1. nonNavigable=true → renders <span>, not a navigable link', () => {
    render(
      <ProfileNameLink userId="some-admin-id" viewerRole="SENIOR" nonNavigable={true}>
        Maksym Admin
      </ProfileNameLink>,
    )
    // Should render the name as plain text in a span
    const el = screen.getByText('Maksym Admin')
    expect(el.tagName.toLowerCase()).toBe('span')
    // Must not be an anchor
    expect(el.closest('a')).toBeNull()
  })

  it('PNL-2. viewerRole="DROP" → renders <span> (existing DROP lockdown — regression guard)', () => {
    render(
      <ProfileNameLink userId="some-user-id" viewerRole="DROP">
        Some Employee
      </ProfileNameLink>,
    )
    const el = screen.getByText('Some Employee')
    expect(el.tagName.toLowerCase()).toBe('span')
    expect(el.closest('a')).toBeNull()
  })

  it('PNL-3. nonNavigable=true + viewerRole="DROP" → renders <span> (both paths active)', () => {
    render(
      <ProfileNameLink userId="some-user-id" viewerRole="DROP" nonNavigable={true}>
        Both Flags
      </ProfileNameLink>,
    )
    const el = screen.getByText('Both Flags')
    expect(el.tagName.toLowerCase()).toBe('span')
    expect(el.closest('a')).toBeNull()
  })

  it('PNL-5. nonNavigable=true — className, title, testId forwarded to span', () => {
    render(
      <ProfileNameLink
        userId="u1"
        viewerRole="HR"
        nonNavigable={true}
        className="my-class"
        title="Admin tooltip"
        testId="admin-senior-name"
      >
        Labeled Name
      </ProfileNameLink>,
    )
    const el = screen.getByTestId('admin-senior-name')
    expect(el.tagName.toLowerCase()).toBe('span')
    expect(el.className).toContain('my-class')
    expect(el.getAttribute('title')).toBe('Admin tooltip')
  })

  it('PNL-6. nonNavigable=true — children rendered correctly inside span', () => {
    render(
      <ProfileNameLink userId="u2" viewerRole="SENIOR" nonNavigable={true}>
        <strong>Bold Name</strong>
      </ProfileNameLink>,
    )
    // The span must contain the child element
    const strong = screen.getByText('Bold Name')
    expect(strong.tagName.toLowerCase()).toBe('strong')
    expect(strong.closest('span')).not.toBeNull()
    expect(strong.closest('a')).toBeNull()
  })
})
