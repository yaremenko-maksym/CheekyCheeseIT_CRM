/**
 * telemetry/error-dedupe — task-telemetry-web AC1 ("error-dedupe — чистая
 * функция тестируема без DOM-хаков").
 *
 * Client-side, in-memory dedupe: at most ONE `POST /api/telemetry/errors`
 * per fingerprint-ish key per browser session (spec §3: "dedupe в памяти (1
 * отправка/fingerprint/сессию)"). This is deliberately cheaper/coarser than
 * the API's `fingerprint` (sha256 of normalized message + top-frames +
 * source, `apps/api/src/telemetry/fingerprint.ts`) — the client only needs
 * to stop hammering the endpoint with the SAME error repeating in a render
 * loop; the server owns the authoritative grouping/count.
 */

/** Builds the in-memory dedupe key — `source::message`, capped so a single pathological error can't grow the Set unboundedly. */
export function errorDedupeKey(message: string, source: string): string {
  return `${source}::${message}`.slice(0, 300)
}

export class ErrorDedupe {
  private readonly seen = new Set<string>()

  /** Returns `true` the FIRST time this key is seen (and records it); `false` on every repeat. */
  shouldSend(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}
