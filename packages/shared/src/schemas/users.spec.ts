import { describe, expect, it } from 'vitest'
import { updateProfileSchema, adminUpdateUserSchema, AVATAR_OVERRIDE_PATTERN } from './users'

/**
 * Tests for CRITICAL #4 from PR #28: avatarOverride must reject any blob other
 * than https URLs or data:image/(png|jpeg|gif|webp) base64 payloads. SVG and
 * non-image MIME types (text/html, application/json, …) are XSS surfaces and
 * must be rejected at the schema layer.
 */
describe('avatarOverride validation (allowlist)', () => {
  const validData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4AWMAAQAAAAEAAOFv6sIAAAAASUVORK5CYII='

  it('accepts https:// URLs', () => {
    expect(updateProfileSchema.safeParse({ avatarOverride: 'https://lh3.googleusercontent.com/a/abc' }).success).toBe(true)
    expect(adminUpdateUserSchema.safeParse({ avatarOverride: 'https://lh3.googleusercontent.com/a/abc' }).success).toBe(true)
  })

  it('accepts data:image/png;base64', () => {
    expect(updateProfileSchema.safeParse({ avatarOverride: validData }).success).toBe(true)
  })

  it.each([
    ['data:image/jpeg', 'data:image/jpeg;base64,/9j/4AAQSkZJRgAB'],
    ['data:image/jpg', 'data:image/jpg;base64,/9j/4AAQSkZJRgAB'],
    ['data:image/gif', 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs='],
    ['data:image/webp', 'data:image/webp;base64,UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAAEX/I/of'],
  ])('accepts %s', (_label, value) => {
    expect(updateProfileSchema.safeParse({ avatarOverride: value }).success).toBe(true)
  })

  it('rejects http:// (insecure)', () => {
    const r = updateProfileSchema.safeParse({ avatarOverride: 'http://evil.example.com/x.png' })
    expect(r.success).toBe(false)
  })

  it('rejects data:text/html (XSS payload)', () => {
    const r = updateProfileSchema.safeParse({
      avatarOverride: 'data:text/html,<script>alert(1)</script>',
    })
    expect(r.success).toBe(false)
  })

  it('rejects data:application/json (non-image)', () => {
    const r = updateProfileSchema.safeParse({
      avatarOverride: 'data:application/json;base64,eyJhIjoxfQ==',
    })
    expect(r.success).toBe(false)
  })

  it('rejects data:image/svg+xml (SVG can carry <script>)', () => {
    const r = updateProfileSchema.safeParse({
      avatarOverride: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg==',
    })
    expect(r.success).toBe(false)
  })

  it('rejects plain string', () => {
    expect(updateProfileSchema.safeParse({ avatarOverride: 'just-a-string' }).success).toBe(false)
  })

  it('rejects javascript: URL', () => {
    expect(updateProfileSchema.safeParse({ avatarOverride: 'javascript:alert(1)' }).success).toBe(false)
  })

  it('accepts null (clears the override)', () => {
    expect(updateProfileSchema.safeParse({ avatarOverride: null }).success).toBe(true)
  })

  it('rejects oversize payload (> 1.5 MB)', () => {
    const oversize = 'data:image/png;base64,' + 'A'.repeat(1_500_001)
    expect(updateProfileSchema.safeParse({ avatarOverride: oversize }).success).toBe(false)
  })

  it('exports AVATAR_OVERRIDE_PATTERN for reuse', () => {
    expect(AVATAR_OVERRIDE_PATTERN.test('https://example.com/x.png')).toBe(true)
    expect(AVATAR_OVERRIDE_PATTERN.test('data:image/png;base64,AAAA')).toBe(true)
    expect(AVATAR_OVERRIDE_PATTERN.test('data:image/svg+xml,...')).toBe(false)
  })
})
