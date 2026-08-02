/**
 * transaction-read-guard.spec.ts — static-analysis guard for the
 * transaction-visibility.util.ts single-choke-point invariant.
 *
 * security-review PR #456 (verdict BLOCK on `5cf6d3c6`): HIGH-1 (invoices),
 * HIGH-2 (company-account deposits) and HIGH-3 (three write paths inside
 * `TransactionsService` itself) all had the SAME shape — a raw read of the
 * `transactions` table that forgot to exclude/gate a soft-deleted row. The
 * fix (`transaction-visibility.util.ts`) only holds if every FUTURE read
 * routes through it too — a human reviewer noticing the pattern is exactly
 * what already failed three times in this one PR. This spec is the
 * mechanical backstop: it fails the moment a NEW raw read of `transactions`
 * appears anywhere in `apps/api/src` without a guard token nearby, instead
 * of relying on the next reviewer to remember to check.
 *
 * MECHANISM
 *   1. Scan every non-spec `.ts` file under `apps/api/src` for the shapes
 *      that read the `transactions` table:
 *        - `.query.transactions.findFirst(` / `.findMany(`
 *        - `.from(transactions)`
 *        - `.leftJoin(transactions` / `.innerJoin(transactions`
 *        - a raw `${transactions}` reference inside a `sql` template
 *   2. For each match, look at a window of surrounding source (5 lines
 *      before, 30 after — generous enough to cover this codebase's
 *      `where: and(...)` formatting) and PASS if it contains a guard token:
 *      `assertTransactionVisible` / `assertTransactionNotDeleted` /
 *      `assertTransactionWritable` / `TRANSACTION_NOT_DELETED`, or a literal
 *      `deletedAt` / `deleted_at` (covers a hand-written
 *      `isNull(transactions.deletedAt)` right in the same `where`).
 *   3. Anything left over must be an explicit, reasoned ALLOWLIST entry below
 *      (idempotency-by-key/hash lookups and reads of rows a sibling DB
 *      constraint already makes un-deletable — both verified during the PR
 *      #456 review, see each entry's `reason`). Matched by the read's
 *      ENCLOSING function name (found by scanning upward for the nearest
 *      method/function declaration), not by line number — line numbers drift
 *      with every unrelated edit, function names do not.
 *   4. Anything STILL left over fails the test with file:line:snippet.
 *   5. Every allowlist entry must be exercised at least once — an entry that
 *      matches nothing is stale (the guarded call it described was removed
 *      or renamed) and would silently widen the allowlist for the next
 *      genuinely-new violation that happens to land in the same function.
 *
 * This is deliberately a plain-text scan, not an AST/type-aware check — no
 * new dependency, runs in milliseconds, and is exactly precise enough for
 * "did anyone add a raw read without thinking about deletedAt", which is a
 * textual pattern, not a semantic one.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

// apps/api/src — this spec lives in apps/api/src/finance.
const API_SRC = join(__dirname, '..')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'test'])
// Definitions / infra, not read-site call code.
const SKIP_FILES = new Set([
  join(API_SRC, 'finance', 'transaction-visibility.util.ts'),
  join(API_SRC, 'finance', 'transaction-read-guard.spec.ts'),
  join(API_SRC, 'database', 'schema.ts'),
])

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) listTsFiles(full, out)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    if (entry.endsWith('.spec.ts') || entry.endsWith('.d.ts')) continue
    if (SKIP_FILES.has(full)) continue
    out.push(full)
  }
  return out
}

// ── Read-site patterns (global, so exec() walks every match in the file) ──
const READ_PATTERNS: RegExp[] = [
  /\.query\.transactions\.(?:findFirst|findMany)\s*\(/g,
  /\.from\(\s*transactions\s*\)/g,
  /\.(?:leftJoin|innerJoin)\(\s*transactions\b/g,
  /\$\{transactions\}/g,
]

const GUARD_TOKEN =
  /assertTransactionVisible|assertTransactionNotDeleted|assertTransactionWritable|TRANSACTION_NOT_DELETED|deletedAt|deleted_at/

// JS/TS keywords that syntactically look like `name(` but are not a
// function/method declaration — must NOT be mistaken for the enclosing
// function while scanning upward.
const CONTROL_FLOW_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'typeof',
  'new',
  'await',
  'function',
  'else',
  'do',
  'delete',
  'void',
  'yield',
])

const FUNCTION_DECL = new RegExp(
  '^(\\s*)(?:export\\s+)?(?:private\\s+|public\\s+|protected\\s+)?(?:static\\s+)?' +
    '(?:async\\s+)?(?:function\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(',
)

// Method/function DECLARATIONS in this codebase sit at top-of-class (2-space)
// or top-of-file (0-space) indentation. A plain expression CALL that happens
// to have the same `name(` shape — `eq(transactions.type, …)`, `and(…)`,
// `isNull(…)` inside a `where:` clause — is always nested several levels
// deeper. Capping the accepted indent is what tells `submitDeposit(` (real
// declaration) apart from `eq(transactions.type, …)` (a drizzle helper CALL
// that is textually indistinguishable from a declaration otherwise).
const MAX_DECL_INDENT = 4

/** Nearest enclosing method/function declaration above `matchLine` (0-indexed), scanning upward. */
function findEnclosingFunction(
  lines: string[],
  matchLine: number,
): { name: string; startLine: number } | null {
  for (let i = matchLine; i >= 0 && i >= matchLine - 1500; i--) {
    const m = FUNCTION_DECL.exec(lines[i] ?? '')
    FUNCTION_DECL.lastIndex = 0
    if (m && m[1]!.length <= MAX_DECL_INDENT && !CONTROL_FLOW_KEYWORDS.has(m[2]!)) {
      return { name: m[2]!, startLine: i }
    }
  }
  return null
}

interface AllowlistEntry {
  file: string // suffix of the relative path from apps/api/src, e.g. 'finance/transactions.service.ts'
  functionName: string
  reason: string
}

// ── Verified-safe exceptions (security-review PR #456) ─────────────────────
const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'finance/transactions.service.ts',
    functionName: 'describeReferent',
    reason:
      'Reads a PAYOUT row (adminDeleteTransaction refuses to soft-delete PAYOUT/' +
      'PAYOUT_ADMIN/PAYOUT_CONFIRMED) or a generic settlement-completeness lookup by an ' +
      'already-known reference id — read-only diagnostic data, never a money decision.',
  },
  {
    file: 'finance/transactions.service.ts',
    functionName: 'confirmPayout',
    reason:
      'Operates on PAYOUT / PAYOUT_CONFIRMED rows, which adminDeleteTransaction can never ' +
      'soft-delete; the second read re-fetches a row this same call just inserted.',
  },
  {
    file: 'finance/transactions.service.ts',
    functionName: 'applyPayoutPaidCascade',
    reason:
      'Reads/updates rows already linked via payoutRequestId (shared by payPayoutRequest and ' +
      'manualConfirmPayout, on an already-validated PENDING payout_request) — ' +
      'adminDeleteTransaction refuses to delete any transaction with payoutRequestId set, so ' +
      'these can never be soft-deleted.',
  },
  {
    file: 'finance/transactions.service.ts',
    functionName: 'getDropSelfPayments',
    reason: 'Lists only type=PAYOUT rows, which adminDeleteTransaction can never soft-delete.',
  },
  {
    file: 'finance/transactions.service.ts',
    functionName: 'declareUsdtProjectIncome',
    reason:
      'idempotencyKey replay lookup + the post-conflict "committed winner" re-read — both ' +
      'MUST still see a soft-deleted row, or a retried request could double-submit past a ' +
      'deleted duplicate. The row ultimately returned to the caller goes through findOne, ' +
      'which applies assertTransactionVisible.',
  },
  {
    file: 'finance/pending-settlement.service.ts',
    functionName: 'resolveSource',
    reason:
      'Reads pending_obligations.source_transaction_id — adminDeleteTransaction refuses to ' +
      'delete a transaction any (open or closed) obligation still references as its source.',
  },
  {
    file: 'finance/pending-settlement.service.ts',
    functionName: 'denormalise',
    reason: 'Same source_transaction_id guarantee as resolveSource; display-only denormalisation.',
  },
  {
    file: 'finance/company-account.service.ts',
    functionName: 'submitDeposit',
    reason:
      'txHash idempotency lookup ("existing") + the post-conflict "winner" re-read — a ' +
      'soft-deleted deposit must still block hash reuse, or a retry could re-spend a claimed hash.',
  },
  {
    file: 'finance/company-account.service.ts',
    functionName: 'createDividend',
    reason:
      'idempotencyKey replay lookup + post-conflict re-read, same reasoning as submitDeposit.',
  },
]

interface Violation {
  file: string
  line: number
  snippet: string
}

describe('transaction-read-guard — every raw `transactions` read routes through the shared guard', () => {
  const files = listTsFiles(API_SRC)
  const violations: Violation[] = []
  const usedAllowlist = new Set<number>()

  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')
    const relFile = relative(API_SRC, file).split('\\').join('/') // POSIX-normalise for Windows dev

    for (const pattern of READ_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(content))) {
        const upToMatch = content.slice(0, match.index)
        const lineIdx = upToMatch.split('\n').length - 1 // 0-indexed

        const enclosing = findEnclosingFunction(lines, lineIdx)
        // Guard-token window spans the WHOLE enclosing function (its
        // declaration line through a little past the read) rather than a
        // fixed line count — conditions built once at the top of a method
        // (`const baseConditions = [...]`, `TRANSACTION_NOT_DELETED` pushed
        // in early, consumed by `.from(transactions)` dozens of lines later)
        // are a real pattern in this codebase, and a small fixed window would
        // false-positive exactly there. Falls back to a fixed nearby window
        // when no enclosing declaration is found (e.g. a bare `.from(...)`
        // inside a free-standing arrow function).
        const windowStart = enclosing ? enclosing.startLine : Math.max(0, lineIdx - 5)
        const windowEnd = Math.min(lines.length, lineIdx + 30)
        const window = lines.slice(windowStart, windowEnd).join('\n')

        if (GUARD_TOKEN.test(window)) continue // guarded — pass

        const allowIdx = ALLOWLIST.findIndex(
          (a) => relFile.endsWith(a.file) && a.functionName === enclosing?.name,
        )
        if (allowIdx !== -1) {
          usedAllowlist.add(allowIdx)
          continue
        }

        violations.push({
          file: relFile,
          line: lineIdx + 1,
          snippet: (lines[lineIdx] ?? '').trim(),
        })
      }
    }
  }

  it('has no unguarded raw reads of the transactions table', () => {
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} — ${v.snippet}`).join('\n')
      expect.fail(
        `Found ${violations.length} raw read(s) of the \`transactions\` table with no ` +
          `deleted-row guard nearby and no ALLOWLIST entry:\n${report}\n\n` +
          `Fix: route through transaction-visibility.util.ts (assertTransactionVisible / ` +
          `assertTransactionNotDeleted / assertTransactionWritable / TRANSACTION_NOT_DELETED), ` +
          `or — if this read is genuinely safe by construction (idempotency-by-hash, a row a ` +
          `DB-adjacent guard already makes un-deletable) — add a reasoned entry to ALLOWLIST in ` +
          `this spec.`,
      )
    }
  })

  it('every ALLOWLIST entry is still exercised (no stale exceptions)', () => {
    const stale = ALLOWLIST.filter((_, i) => !usedAllowlist.has(i))
    if (stale.length > 0) {
      const report = stale.map((a) => `  ${a.file} :: ${a.functionName}`).join('\n')
      expect.fail(
        `${stale.length} ALLOWLIST entr${stale.length === 1 ? 'y matches' : 'ies match'} ` +
          `nothing anymore (the read it described was removed, guarded, or renamed) — remove ` +
          `it so the allowlist cannot silently cover a future unrelated violation:\n${report}`,
      )
    }
  })
})
