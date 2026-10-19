import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import type { Pool } from 'pg'
import { DatabaseService } from './database.service'
import { PG_INSUFFICIENT_PRIVILEGE, dbIdentifier, findPgError } from './pg-errors'

/*
 * THE ALERT'S CONTRACT — one chokepoint, one line.
 *
 * ADR 2026-10-17-db-least-privilege-roles, measure 2: before the API runs as the
 * least-privileged `crm_app` role there must be an alert on a privilege error. A
 * misclassified table surfaces as SQLSTATE 42501 — and, on the paths that matter, inside
 * code that deliberately swallows its errors (the cron handlers) or that turns them into a
 * 500. Matching whatever each of those call sites happens to print is not a detection
 * anyone owns. So the pool is wrapped ONCE, at the point where every statement passes, and
 * a 42501 emits exactly this line, whoever catches the error afterwards:
 *
 *   db_privilege_denied sqlstate=42501 table=<T> ctx=<C>
 *
 *   table=<T>  ALWAYS present. The relation named by the driver (`permission denied for
 *              table X` / `view X`, or the error's own `table` field), restricted to
 *              [A-Za-z0-9_$.]; the literal `unknown` when the 42501 names no table (a
 *              schema, a sequence, a database, `must be owner of…`). An unknown table is a
 *              value, not an omission: a parser can tell "not determinable" from "missing".
 *   ctx=<C>    `pool`   a statement run directly on the pool (raw, or drizzle outside a
 *                       transaction);
 *              `client` a statement run on a checked-out client (drizzle `transaction()`), or
 *                       `pool.connect()` itself being refused (e.g. a role without CONNECT).
 *
 * THIS LINE IS THE ALERT'S CONTRACT AND THE ONLY ONE. The handlers' `db_error …` fragment
 * (`pg-errors.ts`) is diagnostic and deliberately outside the alert's pattern, so one failure
 * is one hit. Tests pin the line against ONE shared copy of the alert's patterns
 * (`__test-helpers__/alert-patterns.ts`), which names the script that owns them
 * (scripts/devops/check-api-permission-denied.sh) and is a copy until that is on main.
 *
 * Emitted at ERROR level through Nest's TEXT `Logger.error`, logger context `DatabasePrivilege`,
 * once per failing statement. THE BRACKETED CONTEXT IS PART OF WHAT THE ALERT MATCHES:
 * `[DatabasePrivilege] db_privilege_denied sqlstate=42501`. The bare tokens are plain text, so
 * any path that interpolates request data into an error message or a Nest text log line could
 * forge them; anchoring on the context an attacker's text cannot supply is what makes a forgery
 * need more than attacker-controlled text. So do not rename the context, and do not move this
 * line to a pino record: the alert drops pino records below level 50, and a record carrying a
 * genuine 42501 at a lower level would be filtered out. A test pins both, on Nest's real output.
 * The alert may rely on that context, on `db_privilege_denied`, on `sqlstate=42501` and on
 * `table=`; it must not rely on field order past the first token or on ANSI colouring.
 *
 * NEVER in the line, by construction: the statement, any parameter value, the driver's
 * `detail` / `where` / `hint`. Why: values can be personal data, and a log line is routinely
 * pasted into issues of this PUBLIC repository, where it is world-readable.
 *
 * What it does NOT see: a callback-style `pool.query(text, cb)` / `pool.connect(cb)` (the
 * app does not use them; drizzle does not either); a connection-level failure such as a
 * wrong password (28P01) — not a privilege error, a different alert; and any statement
 * issued before `OnApplicationBootstrap` installs the wrapper (an empty window today: the
 * only other `onModuleInit` makes an HTTP fetch, no query).
 * Changing a token here is a change to the alert: tell whoever owns it.
 */

type Fn = (...args: unknown[]) => unknown
type Context = 'pool' | 'client'

const DENIED_ON_TABLE = /^permission denied for (?:table|view) (.+)/
const UNKNOWN_TABLE = 'unknown'

/** The canonical line for `err`, or null when `err` is not a privilege error. */
export function privilegeDeniedLine(err: unknown, ctx: Context): string | null {
  const pg = findPgError(err)
  if (pg === null || pg['code'] !== PG_INSUFFICIENT_PRIVILEGE) return null

  const fromField = dbIdentifier(pg['table'])
  const fromMessage = DENIED_ON_TABLE.exec(String(pg['message']))?.[1]
  const named = fromField !== '-' ? fromField : dbIdentifier(fromMessage)
  const table = named !== '-' ? named : UNKNOWN_TABLE
  return `db_privilege_denied sqlstate=${PG_INSUFFICIENT_PRIVILEGE} table=${table} ctx=${ctx}`
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/** Report `err` if it is a privilege error. Never throws: reporting must not change the caller's outcome. */
function report(err: unknown, ctx: Context, sink: (line: string) => void): void {
  try {
    const line = privilegeDeniedLine(err, ctx)
    if (line !== null) sink(line)
  } catch {
    // Nor may it leave an unhandled rejection behind.
  }
}

/** Wraps `original` so a rejection is reported, and the caller still gets the ORIGINAL promise. */
function observing(original: Fn, ctx: Context, sink: (line: string) => void): Fn {
  return function (this: unknown, ...args: unknown[]): unknown {
    const result = original.apply(this, args)
    if (isThenable(result)) result.then(undefined, (err: unknown) => report(err, ctx, sink))
    return result
  }
}

const installedPools = new WeakSet<object>()
const patchedClients = new WeakSet<object>()

/**
 * Wrap `pool.query` and the clients `pool.connect()` hands out, so a 42501 on ANY promise-style
 * statement is reported through `sink` (see the contract above). Idempotent per pool.
 */
export function installPrivilegeDeniedReporter(pool: Pool, sink: (line: string) => void): void {
  if (installedPools.has(pool)) return
  installedPools.add(pool)

  const target = pool as unknown as { query: Fn; connect: Fn }
  target.query = observing(target.query, 'pool', sink)

  const originalConnect = target.connect
  target.connect = function (this: unknown, ...args: unknown[]): unknown {
    const result = originalConnect.apply(this, args)
    // A callback-style `connect(cb)` returns undefined, so it takes this branch too.
    if (!isThenable(result)) return result
    // Drizzle's transaction() starts here, so a refusal of connect() itself (a role without
    // CONNECT) must be reported too — CR-M-2. The caller still gets the original rejection.
    result.then(undefined, (err: unknown) => report(err, 'client', sink))
    return result.then((client) => {
      patchClient(client as { query: Fn }, sink)
      return client
    })
  }
}

function patchClient(client: { query: Fn }, sink: (line: string) => void): void {
  if (patchedClients.has(client)) return
  patchedClients.add(client)
  client.query = observing(client.query, 'client', sink)
}

/**
 * Installs the reporter on the application's pool at startup. `OnApplicationBootstrap`, not
 * `OnModuleInit`: it runs after EVERY module's init, so `DatabaseService` has certainly
 * created its pool — no reliance on provider order. The pool is reached through drizzle's
 * own `$client`, so `database.service.ts` is not touched.
 */
@Injectable()
export class PrivilegeDeniedReporter implements OnApplicationBootstrap {
  private readonly logger = new Logger('DatabasePrivilege')

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    // `DatabaseService.db` is declared as a plain `NodePgDatabase`, whose type omits the
    // `$client` that `drizzle(pool)` really returns (measured: `db.$client === pool`).
    const { $client } = this.database.db as unknown as { $client: Pool }
    installPrivilegeDeniedReporter($client, (line) => this.logger.error(line))
  }
}
