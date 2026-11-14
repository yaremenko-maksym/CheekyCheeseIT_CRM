/**
 * The model-health vocabularies live three times: the Drizzle CHECK lists, the forward SQL (written
 * by hand) and the router's route names. This holds them to each other, with no database: a value
 * added to one but not the others fails here rather than at an INSERT. The columns and constraints
 * themselves are compared in `job-model-health-ddl.integration.spec.ts`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOSTED_PROVIDERS } from '@crm/inference'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { PRIVILEGE_CLASSES, STAGED_RELATIONS } from './privileges/privilege-classes'
import {
  jobModelHealthFlags,
  jobModelRouteDaily,
  MODEL_HEALTH_FLAG_VALUES,
  MODEL_ROUTE_VALUES,
} from './schema'

const DDL_FILE = 'drizzle/manual/2026-11-06_job_model_health.sql'
const ddl = readFileSync(join(__dirname, '..', '..', DDL_FILE), 'utf8')

describe('job_model_route_daily and job_model_health_flags vocabularies', () => {
  it('the route list is the router providers, so a new provider cannot fail its counter', () => {
    expect(MODEL_ROUTE_VALUES).toEqual([...HOSTED_PROVIDERS, 'local'])
  })

  it('the flags are the five §5.3 signals', () => {
    expect(MODEL_HEALTH_FLAG_VALUES).toEqual([
      'MODEL_UNREACHABLE',
      'HOSTED_ROUTES_DEAD',
      'MODEL_LIST_STALE',
      'FAILED_JOB_DAILY',
      'FAILED_JOB_CHAIN',
    ])
  })

  it('the staged SQL carries the same lists and the same code alphabet', () => {
    const inList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')
    expect(ddl).toContain(`IN (${inList(MODEL_ROUTE_VALUES)})`)
    expect(ddl).toContain(`IN (${inList(MODEL_HEALTH_FLAG_VALUES)})`)
    expect(ddl).toContain(`"code" ~ '^[A-Z][A-Z0-9_]{0,63}$'`)
  })

  it('every CHECK the Drizzle schema declares is named in the staged SQL', () => {
    const names = [jobModelRouteDaily, jobModelHealthFlags].flatMap((t) =>
      getTableConfig(t).checks.map((c) => c.name),
    )
    expect(names.length).toBe(4)
    expect(names.filter((n) => !ddl.includes(n))).toEqual([])
  })

  it.each(['job_model_route_daily', 'job_model_health_flags'])(
    '%s is class A and no longer staged (promoted to manual/, backlog 434)',
    (table) => {
      expect(PRIVILEGE_CLASSES.A).toContain(table)
      expect(STAGED_RELATIONS[table]).toBeUndefined()
    },
  )
})
