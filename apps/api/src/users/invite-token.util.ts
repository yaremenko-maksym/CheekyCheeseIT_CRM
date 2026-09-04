/**
 * task-user-emails-invite (position 2, continued) — one-time invite token
 * primitives, split out of `UsersService` as pure functions so the token
 * shape (256-bit random, sha256-hashed at rest) is testable in isolation
 * and reused identically by both the create-time invite and the admin
 * resend action (single place a future change to the token format has to
 * touch, mirroring `invoice-pdf.utils.ts`'s existing sha256 convention in
 * this codebase — see that file's `hashPdfBuffer`).
 */
import { createHash, randomBytes } from 'node:crypto'

/**
 * 7 days (task §1 — "Это моё допущение, а не решение владельца"). A
 * personal address is entered once by ADMIN and the invite email lands in
 * a mailbox this app does not control — long enough that a person back
 * from a few days off still finds a live link, short enough that a stale,
 * unopened invite does not sit as a permanently-valid credential in
 * someone else's inbox forever. Revisit if the owner says otherwise; the
 * "resend" action (task §5) is the escape hatch for "the link died before
 * I got to it".
 */
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 256 bits of randomness, hex-encoded (64 chars) — this is the value that
 * goes into the email link and NEVER touches the database; only its hash
 * (below) is stored. Matches the width `randomBytes(16)` already uses for
 * the OAuth `state` cookie in `auth.controller.ts`, doubled: this token is
 * a bearer credential with a 7-day lifetime (the OAuth state is single-
 * request, ~10 minutes), so it gets a wider margin.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * sha256 of the raw token, hex-encoded — the ONLY form that ever reaches
 * the database (`userEmailInvites.tokenHash`, schema.ts). A DB read alone
 * (backup, replica, compromised credential) must not be enough to mint a
 * working invite link.
 */
// Equivalent mutant, verified by hand: `Hash.update(data, '')` behaves
// IDENTICALLY to `Hash.update(data, 'utf8')` in Node — empty-string encoding
// falls back to utf8 (`createHash('sha256').update(x,'utf8').digest('hex')
// === createHash('sha256').update(x,'').digest('hex')` for the same `x`), so
// no test — this one or any other — could ever tell the two apart.
// `hash.update(...)` is pulled out onto its own STATEMENT (not chained off
// `createHash(...)`) — Stryker's `// Stryker disable next-line` directive is
// resolved by its instrumenter against the next STATEMENT, and a mutant
// inside a multi-line chained-call expression (`createHash('sha256')
// .update(...).digest(...)`, tried first) did not line up with the
// directive the same way; a bare statement does (verified: the mutant now
// reports `Ignored`, not `Survived`). `hash.update()` returns the Hash
// instance (for chaining) — the return value is intentionally discarded
// here; `.digest('hex')` still reads the same accumulated state.
export function hashInviteToken(rawToken: string): string {
  const hash = createHash('sha256')
  // Stryker disable next-line StringLiteral: see the comment above this function
  hash.update(rawToken, 'utf8')
  return hash.digest('hex')
}
