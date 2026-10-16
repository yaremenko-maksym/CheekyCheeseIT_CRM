/**
 * Drizzle schema barrel. The schema is split by domain under `./schema/`; this file
 * re-exports every module so `.../database/schema` imports (and drizzle-kit, which
 * reads this file) see exactly the same set of tables, views, enums and relations.
 */
export * from './schema/documents'
export * from './schema/enums'
export * from './schema/users'
export * from './schema/projects'
export * from './schema/interviews'
export * from './schema/finance'
export * from './schema/transactions'
export * from './schema/notifications'
export * from './schema/audit'
export * from './schema/vacancies'
export * from './schema/job-metering'
export * from './schema/job-sourcing'
export * from './schema/job-opportunities'
export * from './schema/job-collection'
export * from './schema/telemetry'
export * from './schema/resumes'
