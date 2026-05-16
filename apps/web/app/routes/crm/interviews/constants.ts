import type { InterviewStage } from '@crm/shared'

export const ACTIVE_STAGES: InterviewStage[] = [
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
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

export const STAGE_COLORS: Record<InterviewStage, string> = {
  HR_SCREEN: 'border-l-blue-500',
  ENGLISH_CHECK: 'border-l-purple-500',
  TECH_INTERVIEW: 'border-l-amber-500',
  FINAL_INTERVIEW: 'border-l-orange-500',
  CLIENT_INTERVIEW: 'border-l-cyan-500',
  OFFER_RECEIVED: 'border-l-green-500',
  HIRED: 'border-l-emerald-500',
  REJECTED: 'border-l-red-500',
  ARCHIVED: 'border-l-gray-400',
}

export const STAGE_BADGE_COLORS: Record<InterviewStage, string> = {
  HR_SCREEN: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  ENGLISH_CHECK: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  TECH_INTERVIEW: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  FINAL_INTERVIEW: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  CLIENT_INTERVIEW: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  OFFER_RECEIVED: 'bg-green-500/15 text-green-400 border-green-500/30',
  HIRED: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  REJECTED: 'bg-red-500/15 text-red-400 border-red-500/30',
  ARCHIVED: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
}

export const COLUMN_BORDER: Record<InterviewStage, string> = {
  HR_SCREEN: 'border-blue-500',
  ENGLISH_CHECK: 'border-purple-500',
  TECH_INTERVIEW: 'border-amber-500',
  FINAL_INTERVIEW: 'border-orange-500',
  CLIENT_INTERVIEW: 'border-cyan-500',
  OFFER_RECEIVED: 'border-green-500',
  HIRED: 'border-emerald-500',
  REJECTED: 'border-red-500',
  ARCHIVED: 'border-gray-400',
}

export const COLUMN_HEADER_BG: Record<InterviewStage, string> = {
  HR_SCREEN: 'bg-blue-500/10 text-blue-400',
  ENGLISH_CHECK: 'bg-purple-500/10 text-purple-400',
  TECH_INTERVIEW: 'bg-amber-500/10 text-amber-400',
  FINAL_INTERVIEW: 'bg-orange-500/10 text-orange-400',
  CLIENT_INTERVIEW: 'bg-cyan-500/10 text-cyan-400',
  OFFER_RECEIVED: 'bg-green-500/10 text-green-400',
  HIRED: 'bg-emerald-500/10 text-emerald-400',
  REJECTED: 'bg-red-500/10 text-red-400',
  ARCHIVED: 'bg-gray-500/10 text-gray-400',
}

export const COLUMN_BG: Record<InterviewStage, string> = {
  HR_SCREEN: 'bg-blue-500/[0.04]',
  ENGLISH_CHECK: 'bg-purple-500/[0.04]',
  TECH_INTERVIEW: 'bg-amber-500/[0.04]',
  FINAL_INTERVIEW: 'bg-orange-500/[0.04]',
  CLIENT_INTERVIEW: 'bg-cyan-500/[0.04]',
  OFFER_RECEIVED: 'bg-green-500/[0.04]',
  HIRED: 'bg-emerald-500/[0.04]',
  REJECTED: 'bg-red-500/[0.04]',
  ARCHIVED: 'bg-gray-500/[0.04]',
}

export const STAGE_ORDER: InterviewStage[] = [
  'HR_SCREEN', 'ENGLISH_CHECK', 'TECH_INTERVIEW', 'FINAL_INTERVIEW', 'CLIENT_INTERVIEW',
  'HIRED', 'REJECTED', 'ARCHIVED',
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
