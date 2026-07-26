/**
 * ContactController — PUBLIC surface for the landing "Start a project" form.
 *
 *   POST /api/public/contact
 *
 * `@Public()` — the globally registered `JwtAuthGuard` (AppModule
 * `APP_GUARD`) would otherwise 401 this unauthenticated request, same
 * pattern as `PublicVacanciesController`.
 *
 * Plain JSON body (unlike `PublicVacanciesController.apply`, which is
 * multipart for the résumé file) — this form has no file upload, so the
 * global Fastify JSON body parser + `@Body()` is all it needs, matching
 * `TelemetryController`'s `@Body() body: unknown` + service-side `.parse()`
 * convention.
 *
 * Explicit `@Inject` — same DI pattern as every other real controller in
 * this codebase (lets the vitest/esbuild test env, which strips
 * `design:paramtypes`, still instantiate this controller directly).
 */
import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { Public } from '../auth/public.decorator'
import { RelaxableThrottle } from '../config/throttle-decorators'
import { ContactService } from './contact.service'

/**
 * Prod cap — task §Защита: "строгий rate-limit по IP (ориентир 3/час)".
 * Relaxable in non-prod via THROTTLE_RELAXED (CI/E2E), same guardrail as
 * every other `@RelaxableThrottle` call site.
 */
export const CONTACT_SUBMIT_LIMIT = 3
const CONTACT_SUBMIT_TTL_MS = 60 * 60 * 1000 // 1 hour

@Controller('public/contact')
export class ContactController {
  constructor(@Inject(ContactService) private readonly contactService: ContactService) {}

  @Post()
  @Public()
  @RelaxableThrottle(CONTACT_SUBMIT_LIMIT, CONTACT_SUBMIT_TTL_MS)
  @HttpCode(HttpStatus.CREATED)
  async submit(@Body() body: unknown, @Req() req: FastifyRequest): Promise<{ ok: true }> {
    return this.contactService.submit(body, req.ip)
  }
}
