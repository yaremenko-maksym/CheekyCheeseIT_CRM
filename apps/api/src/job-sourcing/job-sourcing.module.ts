import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AuthModule } from '../auth/auth.module'
import type { Env } from '../config/env'
import { DatabaseModule } from '../database/database.module'
import { DatabaseService } from '../database/database.service'
import {
  JobSourceAdminController,
  JobSourceSwitchController,
} from './admin/job-source-admin.controller'
import { JobSourceAdminService } from './admin/job-source-admin.service'
import { DouRssProvider } from './dou.provider'
import { JobAvailabilityReconciliationCronService } from './job-availability-reconciliation.cron'
import { JobMatchReconciliationCronService } from './job-match-reconciliation.cron'
import { JobQueueActionRetentionCronService } from './job-queue-action-retention.cron'
import { JobQueueGenerationRetentionCronService } from './job-queue-generation-retention.cron'
import { JobSourcingController } from './job-sourcing.controller'
import { JobQueueController } from './queue/job-queue.controller'
import { JobQueueActionsService } from './queue/queue-actions.service'
import { JobQueueRecomputeService } from './queue/queue-recompute.service'
import {
  createManualParsePorts,
  MANUAL_PARSE_PORTS,
  ManualParseService,
} from './queue/manual-parse.service'
import { JobQueueService } from './queue/job-queue.service'
import { JobQueueScopeService } from './queue/queue-scope.service'
import { JobRoleAiCronService } from './role-ai/role-ai.cron'
import { JevRoleClassifierClient } from './role-ai/jev-role-classifier'
import { RoleClassifierClient } from './role-ai/role-classifier.client'
import { NotificationsModule } from '../notifications/notifications.module'
import { JobSourceHealthService } from './health/job-source-health.service'
import { SourceHealthAlertService } from './health/source-health-alert.service'
import { SourceHealthWeeklyReportCron } from './health/source-health-weekly-report.cron'
import { JobSourcingCronService } from './job-sourcing.cron'
import { JobSourcingService } from './job-sourcing.service'
import { JobSourceRegistry } from './registry/job-source-registry'
import { createProductionRegistry } from './registry/production-registry'
import { JobRunWorker } from './runtime/job-run-worker'
import {
  AVAILABILITY_RECONCILE_WORKER,
  createAvailabilityReconcileSteps,
} from './runtime/availability-reconcile-worker'
import { productionLedgerCatalog } from './runtime/production-catalog'
import { RecomputeWorker, createRecomputeSteps } from './runtime/recompute-worker'
import {
  createProductionLedger,
  createProductionWorker,
  lateBoundDb,
} from './runtime/production-worker'
import { JobRunLedger } from './ownership/job-run-ledger'

/**
 * Job sourcing (task-job-sourcing-slice1).
 *
 * `HrAccessService` is NOT imported here: it is provided by the @Global
 * CommonModule (same as legends / projects / credentials consume it), so this
 * module injects the one shared instance instead of a second copy of the
 * "does this HR share a team with this user" rule.
 *
 * There is ONE adapter registry (`JobSourceRegistry`), built by `createProductionRegistry`; it
 * rejects a duplicate type while this module initialises. It holds DOU (legacy) and every wired
 * REPORTING adapter; adding a source = its provider in that factory plus its `REPORTING_WIRING`. `JobSourcingService` keeps no map of its own.
 *
 * `JobQueueActionRetentionCronService` is a SECOND cron, deliberately separate from
 * `JobSourcingCronService`: it discharges the statutory two-year retention of
 * `job_queue_actions`, and every other retention duty in this process is likewise its
 * own service with its own slot. (It is NOT separate because a failing feed could
 * skip it — `collectAll` catches per source and carries on; see its class doc, which
 * records that correction.) It needs no `ScheduleModule.forRoot()` here for the same
 * reason `JobSourcingCronService` does not — the scheduler is rooted once elsewhere
 * and discovers every `@Cron` in the application.
 */
@Module({
  imports: [DatabaseModule, AuthModule, NotificationsModule],
  controllers: [
    JobSourcingController,
    JobSourceAdminController,
    JobSourceSwitchController,
    JobQueueController,
  ],
  providers: [
    JobSourcingService,
    JobSourceAdminService,
    JobSourcingCronService,
    // U4: the health detector pass, injected (optional) into the tick handler.
    JobSourceHealthService,
    // U5a: the ADMIN alert on entering a bad state (called by the pass) and the Monday report.
    SourceHealthAlertService,
    SourceHealthWeeklyReportCron,
    JobQueueActionRetentionCronService,
    // r5 Task 6.2 (MP-13): removes expired queue generations; flag default OFF.
    JobQueueGenerationRetentionCronService,
    // r5 Task 6.1: the queue scope (ADMIN studio / HR one active team); read by Tasks 6.2-6.4.
    JobQueueScopeService,
    // r5 Task 6.3: the queue's writes (submit, cancel, dismiss, undo, opened, suppress); Task 6.4 calls them.
    JobQueueActionsService,
    // r5 Task 6.4: POST /job-queue/recompute enqueues a match recompute run (never inline).
    JobQueueRecomputeService,
    // External vacancy intake PR 2: POST /job-queue/manual/parse (Jev isVacancy + hosted extraction).
    ManualParseService,
    {
      provide: MANUAL_PARSE_PORTS,
      useFactory: (config?: ConfigService<Env, true>) => createManualParsePorts(config),
      inject: [{ token: ConfigService, optional: true }],
    },
    // r5 Task 6.2: the queue's list and card reads; the Task 6.4 controller calls them.
    JobQueueService,
    // r5 Task 4.6 S4b: periodic reconciliation + drain of the recompute worker; flag default OFF.
    JobMatchReconciliationCronService,
    // r5 Task 4.6 S8d: periodic availability reconciliation drain; flag default OFF, ships dark.
    JobAvailabilityReconciliationCronService,
    // Senior roles PR 3: the bounded AI role pass over the worker's /classify-roles; flag default OFF.
    RoleClassifierClient,
    JevRoleClassifierClient,
    JobRoleAiCronService,
    DouRssProvider,
    {
      provide: JobSourceRegistry,
      // The keyed adapters read their credentials through ConfigService (absent = unconfigured).
      useFactory: createProductionRegistry,
      inject: [DouRssProvider, { token: ConfigService, optional: true }],
    },
    // r5 Task 2.5 T7: THE run ledger (production catalog) and the run worker over it. The T9 admin
    // service resets failures through this same ledger. The cron handlers drive the worker; see
    // `createProductionWorker`.
    {
      provide: JobRunLedger,
      // The ledger lifts KEY_REQUIRED for a keyed type whose key ConfigService holds.
      useFactory: (
        db: DatabaseService,
        registry: JobSourceRegistry,
        config: ConfigService<Env, true> | undefined,
      ) => createProductionLedger(lateBoundDb(db), registry, config),
      inject: [DatabaseService, JobSourceRegistry, { token: ConfigService, optional: true }],
    },
    {
      provide: JobRunWorker,
      useFactory: (
        ledger: JobRunLedger,
        db: DatabaseService,
        registry: JobSourceRegistry,
        config: ConfigService<Env, true> | undefined,
        reconciliation: JobMatchReconciliationCronService,
      ) =>
        // Every run ends with the match drain: its records reach the HR queue within the window.
        createProductionWorker(ledger, lateBoundDb(db), registry, config, {}, () =>
          reconciliation.requestDrain(),
        ),
      inject: [
        JobRunLedger,
        DatabaseService,
        JobSourceRegistry,
        { token: ConfigService, optional: true },
        JobMatchReconciliationCronService,
      ],
    },
    // r5 Task 4.6 S4a: the dirty-work recompute consumer; S4b's reconciliation cron calls `runOnce`.
    {
      provide: RecomputeWorker,
      useFactory: (db: DatabaseService, config: ConfigService<Env, true> | null) =>
        // U10: pass the ON_DEMAND source types so a wanted opportunity enqueues one DETAIL_FETCH per
        // backing ON_DEMAND record (empty until a source's manifest is flipped — ADR 6a, step 10).
        // Senior roles 4.4: the same flag the AI pass reads also gates the detail fetch of a
        // role-PENDING vacancy, so no external GET is made while the pass is dark.
        new RecomputeWorker(
          createRecomputeSteps(
            lateBoundDb(db),
            {},
            productionLedgerCatalog().onDemandTypes(),
            config?.get('JOB_ROLE_AI_ENABLED', { infer: true }) === true,
          ),
          { owner: `recompute-${process.pid}` },
        ),
      inject: [DatabaseService, { token: ConfigService, optional: true }],
    },
    // r5 Task 4.6 S8d: the availability consumer instance the reconciliation cron drains. A distinct
    // token from RecomputeWorker — same claim loop, the availability port.
    {
      provide: AVAILABILITY_RECONCILE_WORKER,
      useFactory: (db: DatabaseService) =>
        new RecomputeWorker(createAvailabilityReconcileSteps(lateBoundDb(db)), {
          owner: `availability-reconcile-${process.pid}`,
        }),
      inject: [DatabaseService],
    },
  ],
  exports: [JobSourcingService, JobQueueScopeService],
})
export class JobSourcingModule {}
