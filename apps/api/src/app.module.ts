import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { AuthModule } from './auth/auth.module'
import { JwtAuthGuard } from './auth/jwt.guard'
import { OnboardingGuard } from './auth/onboarding.guard'
import { CommonModule } from './common/common.module'
import { validateEnv } from './config/env'
import { ContractsModule } from './contracts/contracts.module'
import { CredentialsModule } from './credentials/credentials.module'
import { DatabaseModule } from './database/database.module'
import { DocumentsModule } from './documents/documents.module'
import { HealthModule } from './health/health.module'
import { FinanceModule } from './finance/finance.module'
import { InterviewsModule } from './interviews/interviews.module'
import { InvoicesModule } from './invoices/invoices.module'
import { NotificationsModule } from './notifications/notifications.module'
import { OnboardingModule } from './onboarding/onboarding.module'
import { ProjectsModule } from './projects/projects.module'
import { TeamsModule } from './teams/teams.module'
import { TosModule } from './tos/tos.module'
import { UsersModule } from './users/users.module'
import { LegendsModule } from './legends/legends.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 100,
      },
    ]),
    DatabaseModule,
    // Global cross-cutting providers (HrAccessService). Imported early so it is
    // available to feature modules below (it is @Global, order is belt-and-braces).
    CommonModule,
    UsersModule,
    AuthModule,
    TeamsModule,
    ProjectsModule,
    InterviewsModule,
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
    // ThrottlerGuard runs after auth guards so req.user is available for
    // per-user tracking (default tracker = IP). Global default = 100 req/60 s;
    // sensitive write endpoints override with @Throttle() at controller level.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
