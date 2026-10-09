import { createHash } from 'node:crypto'
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

import { RecordingMediaAuthService } from './recording-media-auth.service'

type MediaRequest = {
  headers: { authorization?: string | string[] }
  mediaConnectionId?: string
  ip?: string
}

/** Runs after the global IP throttle; unknown and revoked tokens remain IP throttled. */
@Injectable()
export class RecordingMediaAuthenticationGuard implements CanActivate {
  constructor(
    @Inject(RecordingMediaAuthService) private readonly auth: RecordingMediaAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MediaRequest>()
    const header = request.headers.authorization
    request.mediaConnectionId = await this.auth.authenticate(
      typeof header === 'string' ? header : undefined,
    )
    return true
  }
}

/** Adds a connection-scoped quota to the global anonymous IP quota. */
@Injectable()
export class RecordingMediaConnectionThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: MediaRequest): Promise<string> {
    // AuthenticationGuard must precede this guard on every media route.
    if (!req.mediaConnectionId) throw new Error('Media connection was not authenticated')
    return `recording-media-connection:${req.mediaConnectionId}`
  }

  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    // Nest's default key includes the handler name, allowing each media endpoint
    // to consume a separate quota. Use one connection-wide bucket per limiter.
    return createHash('sha256').update(`recording-media:${name}:${tracker}`).digest('hex')
  }
}
