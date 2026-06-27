import { describe, expect, it } from 'vitest'
import {
  notificationListFiltersSchema,
  notificationSchema,
  notificationTypeSchema,
  notificationsListResponseSchema,
  safeNotificationLinkSchema,
} from './notifications'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const datetime = '2026-05-26T14:30:00.000Z'

const validNotification = {
  id: uuid,
  type: 'INVOICE_SIGN_REQUIRED' as const,
  title: 'Инвойс ожидает вашей подписи',
  body: 'Контрагент CheekyCheese IT подписал инвойс по проекту Acme Corp.',
  link: '/crm/finance/invoices/123e4567-e89b-12d3-a456-426614174000',
  readAt: null,
  createdAt: datetime,
}

describe('notificationTypeSchema', () => {
  it('accepts known types', () => {
    expect(() => notificationTypeSchema.parse('INVOICE_SIGN_REQUIRED')).not.toThrow()
    expect(() => notificationTypeSchema.parse('INVOICE_SIGNED')).not.toThrow()
  })

  it('rejects unknown types', () => {
    expect(() => notificationTypeSchema.parse('SYSTEM_MAINTENANCE')).toThrow()
    expect(() => notificationTypeSchema.parse('invoice_signed')).toThrow()
  })
})

describe('notificationSchema', () => {
  it('accepts a valid unread notification', () => {
    expect(() => notificationSchema.parse(validNotification)).not.toThrow()
  })

  it('accepts a read notification (readAt set)', () => {
    expect(() => notificationSchema.parse({ ...validNotification, readAt: datetime })).not.toThrow()
  })

  it('accepts null body + null link (minimal payload)', () => {
    expect(() =>
      notificationSchema.parse({ ...validNotification, body: null, link: null }),
    ).not.toThrow()
  })

  it('rejects empty title (1 char minimum)', () => {
    expect(() => notificationSchema.parse({ ...validNotification, title: '' })).toThrow()
  })

  it('rejects link longer than 500 chars', () => {
    // 501 'a' chars: fails both the max(500) and the relative-path refine
    expect(() =>
      notificationSchema.parse({ ...validNotification, link: 'a'.repeat(501) }),
    ).toThrow()
  })

  it('rejects external http link (open-redirect risk)', () => {
    expect(() =>
      notificationSchema.parse({ ...validNotification, link: 'http://evil.com/phish' }),
    ).toThrow()
  })

  it('rejects link with javascript: scheme (XSS risk)', () => {
    expect(() =>
      notificationSchema.parse({ ...validNotification, link: 'javascript:alert(1)' }),
    ).toThrow()
  })

  it('rejects link without leading slash', () => {
    expect(() =>
      notificationSchema.parse({ ...validNotification, link: 'finance/invoices/123' }),
    ).toThrow()
  })

  it('accepts valid relative link starting with /', () => {
    expect(() =>
      notificationSchema.parse({ ...validNotification, link: '/finance/invoices/abc' }),
    ).not.toThrow()
  })

  it('rejects unknown type', () => {
    expect(() =>
      notificationSchema.parse({ ...validNotification, type: 'PUSH_NEW_FEATURE' }),
    ).toThrow()
  })

  it('rejects non-uuid id', () => {
    expect(() => notificationSchema.parse({ ...validNotification, id: 'not-uuid' })).toThrow()
  })
})

describe('notificationsListResponseSchema', () => {
  it('accepts empty list with unreadCount = 0', () => {
    expect(() => notificationsListResponseSchema.parse({ items: [], unreadCount: 0 })).not.toThrow()
  })

  it('accepts populated list with positive unreadCount', () => {
    expect(() =>
      notificationsListResponseSchema.parse({
        items: [validNotification],
        unreadCount: 5,
      }),
    ).not.toThrow()
  })

  it('rejects negative unreadCount', () => {
    expect(() => notificationsListResponseSchema.parse({ items: [], unreadCount: -1 })).toThrow()
  })

  it('rejects non-integer unreadCount', () => {
    expect(() => notificationsListResponseSchema.parse({ items: [], unreadCount: 1.5 })).toThrow()
  })
})

// ── safeNotificationLinkSchema ────────────────────────────────────────────────

describe('safeNotificationLinkSchema', () => {
  it('accepts null', () => {
    expect(() => safeNotificationLinkSchema.parse(null)).not.toThrow()
  })

  it('accepts a relative path starting with /', () => {
    expect(() => safeNotificationLinkSchema.parse('/finance/invoices/abc')).not.toThrow()
  })

  it('accepts a deeply nested relative path', () => {
    expect(() => safeNotificationLinkSchema.parse('/admin/users/some-uuid/contract')).not.toThrow()
  })

  it('rejects http:// external URL', () => {
    expect(() => safeNotificationLinkSchema.parse('http://evil.com')).toThrow()
  })

  it('rejects https:// external URL', () => {
    expect(() => safeNotificationLinkSchema.parse('https://evil.com')).toThrow()
  })

  it('rejects javascript: URI', () => {
    expect(() => safeNotificationLinkSchema.parse('javascript:alert(1)')).toThrow()
  })

  it('rejects JAVASCRIPT: URI (case-insensitive)', () => {
    expect(() => safeNotificationLinkSchema.parse('JAVASCRIPT:void(0)')).toThrow()
  })

  it('rejects path without leading slash', () => {
    expect(() => safeNotificationLinkSchema.parse('finance/invoices')).toThrow()
  })

  it('rejects link exceeding 500 chars', () => {
    expect(() => safeNotificationLinkSchema.parse('/' + 'a'.repeat(500))).toThrow()
  })

  // MED-1: protocol-relative and backslash open-redirect vectors
  it('MED-1: rejects protocol-relative URL //evil.com (open-redirect)', () => {
    expect(() => safeNotificationLinkSchema.parse('//evil.com')).toThrow()
  })

  it('MED-1: rejects backslash-relative /\\evil.com (IE/Edge normalise to //)', () => {
    expect(() => safeNotificationLinkSchema.parse('/\\evil.com')).toThrow()
  })

  it('MED-1: accepts a true internal path /valid/path (single slash)', () => {
    expect(() => safeNotificationLinkSchema.parse('/valid/path')).not.toThrow()
  })

  it('MED-1: still rejects javascript: scheme', () => {
    expect(() => safeNotificationLinkSchema.parse('javascript:alert(1)')).toThrow()
  })
})

// ── notificationListFiltersSchema ─────────────────────────────────────────────

describe('notificationListFiltersSchema', () => {
  it('defaults unreadOnly=false and limit=10', () => {
    const parsed = notificationListFiltersSchema.parse({})
    expect(parsed.unreadOnly).toBe(false)
    expect(parsed.limit).toBe(10)
  })

  it('accepts unreadOnly=true and custom limit', () => {
    expect(() => notificationListFiltersSchema.parse({ unreadOnly: true, limit: 50 })).not.toThrow()
  })

  it('rejects limit > 100', () => {
    expect(() => notificationListFiltersSchema.parse({ limit: 101 })).toThrow()
  })

  it('rejects negative limit', () => {
    expect(() => notificationListFiltersSchema.parse({ limit: -1 })).toThrow()
  })

  it('rejects zero limit', () => {
    expect(() => notificationListFiltersSchema.parse({ limit: 0 })).toThrow()
  })
})
