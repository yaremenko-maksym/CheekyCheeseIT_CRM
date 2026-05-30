export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
  // Drop role - phase 1: финансовая прокладка через чью-то команду.
  DROP: 'Дроп',
}

export const ROLE_VARIANT: Record<
  string,
  'admin' | 'senior' | 'junior' | 'hr' | 'accountant' | 'drop'
> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
  DROP: 'drop',
}

export const ROLES = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const
export type Role = (typeof ROLES)[number]

/**
 * Roles available in CREATE dialog. ADMIN is intentionally excluded — the
 * platform has a fixed pool of two admins; new admins must be provisioned
 * via DB seed, not through the UI. Backend mirrors this in POST /users.
 *
 * DROP is now allowed — `UserDialog` adapts to expose the drop-share
 * slider + mandatory team section when DROP is picked, and submits to
 * `POST /api/users/drops` which provisions the drop-team atomically.
 */
export const CREATE_ALLOWED_ROLES = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const
export type CreateAllowedRole = (typeof CREATE_ALLOWED_ROLES)[number]

export type SortKey = 'displayName' | 'role' | 'email' | 'createdAt'
export type SortDir = 'asc' | 'desc'

/**
 * Avatar initials for a user.
 *
 * - "" or whitespace-only → "?"
 * - "Иван Иванов" → "ИИ"
 * - "Anna" (single word) → "AN" (first two letters, uppercased)
 * - "  John   Doe   " (extra whitespace) → "JD"
 */
export function getInitials(name: string) {
  const trimmed = (name || '?').trim()
  if (!trimmed || trimmed === '?') return '?'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase()
  return parts
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export function normalizeTelegram(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}
