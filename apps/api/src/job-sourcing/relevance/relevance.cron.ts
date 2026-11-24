import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { Env } from '../../config/env'
import { DatabaseService } from '../../database/database.service'
import { lateBoundDb } from '../runtime/production-worker'
import { JevRelevanceGraderClient } from './jev-relevance-grader'
import { logRelevanceError, RELEVANCE_CRON, runRelevancePass } from './relevance-pass'

/**
 * Queue relevance PR1: the bounded Jev vacancy-senior relevance pass, every 10 minutes (5 minutes
 * after the role-AI pass). One pass grades at most RELEVANCE_PASS_LIMIT opportunities. Jev only:
 * with no JEV_API_KEY the pass stops at its first call (NOT_CONFIGURED) and writes nothing.
 *
 * FLAG: `JOB_RELEVANCE_AI_ENABLED`, default OFF (see `config/env.ts`): when off, the tick reads
 * nothing and calls nothing. A tick while a pass still runs is skipped (`running`). Never rethrows
 * (an unhandled rejection in a `@Cron` handler kills the scheduler), and logs no error message: a
 * driver message may quote a query parameter, which here is vacancy text.
 */
@Injectable()
export class JobRelevanceCronService {
  private readonly logger = new Logger(JobRelevanceCronService.name)
  private running = false

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(JevRelevanceGraderClient) private readonly jev: JevRelevanceGraderClient,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {}

  @Cron(RELEVANCE_CRON)
  async tick(): Promise<void> {
    if (this.config?.get('JOB_RELEVANCE_AI_ENABLED', { infer: true }) !== true) return
    if (this.running) {
      this.logger.warn({ event: 'RELEVANCE_TICK_SKIPPED', reason: 'RUNNING' })
      return
    }
    this.running = true
    try {
      await runRelevancePass({
        db: lateBoundDb(this.db),
        jev: this.jev,
        log: this.logger,
        now: () => new Date(),
      })
    } catch (err: unknown) {
      logRelevanceError(this.logger, err)
    } finally {
      this.running = false
    }
  }
}
