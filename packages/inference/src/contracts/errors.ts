export const INFERENCE_ERROR_CODES = [
  'NOT_CONFIGURED',
  'PROVIDER_ERROR',
  'INVALID_OUTPUT',
  'RATE_LIMITED',
  'TIMEOUT',
  /**
   * No answer, and every available hosted route is limit-blocked for the provider day (own cap,
   * spent models, the CREDIT bit). Carries no reset time (ADR Amendment 2026-11-08, H.2).
   */
  'LIMITS_EXHAUSTED',
] as const
export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number]
