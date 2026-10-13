export const INFERENCE_ERROR_CODES = [
  'NOT_CONFIGURED',
  'PROVIDER_ERROR',
  'INVALID_OUTPUT',
  'RATE_LIMITED',
  'TIMEOUT',
] as const
export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number]
