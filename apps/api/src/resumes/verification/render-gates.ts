import type {
  ResumeContent,
  ResumeLayoutOptions,
  ResumeReportReason,
  ResumeSectionKey,
  ResumeTemplateName,
} from '@crm/shared'
import { checkResumeAts, type AtsCheckInput, type AtsFailure } from '../ats/resume-ats-checker'
import { toRenderableDeep } from '../resume-glyphs'
import { MAX_PDF_PAGES } from '../resume-source.util'
import { loadCatalogTemplate, type ResumeRenderInput } from '../resume-typst.service'
import type { ContactContext } from './contact-scan'
import { redactAll, RunFailure, type GateResult } from './content-gates'
import { unavailableOrigin, VISUAL_PROVIDER, type VisualReply } from './inference-clients'

export interface RenderDeps {
  typst: {
    render(input: ResumeRenderInput): Promise<Buffer>
    renderPng(input: ResumeRenderInput): Promise<Buffer[]>
  }
  extraction: {
    countRenderedPages(pdf: Buffer): Promise<number>
    extractRenderedPages(pdf: Buffer): Promise<string[]>
  }
  vision: { check(pngPages: Buffer[]): Promise<VisualReply> }
  /** Runs before every model call; throws `RunFailure('STALLED')` past the run budget. */
  beforeModelCall(): Promise<void>
}

export interface RenderPlan {
  displayName: string
  email: string
  /** Raw content (P11): `render()` gets it as is, so fingerprints match the confirm step. */
  content: ResumeContent
  layout: ResumeLayoutOptions
  templateName: ResumeTemplateName
  /** The AI paths' fallback values: summary `''`, each item's bullets its cleaned notes. */
  notes: ResumeContent
  /** Paths that already hold the fallback (stage 4). */
  fallbacks: string[]
  /** Human-edited paths: never reverted silently (`staged_edited_paths`). */
  editedPaths: string[]
}

export interface Accepted {
  pdf: Buffer
  content: ResumeContent
  layout: ResumeLayoutOptions
  gates: GateResult[]
  fallbacks: string[]
}

/** Repair rounds of the layout stage before LAYOUT_UNFIXABLE. */
const MAX_REPAIR_ROUNDS = 3
/** The last page holds at least this share of the average line count of the full pages. */
const MIN_LAST_PAGE_FILL = 0.25
const DENSITY_STEPS = ['relaxed', 'normal', 'compact'] as const
const FONT_STEPS = ['large', 'normal', 'small'] as const
const LAYOUT_CODES = new Set<AtsFailure['code']>(['TOO_MANY_PAGES', 'TOO_LARGE'])

/** One step denser: density first, then the font scale; `null` when nothing is left to shrink. */
export function shrinkLayout(layout: ResumeLayoutOptions): ResumeLayoutOptions | null {
  const d = DENSITY_STEPS.indexOf(layout.density)
  const nextDensity = DENSITY_STEPS[d + 1]
  if (nextDensity !== undefined) return { ...layout, density: nextDensity }
  const nextFont = FONT_STEPS[FONT_STEPS.indexOf(layout.fontScale) + 1]
  return nextFont !== undefined ? { ...layout, fontScale: nextFont } : null
}

/** A last page with under a quarter of the average line count of the pages before it. */
export function lastPageUnderfilled(pages: readonly string[]): boolean {
  // Stryker disable next-line ConditionalExpression: equivalent — with under 2 pages the average of no full pages is NaN and the comparison below is false anyway; the guard says so plainly
  if (pages.length < 2) return false
  const lines = pages.map((page) => page.split('\n').filter((l) => l.trim() !== '').length)
  const full = lines.slice(0, -1)
  const average = full.reduce((sum, n) => sum + n, 0) / full.length
  return (lines.at(-1) ?? 0) < MIN_LAST_PAGE_FILL * average
}

/** The fallback path of an ATS failure on an AI-written field, else `null`. */
/** The sections completeness (§5.1) requires: experience items, five skills, English among languages. */
const REQUIRED_SECTIONS: readonly ResumeSectionKey[] = ['skills', 'experience', 'languages']

/**
 * CD-1 (spec G4): a layout that hides a section completeness requires leaves the PDF incomplete, so
 * every run kind fails INCOMPLETE on it, a template run on a VERIFIED resume included.
 */
export function hidesRequiredSection(layout: ResumeLayoutOptions): boolean {
  return layout.hiddenSections.some((key) => REQUIRED_SECTIONS.includes(key))
}

export function aiPath(atsPath: string | undefined): string | null {
  if (atsPath === 'summary') return 'summary'
  // Stryker disable next-line StringLiteral: equivalent — any other fallback for a missing path is also no bullet path
  const bullet = /^experience\[(\d+)\]\.bullets\[\d+\]$/u.exec(atsPath ?? '')
  return bullet ? `experience.${bullet[1]}.bullets` : null
}

function covers(edited: string, path: string): boolean {
  return edited === path || path.startsWith(`${edited}.`) || edited.startsWith(`${path}.`)
}

function revert(content: ResumeContent, notes: ResumeContent, paths: Set<string>): ResumeContent {
  return {
    ...content,
    summary: paths.has('summary') ? notes.summary : content.summary,
    experience: content.experience.map((item, i) => {
      if (!paths.has(`experience.${i}.bullets`)) return item
      // Stryker disable next-line OptionalChaining: equivalent — notes come from the same facts item by item, so index i exists
      return { ...item, bullets: notes.experience[i]?.bullets ?? [] }
    }),
  }
}

const atsGate = (failures: AtsFailure[]): GateResult => ({
  gate: 'ats',
  ok: failures.length === 0,
  items: failures.map((f) => ({ path: f.path ?? '', reason: f.code })),
})

async function measure(
  pdf: Buffer,
  input: Omit<AtsCheckInput, 'pages' | 'pdfBytes'>,
  deps: RenderDeps,
): Promise<{ other: AtsFailure[]; layout: ResumeReportReason[] }> {
  try {
    if ((await deps.extraction.countRenderedPages(pdf)) > MAX_PDF_PAGES) {
      return { other: [], layout: ['TOO_MANY_PAGES'] }
    }
    const pages = await deps.extraction.extractRenderedPages(pdf)
    const { failures } = checkResumeAts({ ...input, pages, pdfBytes: pdf.length })
    const other = failures.filter((f) => !LAYOUT_CODES.has(f.code))
    // Stryker disable next-line MethodExpression: equivalent — the caller reads `layout` only when `other` is empty, and then every failure is a layout code
    const layout: ResumeReportReason[] = failures
      .filter((f) => LAYOUT_CODES.has(f.code))
      .map((f) => f.code)
    // Read only when `other` is empty, like the codes above.
    if (lastPageUnderfilled(pages)) layout.push('LAST_PAGE_UNDERFILLED')
    return { other, layout }
  } catch {
    throw new RunFailure('ATS_CHECK_FAILED', [
      { gate: 'ats', ok: false, items: [{ path: '', reason: 'UNREADABLE' }] },
    ])
  }
}

/**
 * Stages 5 to 7: glyph check, render, ATS and layout, re-run after every re-render. A failure only on
 * AI paths reverts them to the notes once; a page or size failure shrinks the layout, up to 3 rounds.
 */
export async function renderAccepted(plan: RenderPlan, deps: RenderDeps): Promise<Accepted> {
  const templateSource = loadCatalogTemplate(plan.templateName)
  const fallbacks = new Set(plan.fallbacks)
  let { content, layout } = plan
  let reverted = false
  let rounds = 0
  for (;;) {
    const raw = { displayName: plan.displayName, email: plan.email, content }
    // GLYPH_CHECK_FAILED comes from this run's own normalisation, before anything renders.
    const renderable = toRenderableDeep(raw, plan.templateName)
    if (renderable.dropped.length > 0) {
      throw new RunFailure('GLYPH_CHECK_FAILED', [
        { gate: 'glyph', ok: false, items: [{ path: '', reason: 'DROPPED_GLYPHS' }] },
      ])
    }
    let pdf: Buffer
    try {
      pdf = await deps.typst.render({
        ...raw,
        layout,
        templateName: plan.templateName,
        templateSource,
      })
    } catch {
      throw new RunFailure('RENDER_FAILED', [{ gate: 'render', ok: false, items: [] }])
    }
    const result = await measure(pdf, { ...renderable.value, layout }, deps)

    if (result.other.length > 0) {
      const paths = result.other.map((f) => aiPath(f.path))
      const revertible = paths.every((p): p is string => p !== null && !fallbacks.has(p))
      if (reverted || !revertible) throw new RunFailure('ATS_CHECK_FAILED', [atsGate(result.other)])
      const edited = paths.find((p) => plan.editedPaths.some((e) => covers(e, p)))
      if (edited !== undefined) {
        throw new RunFailure('ATS_CHECK_FAILED', [
          { gate: 'ats', ok: false, items: [{ path: edited, reason: 'HUMAN_EDITED' }] },
        ])
      }
      const set = new Set(paths)
      content = revert(content, plan.notes, set)
      for (const p of set) fallbacks.add(p)
      reverted = true
      continue
    }

    if (result.layout.length > 0) {
      const next = shrinkLayout(layout)
      if (rounds >= MAX_REPAIR_ROUNDS || next === null) {
        throw new RunFailure('LAYOUT_UNFIXABLE', [
          { gate: 'ats', ok: true, items: [] },
          {
            gate: 'layout',
            ok: false,
            items: result.layout.map((reason) => ({ path: '', reason })),
          },
        ])
      }
      layout = next
      rounds++
      continue
    }

    return {
      pdf,
      content,
      layout,
      gates: [atsGate([]), { gate: 'layout', ok: true, items: [] }],
      fallbacks: [...fallbacks],
    }
  }
}

/**
 * The copy the vision model sees: no real name, email or link URL, and every other string redacted
 * field by field (addendum A1: company, role and education are never contact-scanned at submit).
 */
export function placeholderCopy(
  content: ResumeContent,
  contacts: readonly ContactContext[],
): { displayName: string; email: string; content: ResumeContent } {
  const redacted = JSON.parse(JSON.stringify(content), (_key, value: unknown) =>
    typeof value === 'string' ? redactAll(value, contacts) : value,
  ) as ResumeContent
  return {
    displayName: 'Firstname Lastname',
    email: 'name@example.com',
    content: {
      ...redacted,
      links: content.links.map(() => ({ label: 'Link', url: 'https://example.com' })),
    },
  }
}

/**
 * Stage 8: the vision check of the placeholder copy. A finding counts only when a second call reports
 * the same check on the same page; when the confirming call cannot run, the first findings count.
 */
export async function visualGate(
  accepted: Pick<Accepted, 'content' | 'layout'>,
  templateName: ResumeTemplateName,
  contacts: readonly ContactContext[],
  deps: RenderDeps,
): Promise<GateResult> {
  let pngs: Buffer[]
  try {
    pngs = await deps.typst.renderPng({
      ...placeholderCopy(accepted.content, contacts),
      layout: accepted.layout,
      templateName,
      templateSource: loadCatalogTemplate(templateName),
    })
  } catch {
    throw new RunFailure('RENDER_FAILED', [{ gate: 'visual', ok: false, items: [] }])
  }
  await deps.beforeModelCall()
  const first = await deps.vision.check(pngs)
  if (first.kind === 'unavailable') {
    throw new RunFailure(
      'VISUAL_CHECK_UNAVAILABLE',
      [{ gate: 'visual', ok: false, items: [] }],
      unavailableOrigin(VISUAL_PROVIDER, first),
    )
  }
  if (first.findings.length === 0) return { gate: 'visual', ok: true, items: [] }
  await deps.beforeModelCall()
  const second = await deps.vision.check(pngs)
  const confirmed =
    second.kind === 'unavailable'
      ? first.findings
      : first.findings.filter((f) =>
          second.findings.some((s) => s.check === f.check && s.page === f.page),
        )
  // Only the check and page are kept: the finding text is model output.
  const items = confirmed.map((f) => ({ path: `pages.${f.page}`, reason: f.check }))
  if (items.length > 0) {
    throw new RunFailure('VISUAL_CHECK_FAILED', [{ gate: 'visual', ok: false, items }])
  }
  return { gate: 'visual', ok: true, items: [] }
}
