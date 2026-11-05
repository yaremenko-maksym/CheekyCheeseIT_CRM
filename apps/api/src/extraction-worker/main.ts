import {
  createFileRouteStatePort,
  createOwnCapPort,
  createRouterExtractionAdapter,
} from '@crm/inference'
import { localOnlyRouterConfig, parseWorkerEnv } from './schema'
import { buildExtractionWorker, type WorkerLogLine } from './server'

/**
 * The extraction worker's process entry (ADR §2.4): its own env, its own state file, two routes.
 * Wiring only; the behaviour lives in `schema.ts` and `server.ts`, which carry the tests.
 */
async function main(): Promise<void> {
  const parsed = parseWorkerEnv(process.env)
  if (!parsed.ok) {
    // The key's name only, never its value.
    process.stderr.write(`extraction-worker: refusing to start, bad ${parsed.reason}\n`)
    process.exit(1)
  }
  const { env } = parsed
  const log = (line: WorkerLogLine): void => {
    process.stdout.write(`${JSON.stringify(line)}\n`)
  }
  const routeState = await createFileRouteStatePort({
    path: env.stateFile,
    now: Date.now,
    onEvent: (e) => log({ event: 'STATE', ...e }),
  })
  const ownCap = createOwnCapPort({ state: routeState, now: Date.now })
  const app = buildExtractionWorker({
    secret: env.secret,
    routeState,
    log,
    buildPorts: (onEvent) => ({
      extract: createRouterExtractionAdapter(env.routerConfig, { onEvent, routeState, ownCap }),
      preflight: createRouterExtractionAdapter(localOnlyRouterConfig(env.routerConfig), {
        onEvent,
        routeState,
      }),
    }),
  })
  await app.listen({ host: env.host, port: env.port })
  log({ event: 'LISTENING', port: env.port })
}

void main().catch(() => {
  // No error text: it could carry a config value.
  process.stderr.write('extraction-worker: failed to start\n')
  process.exit(1)
})
