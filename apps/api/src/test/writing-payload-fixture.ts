import { EMPTY_RESUME_FACTS, type ResumeFacts } from '@crm/shared'
import type { WritingPayload } from '../extraction-worker/link-contract'
import { writingPayload } from '../resumes/verification/content-gates'
import { deriveFrozenContent } from '../resumes/verification/derive-content'

/**
 * The one `resume-write` payload fixture for the worker specs (CR-M-1, item 460).
 *
 * It lives here, not beside the specs, because `src/test/**` is on the mutation gate's never-mutate
 * list: a fixture's literals are covered by every spec that loads it and killable by none, so the
 * same file under `extraction-worker/` would answer the changed-lines gate with survivors.
 *
 * Two experience items — one still current with no end month, one ended — so a spec can assert on
 * both the `current` and the closed shape without building its own facts.
 */
export const WRITING_PAYLOAD_FACTS: ResumeFacts = {
  ...EMPTY_RESUME_FACTS,
  headline: 'Backend engineer',
  skills: ['TypeScript', 'PostgreSQL'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Engineer',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['Node'],
      notes: ['Built the billing service'],
    },
    {
      company: 'Globex',
      role: 'Developer',
      location: null,
      start: '2018-01',
      end: '2021-02',
      current: false,
      technologies: [],
      notes: [],
    },
  ],
}

/**
 * The payload the API really sends, built through its only producer rather than hand-written, so a
 * drift between the producer and the worker's strict schema fails a spec instead of passing it
 * (AC3). No contact context: the caller's redaction has its own spec, and these are about the shape.
 */
export function writingPayloadFixture(facts: ResumeFacts = WRITING_PAYLOAD_FACTS): WritingPayload {
  return writingPayload({
    facts,
    frozen: deriveFrozenContent(facts),
    contacts: [],
    template: 'classic',
    now: new Date('2026-11-18T12:00:00Z'),
  })
}
