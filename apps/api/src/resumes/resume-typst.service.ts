/**
 * ResumeTypstService — joins a Typst TEMPLATE with resume DATA and returns a PDF
 * (task-resume-template §2).
 *
 * ==========================================================================
 * TYPST RUNS IN A CHILD PROCESS. NEVER IN THIS ONE.
 * ==========================================================================
 * Not a preference — the task states it as a prohibition, and the prohibition
 * was bought with a real incident: the previous attempt (#497) typeset inside
 * the Node process and stalled the whole API for 30 seconds on one document,
 * which cost four review rounds. Typesetting is unbounded CPU driven by
 * untrusted content; a single-threaded event loop cannot host it under any
 * amount of care. So: no WebAssembly build, no native binding, no worker
 * thread pretending to be isolation — a separate OS process that the kernel
 * can schedule down and kill.
 *
 * What actually holds that line, in the order the guarantees matter:
 *
 *   1. `spawn` (async) — the event loop is never blocked, only the promise
 *      waits. `execFileSync` would run the identical binary and destroy the
 *      property; that is precisely the mutation the AC3 spec applies to prove
 *      its measurement has teeth.
 *   2. Niceness 19 via `os.setPriority` — when cores are scarce the API wins.
 *      Applied to the spawned pid, and niceness survives `exec`, so the
 *      wrapper shell hands it to Typst.
 *   3. Wall-clock deadline with SIGKILL (`RENDER_TIMEOUT_MS`) — not SIGTERM: a
 *      runaway typesetter has no obligation to handle a polite signal.
 *   4. `ulimit -t` (CPU seconds) — a KERNEL-side backstop for (3). If the
 *      timer is starved, missed or the process ignores everything, the kernel
 *      still ends it. Belt and braces because (3) lives in the very event loop
 *      whose responsiveness is the thing at risk.
 *   5. `ulimit -v` (address space) — memory ceiling per render.
 *   6. `ResumeSemaphore(MAX_CONCURRENT_RENDERS)` — at most two of the above at
 *      a time, so the bound is on the machine, not merely on one request.
 *   7. `--root <tmpdir>` — Typst may not read a byte outside the directory we
 *      built for it. Templates are code; this is the blast wall.
 *
 * The render is ALSO out of the request path entirely: callers enqueue it as a
 * detached job (see SeniorResumesService) and the HTTP handler serves a stored
 * artefact. Nothing here is awaited by a controller.
 *
 * DETERMINISM (AC1). Same input, byte-identical PDF:
 *   - `--creation-timestamp 0` plus `SOURCE_DATE_EPOCH=0`, or the PDF carries
 *     the wall clock;
 *   - `#set document(date: none)` in the template, same reason;
 *   - `--ignore-system-fonts --ignore-embedded-fonts` with an explicit
 *     `--font-path`, so the machine's installed fonts cannot change the
 *     output — and so glyph coverage is a fact we can compute (resume-glyphs);
 *   - a fixed `--jobs 1`: parallel typesetting is not required to be
 *     order-stable, and one job is also the friendlier CPU citizen.
 */
import { Injectable, Logger } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { setPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeResumeLayout, type ResumeContent, type ResumeLayoutOptions } from '@crm/shared'
import { resolveAssetPath } from '../common/assets.util'
import { logDroppedGlyphs, toRenderableDeep } from './resume-glyphs'
import { ResumeSemaphore } from './resume-semaphore'

/** Hard wall-clock deadline for one render, enforced with SIGKILL. */
export const RENDER_TIMEOUT_MS = 20_000

/**
 * Kernel-side CPU ceiling (`ulimit -t`, seconds).
 *
 * Comfortably above the wall-clock deadline: it is a BACKSTOP for a starved
 * timer, not a second, tighter limit. Setting it below `RENDER_TIMEOUT_MS`
 * would make the kernel the usual killer and the readable timeout path dead
 * code.
 */
export const RENDER_CPU_SECONDS = 30

/** Address-space ceiling per render (`ulimit -v`, KiB) — 1.5 GiB. */
export const RENDER_ADDRESS_SPACE_KB = 1_536_000

/** Renders allowed to run at once, process-wide (task §2: "не более одного-двух"). */
export const MAX_CONCURRENT_RENDERS = 2

/** Lowest scheduling priority — the API always outranks a render. */
export const RENDER_NICENESS = 19

/** Truncate captured stderr: a compiler error must not become a log bomb. */
const MAX_STDERR_BYTES = 8 * 1024

/**
 * `sh` wrapper that applies the two rlimits and then BECOMES the renderer.
 *
 * Arguments arrive as positional parameters and are never interpolated into
 * this string, so nothing in a path or a filename can be read as shell syntax.
 * `exec` replaces the shell, so the pid we hold is Typst's own — which is what
 * makes both `setPriority` and the SIGKILL land on the right process.
 *
 * `ulimit` failures are swallowed: macOS honours neither reliably, and a dev
 * machine refusing to set a limit must not fail the render. The limits that
 * matter in production (Linux container) do apply there, and `describeLimits`
 * reports what was requested so the spec can assert on the command rather than
 * on the platform.
 */
const RLIMIT_WRAPPER = 'ulimit -v "$1" 2>/dev/null; ulimit -t "$2" 2>/dev/null; shift 2; exec "$@"'

export class ResumeRenderError extends Error {
  constructor(
    message: string,
    /** Compiler output, for the log only — never shown to a user. */
    readonly detail: string = '',
  ) {
    super(message)
    this.name = 'ResumeRenderError'
  }
}

export interface ResumeRenderInput {
  displayName: string
  content: ResumeContent
  layout: ResumeLayoutOptions
  /** Typst source for this senior. `null` → the template shipped in the repo. */
  templateSource: string | null
}

/**
 * Swappable process runner.
 *
 * Exists for ONE reason: the AC3 spec has to be able to prove that its
 * measurement would notice the forbidden implementation. It substitutes a
 * runner that executes the very same binary synchronously and asserts the
 * responsiveness test goes red. Production never passes a runner.
 */
export interface TypstRunner {
  (
    bin: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<{
    code: number | null
    stderr: string
    timedOut: boolean
  }>
}

@Injectable()
export class ResumeTypstService {
  private readonly logger = new Logger(ResumeTypstService.name)
  private readonly gate = new ResumeSemaphore(MAX_CONCURRENT_RENDERS)

  constructor(private readonly runner: TypstRunner = spawnTypst) {}

  /** In-flight renders — the concurrency bound's only observable effect. */
  get activeRenders(): number {
    return this.gate.active
  }

  /**
   * The exact bytes a given input renders to, addressed by content.
   *
   * Same input -> same fingerprint -> same PDF (AC1), which is what lets the
   * service cache one artefact per resume and know, without re-rendering,
   * whether the stored PDF is still the current one. Computed over the
   * RENDERABLE form (post glyph-substitution), so two inputs that differ only
   * in a character no font can draw share a fingerprint — as they must, since
   * they produce identical bytes.
   */
  fingerprint(input: ResumeRenderInput): string {
    return createHash('sha256').update(this.serialiseInput(input).payload).digest('hex')
  }

  /**
   * Render `input` to a PDF.
   *
   * Throws `ResumeRenderError` for every failure — bad template, timeout,
   * missing binary — with a Russian message safe to store and display, and the
   * compiler's own output kept in `detail` for the log.
   */
  async render(input: ResumeRenderInput): Promise<Buffer> {
    return this.gate.run(() => this.renderOnce(input))
  }

  private async renderOnce(input: ResumeRenderInput): Promise<Buffer> {
    const { payload, dropped } = this.serialiseInput(input)
    logDroppedGlyphs('resume render', dropped)

    const dir = await mkdtemp(join(tmpdir(), 'crm-resume-'))
    try {
      const template = input.templateSource ?? loadDefaultTemplate()
      await writeFile(join(dir, 'data.json'), payload, 'utf8')
      await writeFile(join(dir, 'template.typ'), template, 'utf8')
      // The entry point is OURS, not the template's: it decides that the
      // template gets the data and nothing else, and it is the reason a
      // template cannot choose what to read.
      await writeFile(
        join(dir, 'main.typ'),
        '#import "template.typ": render\n#render(json("data.json"))\n',
        'utf8',
      )

      const outPath = join(dir, 'out.pdf')
      const result = await this.runner(typstBinary(), buildArgs(dir, outPath), {
        cwd: dir,
        env: renderEnv(),
      })

      if (result.timedOut) {
        throw new ResumeRenderError(
          `Не удалось собрать PDF: вёрстка не уложилась в ${RENDER_TIMEOUT_MS / 1000} с.`,
          result.stderr,
        )
      }
      if (result.code !== 0) {
        this.logger.warn(`Typst exited ${String(result.code)}: ${result.stderr}`)
        throw new ResumeRenderError(
          'Не удалось собрать PDF по шаблону резюме. Проверьте оформление или обратитесь к администратору.',
          result.stderr,
        )
      }

      const pdf = await readFile(outPath)
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new ResumeRenderError('Сборка PDF завершилась, но файл не является PDF.')
      }
      return pdf
    } catch (err: unknown) {
      if (err instanceof ResumeRenderError) throw err
      const detail = err instanceof Error ? err.message : 'unknown'
      this.logger.error(`Resume render failed: ${detail}`)
      throw new ResumeRenderError('Не удалось собрать PDF резюме.', detail)
    } finally {
      // The directory holds personal data (the whole CV, in clear). It goes
      // away on every path, including the timeout and the throw.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Build the JSON the template receives.
   *
   * Two things happen here and both are load-bearing:
   *   - the layout is NORMALISED, so the template is handed a total, ordered,
   *     duplicate-free list and never has to defend itself against storage;
   *   - every string passes through `toRenderableDeep`, so no codepoint the
   *     embedded fonts cannot draw ever reaches the typesetter (see
   *     resume-glyphs — hryvnia is missing from Roboto, ruble is not).
   *
   * Serialised with sorted keys: `JSON.stringify` follows insertion order, and
   * a fingerprint that changes when an object is rebuilt in a different order
   * would invalidate a cached PDF for no reason.
   */
  private serialiseInput(input: ResumeRenderInput): { payload: string; dropped: string[] } {
    const safe = toRenderableDeep({
      displayName: input.displayName,
      content: input.content,
      layout: normalizeResumeLayout(input.layout),
    })
    const templateKey = createHash('sha256')
      .update(input.templateSource ?? loadDefaultTemplate())
      .digest('hex')

    return {
      // The template's identity is part of the payload so that changing the
      // template changes the fingerprint — otherwise a redesigned default would
      // keep serving everyone's old cached PDF.
      payload: stableStringify({ ...safe.value, templateKey }),
      dropped: safe.dropped,
    }
  }
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/**
 * Where the Typst binary is.
 *
 * `TYPST_BIN` for the production image (DevOps pins the version and the path
 * there); a bare `typst` off PATH for a developer machine.
 */
export function typstBinary(): string {
  return process.env['TYPST_BIN']?.trim() || 'typst'
}

/** The full argument list — exported so the spec can assert on it directly. */
export function buildArgs(dir: string, outPath: string): string[] {
  return [
    'compile',
    // Nothing outside the scratch directory is readable by the template.
    '--root',
    dir,
    '--font-path',
    resolveAssetPath('fonts'),
    // Determinism: only OUR fonts, whatever the host happens to have installed.
    '--ignore-system-fonts',
    '--ignore-embedded-fonts',
    // Package imports resolve inside the sandbox, so a template cannot poison a
    // shared cache — and, with no packages there, cannot silently pull code.
    '--package-path',
    join(dir, 'packages'),
    '--package-cache-path',
    join(dir, 'package-cache'),
    // Determinism: a fixed creation date in the PDF metadata.
    '--creation-timestamp',
    '0',
    // Determinism + a quieter CPU footprint.
    '--jobs',
    '1',
    '--diagnostic-format',
    'short',
    join(dir, 'main.typ'),
    outPath,
  ]
}

/**
 * A deliberately bare environment.
 *
 * Only `PATH` (to find a bare `typst`) and the reproducible-builds epoch. The
 * API's own environment holds database URLs, S3 credentials and the Workers AI
 * token; none of that has any business being visible to a typesetter driven by
 * an uploaded document.
 */
export function renderEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    SOURCE_DATE_EPOCH: '0',
  }
}

/** The rlimits requested, so a test can assert them without a platform check. */
export function describeLimits(): { addressSpaceKb: number; cpuSeconds: number } {
  return { addressSpaceKb: RENDER_ADDRESS_SPACE_KB, cpuSeconds: RENDER_CPU_SECONDS }
}

/**
 * The production runner: asynchronous `spawn`, niced down, deadline-killed.
 *
 * Never resolves before the process is gone, and never rejects — a non-zero
 * exit is data for the caller, not an exception.
 */
const spawnTypst: TypstRunner = (bin, args, options) =>
  new Promise((resolve) => {
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        RLIMIT_WRAPPER,
        'crm-resume-render',
        String(RENDER_ADDRESS_SPACE_KB),
        String(RENDER_CPU_SECONDS),
        bin,
        ...args,
      ],
      { cwd: options.cwd, env: options.env, stdio: ['ignore', 'ignore', 'pipe'] },
    )

    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, RENDER_NICENESS)
      } catch {
        // Not permitted on this platform/user — the other five bounds stand.
      }
    }

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8')
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // SIGKILL, not SIGTERM: a typesetter stuck in a loop owes us no handler.
      child.kill('SIGKILL')
    }, RENDER_TIMEOUT_MS)
    // Do not hold the process open for a render that outlives everything else.
    timer.unref?.()

    const finish = (code: number | null): void => {
      clearTimeout(timer)
      resolve({ code, stderr: stderr.slice(0, MAX_STDERR_BYTES), timedOut })
    }

    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })

// ---------------------------------------------------------------------------
// The default template
// ---------------------------------------------------------------------------

let defaultTemplateCache: string | null = null

/**
 * The one template shipped in this repo, for every senior without a personal
 * one. Read once per process — it is a static asset, like the fonts.
 */
export function loadDefaultTemplate(): string {
  if (defaultTemplateCache === null) {
    defaultTemplateCache = readFileSync(resolveAssetPath('typst/default-resume.typ'), 'utf8')
  }
  return defaultTemplateCache
}

/** @internal */
export function _clearDefaultTemplateCacheForTesting(): void {
  defaultTemplateCache = null
}

/**
 * `JSON.stringify` with keys in sorted order at every level.
 *
 * Arrays keep their order — in a resume the order of jobs IS data.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => [key, sortKeys(val)]),
    )
  }
  return value
}
