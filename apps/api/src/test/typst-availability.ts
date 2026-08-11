/**
 * Is the Typst binary reachable from this process?
 *
 * DELIBERATELY NOT A SKIP GATE. A suite that quietly does nothing when a tool
 * is missing is the exact failure this project keeps paying for: the check
 * reports green, nobody reads the word "skipped", and the first real signal
 * arrives from a user. So the specs that need Typst call `assertTypstAvailable`
 * and FAIL with an actionable message when it is absent.
 *
 * Production has it (PR #503 pins 0.15.1 at /usr/local/bin/typst in the API
 * image). A developer machine gets it with one `brew install typst`. CI needs
 * one step in the quality job — named in the failure message so the fix is not
 * a research project.
 */
import { execFileSync } from 'node:child_process'
import { typstBinary } from '../resumes/resume-typst.service'

let cached: { ok: true; version: string } | { ok: false; reason: string } | null = null

export function typstAvailability(): { ok: true; version: string } | { ok: false; reason: string } {
  if (cached) return cached
  try {
    const version = execFileSync(typstBinary(), ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim()
    cached = { ok: true, version }
  } catch (err: unknown) {
    cached = { ok: false, reason: err instanceof Error ? err.message : 'unknown error' }
  }
  return cached
}

export function assertTypstAvailable(): void {
  const availability = typstAvailability()
  if (availability.ok) return
  throw new Error(
    [
      `The Typst binary ("${typstBinary()}") is not runnable, so the resume renderer cannot be tested.`,
      `Reason: ${availability.reason}`,
      '',
      'This is a MISSING TOOL, not a broken test — and it is reported rather than skipped on purpose.',
      '  • locally:  brew install typst   (or set TYPST_BIN to an existing binary)',
      '  • in CI:    add a step to the quality job installing the same 0.15.1 the',
      '              image pins (see apps/api/Dockerfile, stage "typst")',
      '  • in prod:  already present at /usr/local/bin/typst via PR #503',
    ].join('\n'),
  )
}
