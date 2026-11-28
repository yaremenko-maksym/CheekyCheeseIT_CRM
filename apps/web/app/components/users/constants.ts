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
  // A fast path only: with an empty `q` every `includes(q)` below is true anyway.
  // Stryker disable next-line ConditionalExpression: equivalent mutant — skipping this early return still returns true, because includes('') holds for every field
  if (!q) return true
  // An absent field contributes no haystack at all (a `?? ''` fallback is one typo away from a
  // placeholder that matches real queries), so the optional chain decides it rather than a literal.
  const has = (text: string | null | undefined) => !!text && text.toLowerCase().includes(q)
  const techStack = Array.isArray(u.techStack) ? u.techStack.join(', ') : u.techStack
  return (
    has(u.displayName) ||
    has(u.email) ||
    has(u.telegram) ||
    has(techStack) ||
    // No `?? []`: the DTO schema carries `.default([])`, so a parsed profile always has the array.
    u.technicalRoles.some((r) => has(r) || has(label(r)))
  )
}
