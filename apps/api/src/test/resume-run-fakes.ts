/**
 * Fakes of Typst and the PDF extractor for the verification run specs (Task 14). The fake render
 * encodes its input in the buffer; the fake extractor turns that input back into page text shaped
 * like what `unpdf` returns for the skeleton (see resume-ats-checker.spec.ts), so the REAL ATS
 * checker runs on it. The real render, extract and ATS chain is pinned by the ATS specs.
 */
import type { ResumeContent } from '@crm/shared'
import type { ResumeRenderInput } from '../resumes/resume-typst.service'

export const PDF_MAGIC = '%PDF-FAKE\n'
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export const encodePdf = (input: ResumeRenderInput): Buffer =>
  Buffer.concat([Buffer.from(PDF_MAGIC), Buffer.from(JSON.stringify(input))])
export const encodePng = (input: ResumeRenderInput): Buffer =>
  Buffer.concat([PNG_MAGIC, Buffer.from(JSON.stringify(input))])
export const decodePdf = (pdf: Buffer) =>
  JSON.parse(pdf.subarray(PDF_MAGIC.length).toString('utf8')) as ResumeRenderInput
export const decodePng = (png: Buffer) =>
  JSON.parse(png.subarray(PNG_MAGIC.length).toString('utf8')) as ResumeRenderInput

const TITLES: Record<string, string> = {
  summary: 'Summary',
  skills: 'Skills',
  experience: 'Experience',
  education: 'Education',
  languages: 'Languages',
  links: 'Links',
}

/** The skeleton's text lines for an input, in the order `unpdf` reads them. */
export function skeletonLines(input: ResumeRenderInput, opts: { omitEmail: boolean }): string[] {
  const c: ResumeContent = input.content
  const lines = [input.displayName, ...(opts.omitEmail ? [] : [input.email])]
  const hidden = new Set(input.layout.hiddenSections)
  for (const key of input.layout.sectionOrder.filter((k) => !hidden.has(k))) {
    lines.push(TITLES[key] as string)
    if (key === 'summary') lines.push(c.summary)
    if (key === 'skills') lines.push(c.skills.join(' · '))
    if (key === 'experience') {
      for (const item of c.experience) {
        lines.push(item.role, item.company, item.period, ...item.bullets.map((b) => `• ${b}`))
      }
    }
    if (key === 'education') {
      for (const item of c.education) lines.push(item.institution, item.degree, item.period)
    }
    if (key === 'languages') for (const l of c.languages) lines.push(`${l.name} — ${l.level}`)
    if (key === 'links') for (const l of c.links) lines.push(l.label)
  }
  return lines
}

/** `lines` cut into `n` pages of equal line count (the last one may be shorter). */
export function splitPages(lines: string[], n: number): string[] {
  const per = Math.ceil(lines.length / n)
  return Array.from({ length: n }, (_, i) => lines.slice(i * per, (i + 1) * per).join('\n'))
}
