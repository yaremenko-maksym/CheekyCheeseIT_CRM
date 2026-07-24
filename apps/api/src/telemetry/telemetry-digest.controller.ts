import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import type { TelemetryDigestResponse } from '@crm/shared'
import { Public } from '../auth/public.decorator'
import { TelemetryDigestTokenGuard } from './telemetry-digest-token.guard'
import { TelemetryDigestService } from './telemetry-digest.service'

/**
 * `since` — ISO-8601 datetime, required (contract: `?since=<iso>`).
 * `ux`    — `0` (default) | `1`, opts into the 7-day UX-aggregates block.
 * Server-only shape — never sent to a browser client, so this stays local
 * rather than exported from `@crm/shared` (unlike `reportErrorSchema` /
 * `telemetryEventSchema`, which the web SDK also needs).
 */
const digestQuerySchema = z.object({
  since: z.string().datetime(),
  ux: z.enum(['0', '1']).optional().default('0'),
})

/**
 * TelemetryDigestController — `GET /api/telemetry/digest`, consumed by
 * `.github/workflows/telemetry-digest.yml` (a scheduled GitHub Action — no
 * browser session, cannot carry a JWT cookie).
 *
 * `@Public()` opts out of the globally registered `JwtAuthGuard`;
 * `@UseGuards(TelemetryDigestTokenGuard)` gates it instead (constant-time
 * `X-Telemetry-Token` header compare — see that guard's own doc comment).
 *
 * A SEPARATE class from `TelemetryController` (the authenticated
 * errors/events ingest routes) — same rationale as
 * VacanciesController/PublicVacanciesController: mixing public + guarded
 * routes on one class risks a copy-paste guard ending up on the wrong
 * handler.
 */
@Controller('telemetry')
export class TelemetryDigestController {
  constructor(
    @Inject(TelemetryDigestService) private readonly digestService: TelemetryDigestService,
  ) {}

  @Get('digest')
  @Public()
  @UseGuards(TelemetryDigestTokenGuard)
  async getDigest(@Query() query: unknown): Promise<TelemetryDigestResponse> {
    const parsed = digestQuerySchema.safeParse(query)
    if (!parsed.success) {
      throw new BadRequestException('Invalid query: `since` must be an ISO-8601 datetime')
    }
    const { since, ux } = parsed.data

    return this.digestService.getDigest({
      since: new Date(since),
      includeUx: ux === '1',
    })
  }
}
