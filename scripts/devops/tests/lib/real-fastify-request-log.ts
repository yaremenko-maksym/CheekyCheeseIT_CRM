// real-fastify-request-log.ts — prints the lines the PRODUCTION API's Fastify request
// logger really writes, for requests an anonymous client can send.
//
// WHY THIS EXISTS (SR-H-5). The 42501 watch greps API logs, and the first design matched
// `code=42501` anywhere in a line. The reviewer showed `GET /api/health?code=42501` forges
// a hit, but built the log line by hand. A fixture built by hand can only contain what its
// author already thought of, which is the lesson of the SR-H-1 seam as well: a test fed
// input it built itself cannot discover what the real producer emits. So this runs the
// REAL pieces: the repository's own `createRedactingReqSerializer` (apps/api/src/config/
// http-logger-serializers.ts, imported, not copied) inside a REAL Fastify instance with
// the same logger option shape as apps/api/src/main.ts, and injects REAL requests.
// Only the log destination differs (a capture stream instead of stdout).
//
// Run: tsx scripts/devops/tests/lib/real-fastify-request-log.ts   (needs `pnpm install`;
// LOGSCAN_API_DIR overrides where fastify is resolved from, for a worktree with no install.)
// Output: one raw pino line per log record on stdout, nothing else.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRedactingReqSerializer } from '../../../../apps/api/src/config/http-logger-serializers'

const here = path.dirname(fileURLToPath(import.meta.url))
const apiDir = process.env['LOGSCAN_API_DIR'] ?? path.resolve(here, '../../../../apps/api')
const apiRequire = createRequire(path.join(apiDir, 'package.json'))
const fastify = apiRequire('fastify') as typeof import('fastify').default

async function main() {
  const lines: string[] = []
  const app = fastify({
    // Same shape as apps/api/src/main.ts: `logger: { serializers: { req } }`.
    logger: {
      serializers: { req: createRedactingReqSerializer() },
      stream: { write: (s: string) => void lines.push(s.trimEnd()) },
    },
  })
  app.get('/api/health', async () => ({ ok: true }))
  app.post('/api/auth/login', async () => ({ ok: true }))
  // A handler that throws OUTSIDE Nest's exception filter: Fastify logs the 500 itself, at
  // error level. (In the real API, Nest's filter logs handler errors through its own text
  // Logger instead; this is the case where Fastify's logger sees an error.)
  app.get('/api/boom', async () => {
    throw new Error('permission denied for table real_hit_from_a_handler')
  })

  const hostile = [
    // The reviewer's forgery: the query string is logged verbatim.
    // Forgeries aimed at the CONTRACT pattern (the only thing that can page): the query
    // string is logged verbatim. The older bare-code forgery (?code=42501) no longer matches.
    { method: 'GET', url: '/api/health?db_privilege_denied&sqlstate=42501&table=users' },
    { method: 'GET', url: '/api/health?code=42501' },
    // A path that does not exist: Fastify's own 404 line.
    { method: 'GET', url: '/db_privilege_denied/sqlstate=42501' },
    // A content type nobody registered: Fastify answers 415 and may echo the type.
    {
      method: 'POST',
      url: '/api/auth/login?db_privilege_denied&sqlstate=42501',
      headers: { 'content-type': 'application/x-permission-denied' },
      payload: 'x',
    },
    // A 500 whose request URL carries the forgery while the REAL error message is genuine.
    { method: 'GET', url: '/api/boom?db_privilege_denied&sqlstate=42501' },
    // Malformed JSON.
    {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"code":"42501",',
    },
  ] as const
  for (const r of hostile) await app.inject(r as never)
  await app.close()
  for (const l of lines) process.stdout.write(l + '\n')
}

void main()
