// Dependency-free on purpose: `dirty-work.store` imports the availability producers, which read
// this prefix at module load, so it must live outside that import cycle (CommonJS load order).

/** The prefix a producer gives a reason meant for the availability consumer only. */
export const AVAILABILITY_REASON_PREFIX = 'AVAILABILITY:'
