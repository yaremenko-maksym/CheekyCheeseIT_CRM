/**
 * task-drop-sees-own-obligations (security-review PR #523 round 1 MED-2,
 * round 2 MED-7). Shared between `transactions.drop-self-feeds.spec.ts` and
 * `transactions.drop-self-summary.spec.ts` — both need to prove what a
 * Drizzle `where` clause actually BINDS, not just what rows a mocked
 * `findMany` happens to return regardless of it.
 *
 * Why this exists at all: a mocked-DB unit test whose `findMany` stub
 * ignores its `where` argument and just returns canned rows is blind to the
 * WHERE clause's own correctness — a mutated/narrowed/widened predicate
 * would never be observed, because the stub returns the same canned rows no
 * matter what `where` object it was called with. `where` IS still a REAL
 * Drizzle SQL fragment in that call (only the query EXECUTOR is stubbed,
 * not the query-builder — `transactions`/`users` etc. are the actual
 * imported schema tables), so capturing and walking it is possible without
 * a live Postgres connection.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

/**
 * Walk a Drizzle `where` AST and collect the BOUND runtime values it
 * carries — i.e. every `Param { value, encoder }` node (Drizzle's wrapper
 * for a value that will become a `$1`/`$2`/… placeholder), not every string
 * reachable anywhere in the tree.
 *
 * Why not a generic string walk (tried first, empirically wrong): a
 * `PgEnumColumn` (e.g. `transactions.type`) carries `enumValues` — the FULL
 * static list of every value the Postgres enum can ever hold (every
 * transaction type, not just the ones THIS query filters on) — as a plain
 * property on the column reference embedded in the AST. A naive walk that
 * collects every string it meets picks up `enumValues` too, so it "finds"
 * every transaction type regardless of what `inArray(...)`/`eq(...)`
 * actually bound — i.e. it can never fail, so it can never kill a mutant.
 * Verified by `util.inspect`-dumping the real AST these services build:
 * bound values show up as `Param` nodes, siblings to — never inside — a
 * `PgEnumColumn`'s `enumValues`. Restricting collection to `Param`-shaped
 * nodes (`'value' in obj && 'encoder' in obj`, matching the class's real
 * shape) reads only what was actually bound.
 */
export function collectParamValues(node: unknown, visited = new Set<unknown>()): unknown[] {
  if (node === null) return []
  // Stryker disable next-line EqualityOperator,ConditionalExpression: a PROVABLY equivalent mutant, not an untested one — `typeof node !== 'object'` three lines below already returns `[]` for `undefined` on its own (`typeof undefined === 'undefined'`, never `'object'`), so removing this check changes no observable input/output pair; it stays only so a reader doesn't have to re-derive that JS invariant. The sibling `null` check right above is NOT equivalent (`typeof null === 'object'`, so without it `'value' in null` throws) — see drizzle-where-introspection.spec.ts for both, proven empirically.
  if (node === undefined) return []
  if (Array.isArray(node)) return node.flatMap((v) => collectParamValues(v, visited))
  if (typeof node !== 'object') return []
  if (visited.has(node)) return []
  visited.add(node)
  const obj = node as Record<string, unknown>
  if ('value' in obj && 'encoder' in obj) return [obj['value']]
  return Object.values(obj).flatMap((v) => collectParamValues(v, visited))
}

/**
 * Compile a captured Drizzle `where` into the SQL text + bound params Postgres
 * would actually receive. `PgDialect.sqlToQuery` is a pure function — no
 * connection, no query execution — so a mocked-DB unit spec can read the
 * predicate instead of guessing at it.
 *
 * Complements `collectParamValues` above rather than replacing it: params alone
 * cannot see a term that binds NOTHING. `isNull(users.archivedAt)` compiles to
 * `"archived_at" is null` with an empty param list, and a correlated
 * `notExists(...)` guard binds nothing at all — the SQL text is the only place
 * either is observable.
 *
 * Added by task-finance-fix-wave1 after the mutation gate killed the naive
 * version of that assertion: with `findFirst` stubbed, `where: eq(users.id, x)`
 * mutated to `{}` changed nothing any test could see. Asserting on the compiled
 * output closes that blind spot — an emptied `where` arrives here as
 * `undefined` and fails loudly.
 */
export function compileWhere(where: unknown): { sql: string; params: unknown[] } {
  const compiled = new PgDialect().sqlToQuery(where as SQL)
  return { sql: compiled.sql, params: compiled.params }
}
