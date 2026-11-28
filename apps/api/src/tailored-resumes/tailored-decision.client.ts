import { createJevDecisionAdapter, type DecisionPort, type DecisionQuestion } from '@crm/inference'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { decideAll, type DecisionAnswers } from './jev-decide'

/**
 * The tailored resume's Jev judges (injection check, skill gaps, reviewer), the
 * `ResumeEntailmentClient` constructor pattern over `JEV_API_KEY`.
 *
 * Precondition (R19): the caller has redacted the senior's contacts from the state. It never logs
 * the state, the questions or Jev text.
 */
@Injectable()
export class TailoredDecisionClient {
  private readonly port: DecisionPort | undefined

  constructor(config: ConfigService<Env, true>) {
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — `infer` only types the return
    const apiKey = config.get('JEV_API_KEY', { infer: true })
    this.port = apiKey ? createJevDecisionAdapter({ apiKey }) : undefined
  }

  decide(
    state: Record<string, unknown>,
    questions: readonly DecisionQuestion[],
    /** What is left before the run's deadline (see `decideRetrying`). */
    budgetLeftMs?: () => number,
  ): Promise<DecisionAnswers> {
    if (this.port === undefined) {
      return Promise.resolve({ kind: 'unavailable', cause: 'NOT_CONFIGURED' })
    }
    return decideAll(this.port, state, questions, budgetLeftMs)
  }
}
