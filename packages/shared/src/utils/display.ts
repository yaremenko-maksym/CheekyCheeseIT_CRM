import type { Role } from '../types/roles'

/**
 * Returns up to 2 uppercase initials from a display name.
 * Used as Avatar fallback when photo is unavailable.
 */
export function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('')
}

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  SENIOR: 'Senior',
  JUNIOR: 'Junior',
  HR: 'HR',
  ACCOUNTANT: 'Accountant',
}

/** Converts a role enum value to a human-readable label. */
export function formatRole(role: Role): string {
  return ROLE_LABELS[role]
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USDT: 'USDT',
  USD: '$',
  EUR: '€',
}

/**
 * Formats a numeric amount with currency symbol.
 * Unknown currencies fall back to the currency code.
 */
export function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

  // Prefix for fiat symbols, suffix for crypto codes
  return symbol.length <= 1 ? `${symbol}${formatted}` : `${formatted} ${symbol}`
}
