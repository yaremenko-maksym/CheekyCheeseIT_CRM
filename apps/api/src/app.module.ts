import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { AuthModule } from './auth/auth.module'
import { validateEnv } from './config/env'
import { DatabaseModule } from './database/database.module'
import { DocumentsModule } from './documents/documents.module'
import { HealthModule } from './health/health.module'
import { FinanceModule } from './finance/finance.module'
import { InterviewsModule } from './interviews/interviews.module'
import { InvoicesModule } from './invoices/invoices.module'
import { NotificationsModule } from './notifications/notifications.module'
import { ProjectsModule } from './projects/projects.module'
import { TeamsModule } from './teams/teams.module'
import { UsersModule } from './users/users.module'

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
    UsersModule,
    AuthModule,
    TeamsModule,
    ProjectsModule,
    InterviewsModule,
    DocumentsModule,
    NotificationsModule,
    InvoicesModule,
    FinanceModule,
    HealthModule,
  ],
})
export class AppModule {}
