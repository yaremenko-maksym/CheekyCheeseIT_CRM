import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { TelemetryEventDto } from '@crm/shared'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { telemetryEvents } from '../database/schema'
import { computeSessionHash } from './session-hash'

/**
 * TelemetryEventsService — task-telemetry-api §"Таблицы" (telemetry_events).
 *
 * Privacy contract: never stores the raw userId — only a daily-salted
 * `session_hash` (see `session-hash.ts`) + role, both DERIVED HERE from the
 * authenticated actor (`req.user`), never accepted from the client payload
 * (see `reportErrorSchema`/`telemetryEventSchema` — the wire DTO carries
 * neither field).
 */
@Injectable()
export class TelemetryEventsService {
  private readonly logger = new Logger(TelemetryEventsService.name)
  private readonly sessionSalt: string

  constructor(
    private readonly db: DatabaseService,
    config: ConfigService<Env, true>,
  ) {
    this.sessionSalt = config.get('TELEMETRY_SESSION_SALT', { infer: true })
  }

  /** Insert-many. No-op on an empty batch (defensive — the Zod schema already enforces min(1)). */
  async recordBatch(
    events: TelemetryEventDto[],
    actor: { id: string; role: string },
  ): Promise<void> {
    if (events.length === 0) return

    const sessionHash = computeSessionHash(actor.id, this.sessionSalt)
    const rows = events.map((event) => ({
      sessionHash,
      userRole: actor.role,
      event: event.event,
      route: event.route,
      target: event.target ?? null,
      durationMs: event.durationMs ?? null,
    }))

    await this.db.db.insert(telemetryEvents).values(rows)
    this.logger.debug(`telemetry events recorded (count=${rows.length})`)
  }
}
