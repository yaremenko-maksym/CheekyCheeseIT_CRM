import {
  createFileRouteStatePort,
  createOwnCapPort,
  createRouterExtractionAdapter,
} from '@crm/inference'
import type { FastifyInstance } from 'fastify'
import { localOnlyRouterConfig, parseWorkerEnv } from './schema'
import { buildExtractionWorker, type WorkerLogLine } from './server'

export type WorkerProcess = {
  stdout: { write(text: string): unknown }
  stderr: { write(text: string): unknown }
  exit(code: number): void
}

/**
 * The extraction worker's startup (ADR §2.4): its own env, its own state file, two routes. A bad
 * env or a failed start exits 1 and never listens. Takes the process so a test can see that.
 */
export async function startWorker(
  rawEnv: Readonly<Record<string, string | undefined>>,
  proc: WorkerProcess,
): Promise<FastifyInstance | undefined> {
  const parsed = parseWorkerEnv(rawEnv)
  if (!parsed.ok) {
    // The key's name only, never its value.
    proc.stderr.write(`extraction-worker: refusing to start, bad ${parsed.reason}\n`)
    proc.exit(1)
    return undefined
  }
  const { env } = parsed
  const log = (line: WorkerLogLine): void => {
    proc.stdout.write(`${JSON.stringify(line)}\n`)
  }
  try {
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
    return app
  } catch {
    // No error text: it could carry a config value.
    proc.stderr.write('extraction-worker: failed to start\n')
    proc.exit(1)
    return undefined
  }
}
