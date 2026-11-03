/**
 * Gate in front of every external model call: a source's `ai-input` signal (robots `Content-Signal`)
 * decides whether its page text may reach a model at all.
 *
 * Plain literal unions on purpose — the 5.3a robots parser is a parallel PR and is not imported here.
 */
export type AiInputSignal = 'yes' | 'no' | 'unspecified'

export interface ModelInputPolicy {
  /** What to do when the source states nothing. Required, no default: every caller chooses. */
  readonly onUnspecified: 'allow' | 'block'
}

export type ModelGateDecision = 'ALLOWED' | 'BLOCKED_AI_INPUT_NO' | 'BLOCKED_AI_INPUT_UNSPECIFIED'

/**
 * Fails closed: only an exact `'yes'`, or an exact `'unspecified'` with an exact `'allow'`, is
 * ALLOWED. `'no'` and any value outside the union (an untyped caller) are BLOCKED_AI_INPUT_NO.
 */
export function assertModelAllowed(
  aiInput: AiInputSignal,
  policy: ModelInputPolicy,
): ModelGateDecision {
  if (aiInput === 'yes') return 'ALLOWED'
  if (aiInput !== 'unspecified') return 'BLOCKED_AI_INPUT_NO'
  return policy.onUnspecified === 'allow' ? 'ALLOWED' : 'BLOCKED_AI_INPUT_UNSPECIFIED'
}
