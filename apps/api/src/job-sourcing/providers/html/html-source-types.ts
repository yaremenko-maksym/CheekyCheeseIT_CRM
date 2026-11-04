import type { JobSourceType } from '@crm/shared'

/**
 * The seven `*_HTML` source types (constraint C-03): the members the `HtmlProvider` base serves.
 * A literal list rather than a filter over the enum, so adding an `_HTML` member to the shared enum
 * is a decision this file must be edited for — `html-source-types.spec.ts` fails until it is.
 */
export const HTML_SOURCE_TYPES = [
  'JUSTJOIN_HTML',
  'NOFLUFF_HTML',
  'LANDINGJOBS_HTML',
  'NEXTLEVELJOBS_HTML',
  'DICE_HTML',
  'THEHUB_HTML',
  'WTTJ_HTML',
] as const satisfies readonly JobSourceType[]

export type HtmlSourceType = (typeof HTML_SOURCE_TYPES)[number]

const HTML_TYPES: ReadonlySet<string> = new Set(HTML_SOURCE_TYPES)

export function isHtmlSourceType(type: string): type is HtmlSourceType {
  return HTML_TYPES.has(type)
}
