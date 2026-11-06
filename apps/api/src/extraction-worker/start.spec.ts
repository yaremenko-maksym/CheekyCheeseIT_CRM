import { mkdtempSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWorker } from './start'

const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'

/** A port that was free a moment ago; `holder` keeps it taken for the failed-listen case. */
async function takePort(): Promise<{ port: number; release(): Promise<void> }> {
  const holder = createServer()
  await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r))
  return {
    port: (holder.address() as AddressInfo).port,
    release: () => new Promise((r) => holder.close(() => r())),
  }
}

async function freePort(): Promise<number> {
  const taken = await takePort()
  await taken.release()
  return taken.port
}

function fakeProcess() {
  const out: string[] = []
  const err: string[] = []
  const exits: number[] = []
  return {
    out,
    err,
    exits,
    proc: {
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => err.push(t) },
      exit: (code: number) => {
        exits.push(code)
      },
    },
  }
}

const envOn = (port: number, extra: Record<string, string | undefined> = {}) => ({
  EXTRACTION_WORKER_SECRET: SECRET,
  EXTRACTION_ROUTER_CONFIG: '{"routes":[]}',
  EXTRACTION_ROUTER_STATE_FILE: join(mkdtempSync(join(tmpdir(), 'xw-start-')), 'state.json'),
  EXTRACTION_WORKER_HOST: '127.0.0.1',
  EXTRACTION_WORKER_PORT: String(port),
  ...extra,
})

const listening = (port: number) =>
  fetch(`http://127.0.0.1:${port}/extract`, { method: 'POST' }).then(
    (r) => r.status,
    () => 'REFUSED' as const,
  )

let open: { close(): Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()))
  open = []
})

describe('startWorker — a bad secret means exit 1 and no listener', () => {
  it.each([
    ['missing', undefined],
    ['too short', 'abcdefgh'],
    ['one repeated character', 's'.repeat(64)],
  ])('secret %s', async (_name, secret) => {
    const port = await freePort()
    const fake = fakeProcess()
    const app = await startWorker(envOn(port, { EXTRACTION_WORKER_SECRET: secret }), fake.proc)
    expect(app).toBeUndefined()
    expect(fake.exits).toEqual([1])
    expect(fake.err).toEqual(['extraction-worker: refusing to start, bad SECRET\n'])
    expect(fake.out).toEqual([])
    expect(await listening(port)).toBe('REFUSED')
  })
})

describe('startWorker — a good env listens', () => {
  it('serves both authenticated routes on the configured host and port; no exit', async () => {
    const port = await freePort()
    const fake = fakeProcess()
    const app = await startWorker(envOn(port), fake.proc)
    open.push(app!)
    expect(fake.exits).toEqual([])
    expect(fake.err).toEqual([])
    expect(await listening(port)).toBe(401)
    expect(fake.out.map((l) => JSON.parse(l) as unknown)).toContainEqual({
      event: 'LISTENING',
      port,
    })
    expect(fake.out.join('')).not.toContain(SECRET)
  })

  it('a listen failure is exit 1 with a fixed line, no error text', async () => {
    const taken = await takePort()
    try {
      const fake = fakeProcess()
      const app = await startWorker(envOn(taken.port), fake.proc)
      expect(app).toBeUndefined()
      expect(fake.exits).toEqual([1])
      expect(fake.err).toEqual(['extraction-worker: failed to start\n'])
    } finally {
      await taken.release()
    }
  })
})
