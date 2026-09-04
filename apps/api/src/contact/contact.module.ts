/**
 * ContactModule — task-landing-contact-and-hiring-strip.
 *
 * Reuses (does not duplicate):
 *   - `TurnstileService` from `VacanciesModule` (now exported there — see
 *     that module's doc comment) for the anti-spam Cloudflare Turnstile check.
 *   - `TelemetryErrorsService` from `TelemetryModule` to log a final send
 *     failure (so it surfaces in the telemetry digest).
 *
 * `ResendMailerService` is exported (task-user-emails-invite) — `UsersModule`
 * imports this module to reuse the SAME Resend HTTP wrapper for the
 * personal-email invite send, rather than standing up a second one.
 */
import { Module } from '@nestjs/common'
import { TelemetryModule } from '../telemetry/telemetry.module'
import { VacanciesModule } from '../vacancies/vacancies.module'
import { ContactController } from './contact.controller'
import { ContactService } from './contact.service'
import { ResendMailerService } from './resend-mailer.service'

@Module({
  imports: [VacanciesModule, TelemetryModule],
  controllers: [ContactController],
  providers: [ContactService, ResendMailerService],
  exports: [ResendMailerService],
})
export class ContactModule {}
