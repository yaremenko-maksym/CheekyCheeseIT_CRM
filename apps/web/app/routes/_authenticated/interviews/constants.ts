import type { InterviewStage } from '@crm/shared'

export const ACTIVE_STAGES: InterviewStage[] = [
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
  'OFFER_RECEIVED',
]

export const TERMINAL_STAGES: InterviewStage[] = ['HIRED', 'REJECTED', 'ARCHIVED']

export const ALL_STAGES: InterviewStage[] = [...ACTIVE_STAGES, ...TERMINAL_STAGES]

export const STAGE_LABELS: Record<InterviewStage, string> = {
  HR_SCREEN: 'HR Screen',
  ENGLISH_CHECK: 'English',
  TECH_INTERVIEW: 'Tech',
  FINAL_INTERVIEW: 'Final',
  CLIENT_INTERVIEW: 'Client',
  OFFER_RECEIVED: 'Offer',
  HIRED: 'Нанят',
  REJECTED: 'Отказ',
  ARCHIVED: 'Архив',
}

// Stage colors — semantic, harmonised palette (owner verdict 2026-06-23).
// Active stages: vivid enough to distinguish, not "acid".
// Terminal stages (HIRED / REJECTED / ARCHIVED): subdued — they recede relative
// to the active pipeline. Brand yellow is NOT used here (reserved for CTA/shell).
export const STAGE_COLORS: Record<InterviewStage, string> = {
  // Active pipeline — clear semantic hues, harmonised intensity
  HR_SCREEN: 'border-l-blue-400',
  ENGLISH_CHECK: 'border-l-violet-400',
  TECH_INTERVIEW: 'border-l-amber-400',
  FINAL_INTERVIEW: 'border-l-orange-400',
  CLIENT_INTERVIEW: 'border-l-sky-400',
  OFFER_RECEIVED: 'border-l-emerald-400',
  // Terminal — muted (darker/lower chroma)
  HIRED: 'border-l-emerald-600',
  REJECTED: 'border-l-rose-700',
  ARCHIVED: 'border-l-zinc-500',
}

export const STAGE_BADGE_COLORS: Record<InterviewStage, string> = {
  HR_SCREEN: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  ENGLISH_CHECK: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
  TECH_INTERVIEW: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  FINAL_INTERVIEW: 'bg-orange-500/10 text-orange-300 border-orange-500/20',
  CLIENT_INTERVIEW: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  OFFER_RECEIVED: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  HIRED: 'bg-emerald-900/40 text-emerald-500 border-emerald-700/30',
  REJECTED: 'bg-rose-900/30 text-rose-500 border-rose-800/30',
  ARCHIVED: 'bg-zinc-800/50 text-zinc-400 border-zinc-700/30',
}

export const COLUMN_BORDER: Record<InterviewStage, string> = {
  HR_SCREEN: 'border-blue-500/40',
  ENGLISH_CHECK: 'border-violet-500/40',
  TECH_INTERVIEW: 'border-amber-500/40',
  FINAL_INTERVIEW: 'border-orange-500/40',
  CLIENT_INTERVIEW: 'border-sky-500/40',
  OFFER_RECEIVED: 'border-emerald-500/40',
  HIRED: 'border-emerald-700/30',
  REJECTED: 'border-rose-800/30',
  ARCHIVED: 'border-zinc-700/30',
}

// Column header — stage label + count badge
export const COLUMN_HEADER_BG: Record<InterviewStage, string> = {
  HR_SCREEN: 'bg-blue-500/10 text-blue-300',
  ENGLISH_CHECK: 'bg-violet-500/10 text-violet-300',
  TECH_INTERVIEW: 'bg-amber-500/10 text-amber-300',
  FINAL_INTERVIEW: 'bg-orange-500/10 text-orange-300',
  CLIENT_INTERVIEW: 'bg-sky-500/10 text-sky-300',
  OFFER_RECEIVED: 'bg-emerald-500/10 text-emerald-300',
  // Terminal — muted backgrounds
  HIRED: 'bg-emerald-900/30 text-emerald-500',
  REJECTED: 'bg-rose-900/20 text-rose-500',
  ARCHIVED: 'bg-zinc-800/40 text-zinc-400',
}

// Column background — very subtle tint for spatial grouping
export const COLUMN_BG: Record<InterviewStage, string> = {
  HR_SCREEN: 'bg-blue-500/[0.03]',
  ENGLISH_CHECK: 'bg-violet-500/[0.03]',
  TECH_INTERVIEW: 'bg-amber-500/[0.03]',
  FINAL_INTERVIEW: 'bg-orange-500/[0.03]',
  CLIENT_INTERVIEW: 'bg-sky-500/[0.03]',
  OFFER_RECEIVED: 'bg-emerald-500/[0.03]',
  HIRED: 'bg-emerald-950/[0.04]',
  REJECTED: 'bg-rose-950/[0.04]',
  ARCHIVED: 'bg-zinc-900/[0.05]',
}

export const STAGE_ORDER: InterviewStage[] = [
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
  'OFFER_RECEIVED',
  'HIRED',
  'REJECTED',
  'ARCHIVED',
]

export function getNextStage(stage: InterviewStage): InterviewStage | null {
  const activeIdx = ACTIVE_STAGES.indexOf(stage)
  if (activeIdx < 0 || activeIdx >= ACTIVE_STAGES.length - 1) return null
  return ACTIVE_STAGES[activeIdx + 1] ?? null
}

export function getPrevStage(stage: InterviewStage): InterviewStage | null {
  const activeIdx = ACTIVE_STAGES.indexOf(stage)
  if (activeIdx <= 0) return null
  return ACTIVE_STAGES[activeIdx - 1] ?? null
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })
}
