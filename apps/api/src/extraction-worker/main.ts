import { startWorker } from './start'

/** The extraction worker's process entry (ADR §2.4); the wiring and its tests are in `start.ts`. */
void startWorker(process.env, process)
