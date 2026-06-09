/**
 * Build a canonical `https://t.me/<handle>` URL from any stored Telegram
 * value — which may arrive as:
 *   - a bare handle:        `username`          → `https://t.me/username`
 *   - a handle with @:     `@username`          → `https://t.me/username`
 *   - already a full URL:  `https://t.me/chat` → `https://t.me/chat` (pass-through)
 *
 * Mirrors the pattern used in `UserProfileHeader.tsx` and `UserRow.tsx`.
 */
export function tgUrl(value: string): string {
  if (value.startsWith('https://')) return value
  return `https://t.me/${value.replace(/^@/, '')}`
}

/**
 * Derive a display label `@handle` from any stored Telegram value.
 *
 *   `@username`           → `@username`
 *   `username`            → `@username`
 *   `https://t.me/chat`   → `@chat`
 */
export function tgDisplay(value: string): string {
  if (value.startsWith('https://t.me/')) return `@${value.slice('https://t.me/'.length)}`
  return value.startsWith('@') ? value : `@${value}`
}
