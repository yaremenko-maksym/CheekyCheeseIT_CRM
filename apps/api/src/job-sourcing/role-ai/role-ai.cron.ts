import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { Env } from '../../config/env'
import { DatabaseService } from '../../database/database.service'
import { productionLedgerCatalog } from '../runtime/production-catalog'
import { lateBoundDb } from '../runtime/production-worker'
import { JevRoleClassifierClient } from './jev-role-classifier'
import { logRoleAiError, ROLE_AI_CRON, runRoleAiPass } from './role-ai-pass'
import { RoleClassifierClient } from './role-classifier.client'

/**
 * Senior roles PR 3: the bounded AI role pass, every 10 minutes. A dedicated cron, not a step of
 * the collection run: one pass sends at most ROLE_AI_PASS_LIMIT vacancies to Jev first, and to the
 * worker only when Jev is unavailable (jev-first.md).
 *
 * FLAG: `JOB_ROLE_AI_ENABLED`, default OFF (see `config/env.ts`): when off, the tick reads nothing
 * and calls nothing. A tick while a pass still runs is skipped (`running`). Never rethrows (an
 * unhandled rejection in a `@Cron` handler kills the scheduler), and logs no error message: a
 * driver message may quote a query parameter, which here is vacancy text.
 */
@Injectable()
export class JobRoleAiCronService {
  private readonly logger = new Logger(JobRoleAiCronService.name)
  private running = false

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RoleClassifierClient) private readonly client: RoleClassifierClient,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
    @Optional()
    @Inject(JevRoleClassifierClient)
    private readonly jev?: JevRoleClassifierClient,
  ) {}

  @Cron(ROLE_AI_CRON)
  async tick(): Promise<void> {
    if (this.config?.get('JOB_ROLE_AI_ENABLED', { infer: true }) !== true) return
    if (this.running) {
      this.logger.warn({ event: 'ROLE_AI_TICK_SKIPPED', reason: 'RUNNING' })
      return
    }
    this.running = true
    try {
      await runRoleAiPass({
        db: lateBoundDb(this.db),
        ...(this.jev === undefined ? {} : { jev: this.jev }),
        client: this.client,
        log: this.logger,
        now: () => new Date(),
        onDemandTypes: productionLedgerCatalog().onDemandTypes(),
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: `infer` only types the value; the key read is asserted in role-ai.cron.spec
        dailyBudget: this.config.get('JOB_ROLE_AI_DAILY_BUDGET', { infer: true }),
      })
    } catch (err: unknown) {
      logRoleAiError(this.logger, err)
    } finally {
      this.running = false
    }
  }
}
