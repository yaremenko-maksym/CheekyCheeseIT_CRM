// Import-free on purpose (CR-H-1): `dirty-work.store` -> `source-record.store` -> `job-run-ledger`
// -> `run-absence-producer` -> `dirty-work.store` is an import cycle, and under CommonJS a constant
// read at module load inside it is still uninitialised. The reasons live here, outside the cycle;
// their old modules re-export them.

/** The prefix a producer gives a reason meant for the availability consumer only. */
export const AVAILABILITY_REASON_PREFIX = 'AVAILABILITY:'

/** `job_dirty_work.reason` prefix of a run's absence work; the run id follows (<= 100 chars). */
export const RUN_ABSENT_REASON_PREFIX = `${AVAILABILITY_REASON_PREFIX}RUN_ABSENT:`

/** A CLOSED/EXPIRED record listed again; `:<runId>` follows. */
export const RECORD_RELISTED_REASON = 'RECORD_RELISTED'

/** An opportunity whose record the WINDOW expiry marked EXPIRED. */
export const WINDOW_EXPIRE_REASON = 'RECORD_WINDOW_EXPIRED'
