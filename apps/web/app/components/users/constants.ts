export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

export const ROLE_VARIANT: Record<string, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
}

export const ROLES = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'] as const
export type Role = (typeof ROLES)[number]

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
