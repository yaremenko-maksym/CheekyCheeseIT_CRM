/**
 * Every Jev question of one tailored-resume stage, ⌈n/50⌉ sequential requests over one state
 * (tailored-resume spec §6: one decision request per stage, chunked at `MAX_DECISION_QUESTIONS`).
 * The `scoreEntailment` rules, generalised to any question kind; `scoreEntailment` is not changed.
 */
import {
  decisionRequestSchema,
  MAX_DECISION_QUESTIONS,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionQuestion,
  type DecisionRequest,
} from '@crm/inference'
import { decideRetrying } from '../resumes/verification/model-retry'

/** `cause` is for the log only: a code, never a message, a question or Jev text. */
export type DecisionUnavailable = { kind: 'unavailable'; cause: string }
export type DecisionAnswers = Map<string, DecisionAnswer> | DecisionUnavailable

const unavailable = (cause: string): DecisionUnavailable => ({ kind: 'unavailable', cause })

/**
 * Each request is retried once on a transient failure (`decideRetrying`).
 * Fails closed: a duplicate id or an invalid request (nothing sent), a thrown port, `ok: false`, an
 * answer count other than asked, a missing, repeated or extra id, or an answer of another kind than
 * its question makes the whole call unavailable.
 */
export async function decideAll(
  port: DecisionPort,
  state: Record<string, unknown>,
  questions: readonly DecisionQuestion[],
): Promise<DecisionAnswers> {
  if (new Set(questions.map((q) => q.id)).size !== questions.length) {
    return unavailable('DUPLICATE_ID')
  }
  const requests: DecisionRequest[] = []
  for (let i = 0; i < questions.length; i += MAX_DECISION_QUESTIONS) {
    const req = decisionRequestSchema.safeParse({
      state,
      questions: questions.slice(i, i + MAX_DECISION_QUESTIONS),
    })
    if (!req.success) return unavailable('INVALID_REQUEST')
    requests.push(req.data)
  }
  const answers = new Map<string, DecisionAnswer>()
  for (const req of requests) {
    const r = await decideRetrying(port, req)
    if (!r.ok) return unavailable(r.code)
    if (r.answers.length !== req.questions.length) return unavailable('ANSWER_COUNT')
    const asked = new Map(req.questions.map((q) => [q.id, q.kind]))
    for (const a of r.answers) {
      if (asked.get(a.id) !== a.kind) return unavailable('INVALID_ANSWER')
      asked.delete(a.id)
      answers.set(a.id, a)
    }
  }
  return answers
}
