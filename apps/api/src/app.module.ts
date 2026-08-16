import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import { AdminModule } from './admin/admin.module'
import { AuthModule } from './auth/auth.module'
import { JwtAuthGuard } from './auth/jwt.guard'
import { OnboardingGuard } from './auth/onboarding.guard'
import { CommonModule } from './common/common.module'
import { UserAwareThrottlerGuard } from './common/guards/user-aware-throttler.guard'
import { ContactModule } from './contact/contact.module'
import { validateEnv } from './config/env'
import type { Env } from './config/env'
import { ContractsModule } from './contracts/contracts.module'
import { CredentialsModule } from './credentials/credentials.module'
import { CspReportsModule } from './csp-reports/csp-reports.module'
import { DatabaseModule } from './database/database.module'
import { DocumentsModule } from './documents/documents.module'
import { HealthModule } from './health/health.module'
import { FinanceModule } from './finance/finance.module'
import { InterviewsModule } from './interviews/interviews.module'
import { JobSourcingModule } from './job-sourcing/job-sourcing.module'
import { InvoicesModule } from './invoices/invoices.module'
import { NotificationsModule } from './notifications/notifications.module'
import { OnboardingModule } from './onboarding/onboarding.module'
import { ProjectsModule } from './projects/projects.module'
import { TeamsModule } from './teams/teams.module'
import { TosModule } from './tos/tos.module'
import { UsersModule } from './users/users.module'
import { LegendsModule } from './legends/legends.module'
import { TelemetryModule } from './telemetry/telemetry.module'
import { VacanciesModule } from './vacancies/vacancies.module'
import { SeniorResumesModule } from './resumes/resumes.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // Global rate-limiter — values are env-configurable so CI/test can raise
    // the ceiling without touching production defaults.
    //
    // THROTTLER_TTL_MS  — sliding window in ms.   Default: 60 000 (prod).
    // THROTTLER_LIMIT   — max requests per window. Default: 100    (prod).
    //
    // If neither var is set the behaviour is byte-for-byte identical to the
    // previous forRoot([{ ttl: 60_000, limit: 100 }]) call, so prod is safe.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>) => [
        {
          name: 'default',
          ttl: config.get('THROTTLER_TTL_MS', { infer: true })!,
          limit: config.get('THROTTLER_LIMIT', { infer: true })!,
        },
      ],
    }),
    DatabaseModule,
    // Global cross-cutting providers (HrAccessService). Imported early so it is
    // available to feature modules below (it is @Global, order is belt-and-braces).
    CommonModule,
    UsersModule,
    AuthModule,
    TeamsModule,
    ProjectsModule,
    InterviewsModule,
    JobSourcingModule,
    DocumentsModule,
    NotificationsModule,
    InvoicesModule,
    FinanceModule,
    // Onboarding (Phase 6A) — MSA contracts + ToS + redirect gate.
    // ContractsModule + TosModule must be imported before OnboardingModule
    // because OnboardingService injects services from both.
    ContractsModule,
    TosModule,
    OnboardingModule,
    HealthModule,
    LegendsModule,
    CredentialsModule,
    // ADMIN dashboard «центр действий» — KPI + active-transactions aggregate.
    AdminModule,
    // task-vacancies-api: public vacancies (landing) + admin CRUD (CRM).
    VacanciesModule,
    // task-resume-base: canonical structured resume of a SENIOR — upload +
    // one-shot AI extraction + editable structure + PDF export.
    SeniorResumesModule,
    // task-telemetry-api: prod-error tracking + UX-event analytics + digest.
    TelemetryModule,
    // task-landing-contact-and-hiring-strip: public "Start a project" contact
    // form — POST /api/public/contact, emails every ADMIN via Resend.
    ContactModule,
    // task-csp-reports-and-flip: public CSP violation report endpoint —
    // POST /api/public/csp-report, aggregated storage, digest visibility.
    CspReportsModule,
  ],
  providers: [
    // ORDER MATTERS — NestJS executes APP_GUARD providers in registration order
    // (per `content/faq/request-lifecycle.md`: «Guards are run in the order in
    // which they are bound»).
    //
    // JwtAuthGuard FIRST so it populates `req.user` from the JWT cookie. Then
    // OnboardingGuard reads `req.user` to decide on the 403 ONBOARDING_REQUIRED
    // payload. Reviewer #4415687659 caught the previous wiring (OnboardingGuard
    // alone, JwtAuthGuard controller-level) — global guards ran first while
    // `req.user` was still undefined, so the guard's `if (!user) return true`
    // pre-check fired on every request → the gate was a silent no-op.
    //
    // Use `@Public()` (`apps/api/src/auth/public.decorator.ts`) on routes that
    // must remain reachable without a JWT cookie — JwtAuthGuard reads
    // `IS_PUBLIC_KEY` via Reflector and short-circuits the verification.
    //
    // Integration test pinning this wiring: `auth/onboarding.guard.integration.spec.ts`.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: OnboardingGuard },
    // UserAwareThrottlerGuard runs after the auth guards so req.user is
    // available: it tracks by the AUTHENTICATED USER when one is known,
    // falling back to the request's IP address for anonymous traffic
    // (backlog #52 — see that guard's file header for why the stock
    // IP-only tracker under- and over-counts). Global default = 100 req/60 s;
    // sensitive write endpoints override with @Throttle() at controller level.
    { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
  ],
})
export class AppModule {}
