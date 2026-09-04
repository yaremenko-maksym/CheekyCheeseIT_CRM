/**
 * user_emails writer inventory — security-review PR #623 (SR-H-3, HIGH).
 *
 * `UsersService.upsertWorkEmail`'s own docblock states a rule: every writer
 * of `users.email` also writes the matching `user_emails` WORK row, or is
 * named as a documented exception. That rule was ALREADY VIOLATED at the
 * moment it was written — `apps/api/src/database/seed.ts`'s bulk
 * `db.insert(schema.users).values(SEED_USERS)` bypasses `UsersService`
 * entirely (fixture data, not a request path) and, before this fix, left
 * `user_emails` empty after every `db:seed`. Nothing enumerated the
 * writers, so nothing caught it — the docblock listed three methods on
 * `UsersService` and simply never looked outside that one file. Two E2E
 * shards went red on `dev-login … 404` before a human found it.
 *
 * This is the exact defect class `archived-entitlement.unit.spec.ts`
 * already treats as a solved problem for a DIFFERENT invariant (which
 * columns decide what an employee is owed) — same mechanism, ported here:
 * scan every `.insert(users)` / `.insert(schema.users)` call site in
 * `apps/api/src` (a NEW `users` row is the only place `users.email` can be
 * set without going through `UsersService.adminUpdateUser`, which already
 * calls `upsertWorkEmail` via the choke point `updateUserRow` guards), and
 * compare the whole SET against an explicit inventory below. An unlisted
 * writer is a new, unguarded door into `users.email` with no
 * `user_emails` counterpart. A listed one that has vanished means the
 * inventory describes code that is gone — fails in BOTH directions, same
 * as the precedent.
 *
 * Scope: INSERT only. Every `.update(users)` writer in this codebase is
 * already exhaustively enumerated by `archived-entitlement.unit.spec.ts`
 * (a stricter, pre-existing check covering EVERY update to the table, not
 * just email) — of that enumerated set, `updateUserRow` is the only one
 * that can ever touch `email` (called by `UsersService.adminUpdateUser`,
 * which pairs it with `upsertWorkEmail` in the same transaction — see that
 * method). Re-scanning updates here would duplicate a check that already
 * exists and is already stricter.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('user_emails writer inventory — every `.insert(users)` pairs with a user_emails row', () => {
  /**
   * Every `<relative path>::<method>` that issues `db.insert(users)` (or
   * the `schema.users` form seed.ts uses), with why it is allowed to exist
   * without this scanner also finding a `user_emails` insert next to it —
   * because it either handles user_emails ITSELF (checked by its own
   * test/spec, referenced here) or is not a real request path.
   */
  const KNOWN_USERS_EMAIL_WRITERS: Record<string, string> = {
    'users/users.service.ts::createUser':
      'wraps users+user_emails(WORK[+PERSONAL]) inserts in one transaction — users.service.spec.ts "user_emails writes (§4.4)"',
    'users/users.service.ts::createDrop':
      'already tx-wrapped; WORK insert via writeUserEmailOrConflict — users.drop.spec.ts',
    'database/seed.ts::main':
      'fixture data, not a request path — inserts a matching user_emails WORK row for every SEED_USERS entry immediately after (see that file)',
  }

  const SRC_ROOT = path.resolve(import.meta.dirname, '..')

  /**
   * Two SEPARATE, non-overlapping patterns rather than one combined regex
   * (archived-entitlement.unit.spec.ts only ever scans class files, so its
   * single class-member pattern is enough there):
   *   - TOP_FUNCTION: a top-level `function name(` at column 0 (seed.ts's
   *     `async function main()`).
   *   - CLASS_METHOD: a class member at exactly two-space indent — ONLY
   *     applied once the file has shown a `class` keyword at column 0.
   *     Without that gate, a plain statement call at the same indent as a
   *     top-level function's BODY (e.g.
   *     `  assertSeedTargetIsDisposable(url, env)` inside seed.ts's
   *     `main`) matches the bare `NAME(` shape just as well as a real
   *     class-member declaration does (both are "two spaces, identifier,
   *     open paren" — a multi-line method signature like `updateUserRow(`
   *     ending in a bare `(` with no trailing `{` is indistinguishable
   *     from a bare statement call by shape alone), silently reassigning
   *     `method` mid-function. Gating on "have we seen `class`" is exact
   *     for THIS repo's two file shapes (a class file never has a
   *     misleading two-space statement between methods; a script file
   *     never declares a class) rather than a shape heuristic that would
   *     have to guess right on both.
   */
  function collectUsersInsertWriters(): Record<string, string> {
    const TOP_FUNCTION = /^(?:export )?(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(/
    const CLASS_DECL = /^(?:export )?(?:default )?(?:abstract )?class\s+[A-Za-z_$]/
    const CLASS_METHOD =
      /^ {2}(?:private |public |protected |readonly |static )*(?:async )?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/
    const out: Record<string, string> = {}

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) return walk(full)
        return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : []
      })

    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/')
      let method: string | null = null
      let inBlockComment = false
      let sawClass = false

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const trimmed = line.trim()
          if (inBlockComment) {
            if (trimmed.includes('*/')) inBlockComment = false
            return
          }
          if (trimmed.startsWith('/*')) {
            if (!trimmed.includes('*/')) inBlockComment = true
            return
          }
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return

          if (CLASS_DECL.test(line)) sawClass = true

          const topMatch = TOP_FUNCTION.exec(line)
          if (topMatch?.[1]) {
            method = topMatch[1]
          } else if (sawClass) {
            const classMatch = CLASS_METHOD.exec(line)
            if (classMatch?.[1]) method = classMatch[1]
          }
          if (/\.insert\(\s*(?:schema\.)?users\s*\)/.test(line)) {
            out[`${rel}::${method ?? '<top-level>'}`] = `${rel}:${index + 1}`
          }
        })
    }
    return out
  }

  it('every `.insert(users)` in apps/api/src belongs to a method on the inventory', () => {
    const actual = collectUsersInsertWriters()

    // Fails in BOTH directions on purpose — see the module docblock.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(KNOWN_USERS_EMAIL_WRITERS).sort())
  })

  it('the scan is not vacuous — it really locates createUser', () => {
    // A scanner that silently found nothing would make the test above pass
    // by comparing two empty sets. Pin the one entry whose absence means
    // the parse broke rather than the code changed.
    const actual = collectUsersInsertWriters()
    expect(actual['users/users.service.ts::createUser']).toMatch(/^users\/users\.service\.ts:\d+$/)
    expect(Object.keys(actual)).toHaveLength(Object.keys(KNOWN_USERS_EMAIL_WRITERS).length)
  })
})
