import { z } from 'zod'

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    API_PORT: z.coerce.number().default(3001),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_CALLBACK_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    SESSION_SECRET: z.string().min(32),
    FRONTEND_URL: z.string().min(1),

    // S3 / MinIO (PHASE 6 — Documents). Dev defaults point to local MinIO.
    // AWS_* defaults to 'minioadmin' for local convenience; production safety
    // enforced via refine() below (NODE_ENV=production + minioadmin → throw).
    // Prod: see docs/runbooks/s3-storage.md.
    S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('crm-documents'),
    S3_USE_SSE: z.coerce.boolean().default(true),
    AWS_ACCESS_KEY_ID: z.string().min(1).default('minioadmin'),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  })
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.AWS_ACCESS_KEY_ID !== 'minioadmin',
    {
      message:
        'AWS_ACCESS_KEY_ID must be overridden in production (minioadmin default is for dev/MinIO only)',
      path: ['AWS_ACCESS_KEY_ID'],
    },
  )
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.AWS_SECRET_ACCESS_KEY !== 'minioadmin',
    {
      message:
        'AWS_SECRET_ACCESS_KEY must be overridden in production (minioadmin default is for dev/MinIO only)',
      path: ['AWS_SECRET_ACCESS_KEY'],
    },
  )

export type Env = z.infer<typeof envSchema>

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment variables:\n${issues}`)
  }
  return result.data
}
