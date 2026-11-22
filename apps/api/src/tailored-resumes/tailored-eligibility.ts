import { isLatinScript, type ResumeContent, type TailoredEligibility } from '@crm/shared'

export type EligibilityInput = {
  base: { verificationStatus: string; content: ResumeContent } | null
  displayName: string
  /** True only while a DETAIL_FETCH for the posting is queued (an open 404 or a manual card is not). */
  detailPending: boolean
}

/** The text a tailored run sends to a model; languages, education and links are never sent. */
function sentTexts(c: ResumeContent): string[] {
  return [
    c.summary,
    ...c.skills,
    ...c.experience.flatMap((e) => [e.role, e.company, e.period, ...e.bullets]),
  ]
}

/** Whether a tailored resume can start, in the order the senior must fix things. */
export function eligibilityOf(input: EligibilityInput): TailoredEligibility {
  const { base } = input
  if (base === null || base.verificationStatus !== 'VERIFIED') return 'NO_VERIFIED_RESUME'
  if (!isLatinScript(input.displayName)) return 'NON_LATIN_NAME'
  if (!sentTexts(base.content).every(isLatinScript)) return 'NON_ENGLISH'
  if (input.detailPending) return 'POSTING_PENDING'
  return 'READY'
}
