/**
 * Regenerate the template picker thumbnails (verified-base-resume spec §5.6, Q2).
 *
 * Renders page 1 of the synthetic ATS fixture `current-job` once per catalog
 * template, through the API's own Typst render path (`ResumeTypstService.renderPng`),
 * so the four images differ only by look. Synthetic data only — no real person.
 * Run it again whenever a template under `src/assets/typst/` changes.
 *
 * Usage:
 *   pnpm --filter @crm/api exec tsx scripts/render-resume-thumbnails.ts
 */
import 'reflect-metadata'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { DEFAULT_RESUME_LAYOUT, RESUME_TEMPLATE_NAMES } from '@crm/shared'
import { ResumeTypstService } from '../src/resumes/resume-typst.service'
import { ATS_FIXTURES } from '../src/resumes/ats/__ats__/fixtures'

const OUT_DIR = join(__dirname, '../../web/public/resume-templates')
const WIDTH = 320

async function main(): Promise<void> {
  const fixture = ATS_FIXTURES.find((f) => f.name === 'current-job')
  if (!fixture) throw new Error('ATS fixture "current-job" not found')
  const typst = new ResumeTypstService()
  mkdirSync(OUT_DIR, { recursive: true })
  for (const templateName of RESUME_TEMPLATE_NAMES) {
    const [page1] = await typst.renderPng({
      displayName: fixture.displayName,
      email: fixture.email,
      content: fixture.content,
      layout: DEFAULT_RESUME_LAYOUT,
      templateName,
      templateSource: null,
    })
    if (!page1) throw new Error(`no page rendered for ${templateName}`)
    const png = await sharp(page1)
      .resize({ width: WIDTH })
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer()
    const out = join(OUT_DIR, `${templateName}.png`)
    writeFileSync(out, png)
    console.log(`${out} ${png.length} bytes`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
