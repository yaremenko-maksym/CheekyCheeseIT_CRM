/**
 * ContactModule — task-landing-contact-and-hiring-strip.
 *
 * Reuses (does not duplicate):
 *   - `TurnstileService` from `VacanciesModule` (now exported there — see
 *     that module's doc comment) for the anti-spam Cloudflare Turnstile check.
 *   - `TelemetryErrorsService` from `TelemetryModule` to log a final send
 *     failure (so it surfaces in the telemetry digest).
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
})
export class ContactModule {}
