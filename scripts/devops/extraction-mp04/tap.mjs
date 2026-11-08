// The loopback tap between the router and the runtime. Its own module so lib.test.mjs can drive it
// against a fake upstream without a runtime.

import http from 'node:http'

// shortcut: mirrors CHARS_PER_TOKEN and MESSAGE_OVERHEAD_TOKENS of @crm/inference router/fit (not
// exported); if the package changes them, change these with it.
const CHARS_PER_TOKEN = 2
const MESSAGE_OVERHEAD_TOKENS = 32

/**
 * Forwards every request to the runtime unchanged and keeps counts only, never a prompt or a reply.
 * A client that disconnects disconnects the runtime too, as in production. `current.inFlight`
 * counts requests the runtime has not finished; every request lowers it exactly once.
 */
export function startTap(upstream, current) {
  const requests = []
  const origin = new URL(upstream).origin
  const server = http.createServer((req, res) => {
    // a client or runtime that drops the socket must not crash the harness without a report
    req.on('error', () => {})
    res.on('error', () => {})
    // Only paths on the runtime: `//host/x`, `/\host/x` or an absolute URL would make this an open proxy.
    let target = null
    try {
      if (/^\/(?![/\\])/.test(req.url)) target = new URL(req.url, upstream)
    } catch {
      // unparseable: refused below
    }
    if (target?.origin !== origin) {
      req.resume()
      res.writeHead(400).end()
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const row = { ...current.tag, path: req.url, t0: Date.now(), aborted: false }
      try {
        const sent = JSON.parse(body.toString('utf8'))
        const chars = (sent.messages ?? []).reduce(
          (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
          0,
        )
        row.estimate = Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS
      } catch {
        // not a chat request
      }
      requests.push(row)
      current.inFlight += 1
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        current.inFlight -= 1
      }
      // The runtime failed before or during its answer: the client gets 502, or a cut connection
      // when the answer had already started, never a wait until its own timeout.
      const failed = () => {
        row.status ??= 0
        settle()
        if (res.destroyed) return
        if (!res.headersSent) res.writeHead(502).end()
        else res.destroy()
      }
      const up = http.request(
        target,
        {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        },
        (ur) => {
          const out = []
          ur.on('error', failed)
          ur.on('data', (c) => out.push(c))
          ur.on('end', () => {
            settle()
            const text = Buffer.concat(out)
            row.ms = Date.now() - row.t0
            row.status = ur.statusCode
            try {
              const j = JSON.parse(text.toString('utf8'))
              const msg = j.choices?.[0]?.message ?? {}
              const content = typeof msg.content === 'string' ? msg.content : ''
              const think = /<think>[\s\S]*?<\/think>/g
              row.promptTokens = j.usage?.prompt_tokens
              row.completionTokens = j.usage?.completion_tokens
              row.promptPerSecond = j.timings?.prompt_per_second
              row.predictedPerSecond = j.timings?.predicted_per_second
              row.reasoningChars =
                (msg.reasoning_content?.length ?? 0) + (content.match(think) ?? []).join('').length
              row.empty = content.replace(think, '').trim() === ''
            } catch {
              // a non-JSON answer stays counts-free
            }
            if (!res.destroyed) {
              res.writeHead(ur.statusCode, {
                'content-type': ur.headers['content-type'] ?? 'application/json',
              })
              res.end(text)
            }
          })
        },
      )
      up.on('error', failed)
      res.on('close', () => {
        // the client left first; a cut made by failed() already set a status and stays a non-200
        if (!res.writableEnded && row.status === undefined) {
          row.aborted = true
          settle()
          up.destroy()
        }
      })
      up.end(body)
    })
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok({ server, requests, port: server.address().port })),
  )
}
