import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR 2026-11-03 §2.4 / 5.4c-3: the API process holds no hosted key and no router URL, and the
 * extraction port has one consumer. A new reader or caller is a failing test, not a silent widening:
 * extend the lists below only with the ADR behind it.
 */
const SRC = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : []
  })
}

function filesMatching(pattern: RegExp): string[] {
  const files = sources(SRC)
  expect(files.length).toBeGreaterThan(100)
  return files
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f).split(sep).join('/'))
    .sort()
}

describe('extraction boundary (5.4c-3)', () => {
  it('only the worker, its env schema and its config builder name a hosted key or the router URL (AC1)', () => {
    const readers = filesMatching(/GEMINI_API_KEY|GROQ_API_KEY|ROUTER_LOCAL_MODEL_URL/)
    expect(readers.filter((f) => !f.startsWith('extraction-worker/'))).toEqual([
      'config/env.ts',
      'inference/build-inference-config.ts',
    ])
  })

  it('only the worker and its config builder name the worker env parsers (SR-M-2)', () => {
    // build-inference-config holds the worker env schema and the router config builder.
    const users = filesMatching(/\b(parseWorkerEnv|buildRouterConfig|extractionWorkerEnvSchema)\b/)
    expect(users.filter((f) => !f.startsWith('extraction-worker/'))).toEqual([
      'inference/build-inference-config.ts',
    ])
  })

  it('outside the worker, only the link contract is imported from it (SR-M-2)', () => {
    const imports = sources(SRC)
      .filter((f) => !relative(SRC, f).startsWith('extraction-worker'))
      .flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/from '[./]*\/extraction-worker\/([\w-]+)'/g)].map(
          (m) => `${relative(SRC, f).split(sep).join('/')} -> ${m[1]}`,
        ),
      )
    expect(imports).toEqual([
      // Bookmarklet block map: the block pick builds the /pick-blocks body and reads its reply type.
      'job-sourcing/queue/block-pick.service.ts -> link-contract',
      // Task 6b: Jev's block pick reads the same rendered block list the worker's model reads.
      'job-sourcing/queue/jev-block-pick.ts -> link-contract',
      // jev-offload Part B: the Jev role classifier reads the role definitions and the reply schema.
      'job-sourcing/role-ai/jev-role-classifier.ts -> link-contract',
      // Senior roles PR 3: the role classifier client reads the /classify-roles wire contract.
      'job-sourcing/role-ai/role-classifier.client.ts -> link-contract',
      'job-sourcing/structuring/model-extraction-wiring.ts -> link-contract',
      'resumes/verification/inference-clients.ts -> link-contract',
      // Tailored resume PR 2: the tailor writer client reads the /resume-tailor wire contract.
      'tailored-resumes/tailor-writer.client.ts -> link-contract',
      // Tailored resume PR 3: the /resume-tailor body (posting cap, schema, worker message size).
      'tailored-resumes/tailored-generate.ts -> link-contract',
      'tailored-resumes/tailored-prepare.ts -> link-contract',
      'tailored-resumes/tailored-requirements.ts -> link-contract',
    ])
  })

  it('ModelStructurer is the only consumer of the extraction port outside the worker (AC6)', () => {
    const consumers = filesMatching(/\bExtractionPort\b/)
    expect(consumers.filter((f) => !f.startsWith('extraction-worker/'))).toEqual([
      'job-sourcing/structuring/model-structurer.ts',
    ])
  })

  it('the collection side builds the port in one place only, over the worker adapter (AC2, AC6)', () => {
    const builders = filesMatching(/\bcreate\w*Extraction\w*Adapter\s*\(/)
    expect(builders.filter((f) => !f.startsWith('extraction-worker/'))).toEqual([
      'job-sourcing/structuring/model-extraction-wiring.ts',
    ])
  })
})
