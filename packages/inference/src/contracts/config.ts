import { z } from 'zod'

export const extractionModelGuardrailsSchema = z.object({
  maxPromptPriceUsdPerMTok: z.number().positive(),
  minContextTokens: z.number().int().positive(),
  preferredModelIds: z.array(z.string().min(1)).optional(),
})
export type ExtractionModelGuardrails = z.infer<typeof extractionModelGuardrailsSchema>

export const inferenceConfigSchema = z.object({
  decision: z
    .object({
      jev: z
        .object({
          apiKey: z.string().min(1),
          baseUrl: z.string().url().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  extraction: z
    .object({
      provider: z.enum(['local', 'openrouter']),
      openrouter: z
        .object({
          apiKey: z.string().min(1),
          guardrails: extractionModelGuardrailsSchema,
          baseUrl: z.string().url().optional(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      local: z
        .object({
          baseUrl: z.string().url(),
          apiKey: z.string().min(1).optional(),
          model: z.string().min(1),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
})
export type InferenceConfig = z.infer<typeof inferenceConfigSchema>
