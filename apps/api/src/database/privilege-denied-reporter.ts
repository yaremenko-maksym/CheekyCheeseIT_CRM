import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import type { Pool } from 'pg'
import { DatabaseService } from './database.service'
import { dbIdentifier, findPgError } from './pg-errors'

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
 *   table=<T>  the relation named by the driver (`permission denied for table X` / `view X`,
 *              or the error's own `table` field), restricted to [A-Za-z0-9_$.]; `-` when
 *              the 42501 names no table (a schema, a sequence, `must be owner of…`).
 *   ctx=<C>    `pool`   a statement run directly on the pool (raw, or drizzle outside a
 *                       transaction);
 *              `client` a statement run on a checked-out client (drizzle `transaction()`).
 *
 * Emitted at ERROR level, once per failing statement. The alert may rely on the bare token
 * `db_privilege_denied` and on `sqlstate=42501`; it must not rely on field order past the
 * first token or on the logger's prefix and quoting.
 *
 * NEVER in the line, by construction: the statement, any parameter value, the driver's
 * `detail` / `where` / `hint`. This repository is public; its logs end up in issues.
 *
 * What it does NOT see: a callback-style `pool.query(text, cb)` / `pool.connect(cb)` (the
 * app does not use them; drizzle does not either), and a connection-level failure such as a
 * wrong password (28P01) — that is not a privilege error and is a different alert.
 * Changing a token here is a change to the alert: tell whoever owns it.
 */

type Fn = (...args: unknown[]) => unknown
type Context = 'pool' | 'client'

const DENIED_ON_TABLE = /^permission denied for (?:table|view) (.+)$/
const PRIVILEGE_DENIED = '42501'

/** The canonical line for `err`, or null when `err` is not a privilege error. */
export function privilegeDeniedLine(err: unknown, ctx: Context): string | null {
  const pg = findPgError(err)
  if (pg === null || pg['code'] !== PRIVILEGE_DENIED) return null

  const fromField = dbIdentifier(pg['table'])
  const fromMessage = DENIED_ON_TABLE.exec(String(pg['message']))?.[1]
  const table = fromField !== '-' ? fromField : dbIdentifier(fromMessage)
  return `db_privilege_denied sqlstate=${PRIVILEGE_DENIED} table=${table} ctx=${ctx}`
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Wraps `original` so a rejection is reported, and the caller still gets the ORIGINAL promise. */
function observing(original: Fn, ctx: Context, sink: (line: string) => void): Fn {
  return function (this: unknown, ...args: unknown[]): unknown {
    const result = original.apply(this, args)
    if (isThenable(result)) {
      result.then(undefined, (err: unknown) => {
        try {
          const line = privilegeDeniedLine(err, ctx)
          if (line !== null) sink(line)
        } catch {
          // Reporting must never change what the caller sees, nor leave an unhandled rejection.
        }
      })
    }
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
    if (typeof args[0] === 'function' || !isThenable(result)) return result
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
    installPrivilegeDeniedReporter(this.database.db.$client as Pool, (line) =>
      this.logger.error(line),
    )
  }
}
