import type { TechnicalRole, UserProfileDto } from '@crm/shared'

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

/** The fields the users-list search box matches on. */
export type UserSearchable = Pick<
  UserProfileDto,
  'displayName' | 'email' | 'telegram' | 'techStack' | 'technicalRoles'
>

/**
 * The users-list search predicate. Technical roles match on both the stored key
 * (`BACKEND_ENGINEER`) and the label the row actually renders (SPEC-M-1) — what the user
 * reads is what they can search for. `label` is the caller's localized resolver: the
 * catalog lives in the React tree, so this stays pure.
 */
export function matchesUserQuery(
  u: UserSearchable,
  query: string,
  label: (role: TechnicalRole) => string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const techStack = Array.isArray(u.techStack) ? u.techStack.join(', ') : (u.techStack ?? '')
  return (
    u.displayName.toLowerCase().includes(q) ||
    u.email.toLowerCase().includes(q) ||
    (u.telegram ?? '').toLowerCase().includes(q) ||
    techStack.toLowerCase().includes(q) ||
    (u.technicalRoles ?? []).some(
      (r) => r.toLowerCase().includes(q) || label(r).toLowerCase().includes(q),
    )
  )
}
