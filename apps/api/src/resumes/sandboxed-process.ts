/**
 * One sandbox for every piece of untrusted, unbounded CPU work in this module.
 *
 * ==========================================================================
 * WHY THIS EXISTS — AND WHY IT NOW RUNS THE DOCUMENT PARSER TOO
 * ==========================================================================
 * The DOCX parse budget was bypassed three times. Each fix changed WHICH SIGNAL
 * the guard read, and each time the bypass came back:
 *
 *   guard read the extension `.xml`/`.rels`   -> body renamed to `.dat`
 *   guard read "any extension but media"      -> body named `document.png`
 *   guard read the leading BYTES (media magic) -> media magic PREPENDED to XML
 *
 * The third one is the instructive one. `mammoth` parses through
 * `@xmldom/xmldom`, which is deliberately error-tolerant: it skips junk before
 * `<?xml` and extracts the whole document anyway. So eight bytes of PNG header
 * in front of a valid `<w:document>` is an image to any signature check and a
 * complete document to the parser — 868 KB on disk, 19.5 MB parsed, 1 503 ms of
 * continuous event-loop stall.
 *
 * The pattern is not "the list was wrong" three times. Every version of the
 * guard was PREDICTING WHAT A THIRD-PARTY PARSER WOULD ACCEPT, and that parser
 * is documented to be forgiving. A prediction about someone else's leniency is
 * not a security boundary, and the next prefix is free to invent.
 *
 * So the guard stops being load-bearing. The parser moves into a child process
 * with a hard deadline, a memory ceiling, the lowest scheduling priority and a
 * concurrency limit — the identical arrangement this PR already built for Typst
 * and measured (21.8 ms worst API latency during a render, against 1 357.8 ms
 * for the same work on the main thread).
 *
 * WHAT THAT BUYS, precisely: "what exactly does `mammoth` accept?" stops being
 * a security question. However much it decides to parse, it parses it somewhere
 * the event loop is not, and the kernel ends it on a timer. The byte budgets
 * stay — they still refuse obviously pointless work early and cheaply — but
 * nothing catastrophic depends on their being right about a foreign library.
 *
 * The alternative the reviewer offered was to follow `_rels/.rels` so the guard
 * reads the same graph `mammoth` does. That is a genuine improvement and it is
 * still a prediction: it would have to track `findPartPath`'s fallbacks, and
 * every future version of them, forever. Isolation closes the class instead of
 * the current member of it.
 */
import { spawn } from 'node:child_process'
import { setPriority } from 'node:os'

/** Lowest scheduling priority — the API always outranks sandboxed work. */
export const SANDBOX_NICENESS = 19

/**
 * `sh` wrapper that applies two rlimits and then BECOMES the target process.
 *
 * Arguments arrive as positional parameters and are never interpolated into
 * this string, so nothing in a path or filename can be read as shell syntax.
 * `exec` replaces the shell, so the pid we hold is the target's own — which is
 * what makes both `setPriority` and the SIGKILL land on the right process.
 *
 * `ulimit` failures are swallowed: macOS honours neither reliably, and a dev
 * machine refusing a limit must not fail the work. The limits that matter in
 * production (a Linux container) do apply there.
 */
const RLIMIT_WRAPPER = 'ulimit -v "$1" 2>/dev/null; ulimit -t "$2" 2>/dev/null; shift 2; exec "$@"'

export interface SandboxOptions {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Wall-clock deadline; the process is SIGKILLed when it expires. */
  timeoutMs: number
  /** `ulimit -v`, KiB. */
  addressSpaceKb: number
  /** `ulimit -t`, seconds — a KERNEL-side backstop for a starved JS timer. */
  cpuSeconds: number
  /** Cap on captured stdout. `0` discards it entirely. */
  maxStdoutBytes: number
  /** Cap on captured stderr, so a compiler error cannot become a log bomb. */
  maxStderrBytes: number
}

export interface SandboxResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run a command under the full discipline. Never rejects — a non-zero exit is
 * data for the caller, not an exception — and never resolves before the process
 * is gone.
 */
export function runSandboxed(options: SandboxOptions): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        RLIMIT_WRAPPER,
        'crm-sandbox',
        String(options.addressSpaceKb),
        String(options.cpuSeconds),
        options.bin,
        ...options.args,
      ],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', options.maxStdoutBytes > 0 ? 'pipe' : 'ignore', 'pipe'],
      },
    )

    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, SANDBOX_NICENESS)
      } catch {
        // Not permitted on this platform/user — the other bounds still stand.
      }
    }

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < options.maxStdoutBytes) stdout += chunk.toString('utf8')
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < options.maxStderrBytes) stderr += chunk.toString('utf8')
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // SIGKILL, not SIGTERM: work stuck in a parse loop owes us no handler.
      child.kill('SIGKILL')
    }, options.timeoutMs)
    timer.unref?.()

    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: stdout.slice(0, options.maxStdoutBytes),
        stderr: stderr.slice(0, options.maxStderrBytes),
        timedOut,
      })
    }

    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
