import type { ResumeContent } from '@crm/shared'
import { RunFailure, type GateResult } from '../resumes/verification/content-gates'
import {
  renderAccepted,
  visualGate,
  type Accepted,
  type RenderDeps,
} from '../resumes/verification/render-gates'
import type { PreparedRun } from './tailored-prepare'

/** Content drops of the layout stage, a budget outside its 3 layout rounds. */
export const MAX_CONTENT_DROPS = 6
/** D9: at most 4 visual checks, so at most 8 vision calls. */
export const MAX_VISUAL_ROUNDS = 3

/** Spec §6.4 item 16: never longer than the base, and never over two pages. */
export const tailoredPageLimit = (basePages: number): number => Math.min(2, basePages)

/**
 * The content without its lowest-relevance bullet. Scores are looked up by text (paths shift after
 * a drop); a text with no score ranks 0. An item's last bullet never goes; a tie drops the later
 * item's, then the later bullet. `null` when every item is down to one bullet.
 */
export function dropLowest(
  content: ResumeContent,
  relevance: ReadonlyMap<string, number>,
): ResumeContent | null {
  let pick: { i: number; j: number; score: number } | null = null
  content.experience.forEach((item, i) => {
    if (item.bullets.length < 2) return
    item.bullets.forEach((text, j) => {
      const score = relevance.get(text) ?? 0
      if (pick === null || score <= pick.score) pick = { i, j, score }
    })
  })
  if (pick === null) return null
  const { i, j } = pick
  return {
    ...content,
    experience: content.experience.map((item, k) =>
      k === i ? { ...item, bullets: item.bullets.filter((_, n) => n !== j) } : item,
    ),
  }
}

/**
 * Stages RENDERING and VISUAL_CHECK: the deterministic gates under the base's page limit (bullets
 * dropped once the layout knobs are spent), then the vision check of the placeholder copy. A
 * confirmed visual finding drops one more bullet and runs both again from the accepted result, up
 * to 3 times; then LAYOUT_UNFIXABLE with the visual items. Every other failure passes through.
 */
export async function renderVerified(
  content: ResumeContent,
  prepared: PreparedRun,
  relevance: ReadonlyMap<string, number>,
  deps: RenderDeps,
): Promise<{ accepted: Accepted; visual: GateResult }> {
  const { base } = prepared
  let current = { content, layout: base.layout, fallbacks: [] as string[] }
  for (let round = 0; ; round++) {
    const accepted = await renderAccepted(
      {
        displayName: prepared.displayName,
        email: prepared.email,
        ...current,
        templateName: base.templateName,
        // The revert target of an ATS failure on a tailored field (spec §6.4 item 14).
        notes: base.content,
        // Stryker disable next-line ArrayDeclaration: equivalent — a run has no human-edited path, and any non-path string covers no ATS path
        editedPaths: [],
        maxPages: tailoredPageLimit(base.pdfPages),
        shrinkContent: (c) => dropLowest(c, relevance),
        maxContentDrops: MAX_CONTENT_DROPS,
      },
      deps,
    )
    try {
      const visual = await visualGate(accepted, base.templateName, prepared.contacts, deps)
      return { accepted, visual }
    } catch (err) {
      if (!(err instanceof RunFailure) || err.code !== 'VISUAL_CHECK_FAILED') throw err
      const next = round < MAX_VISUAL_ROUNDS ? dropLowest(accepted.content, relevance) : null
      if (next === null) throw new RunFailure('LAYOUT_UNFIXABLE', err.gates)
      current = { content: next, layout: accepted.layout, fallbacks: accepted.fallbacks }
    }
  }
}
