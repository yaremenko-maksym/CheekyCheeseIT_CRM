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

// ---------------------------------------------------------------------------
// task-candidate-card-resume §3 / code-review round 2 — a STRICTER sibling
// to `tgUrl` above, for values that come from genuinely untrusted input (an
// anonymous public form's free-text field) rather than a CRM user profile
// field. `tgUrl` always returns SOME link (best-effort — it never rejects);
// `safeTelegramHref` validates the shape first and returns `undefined` for
// anything that doesn't look like a real Telegram username, so the caller
// can fall back to plain, non-clickable text instead of building a link out
// of arbitrary free text. Reused (not duplicated) across every telegram-link
// call site that renders untrusted-ish input: CandidateCard.tsx (public
// vacancy-apply form), UserProfileHeader.tsx / UserRow.tsx (CRM-internal
// user profile — lower risk, but the same guard closes the same class of
// footgun rather than leaving one validated path next to unvalidated ones).
// ---------------------------------------------------------------------------

/** Telegram's own public-username rule: 5-32 chars, starts with a letter, then letters/digits/underscores. */
const TELEGRAM_HANDLE_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/

/**
 * Strips one optional leading `@` and validates what remains against
 * Telegram's public-username format. Returns a `https://t.me/<handle>` URL
 * when valid, otherwise `undefined` — callers render the raw value as plain
 * text (non-clickable) for anything that fails the check.
 */
export function safeTelegramHref(value: string): string | undefined {
  const handle = value.startsWith('@') ? value.slice(1) : value
  return TELEGRAM_HANDLE_RE.test(handle) ? `https://t.me/${handle}` : undefined
}
