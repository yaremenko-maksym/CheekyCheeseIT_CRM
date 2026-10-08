import { randomBytes, createHash } from 'node:crypto'
import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'

import { DatabaseService } from '../../../database/database.service'
import { meetingRecorderAuditLog, meetingRecorderConnections } from '../../../database/schema'

function tokenHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

@Injectable()
export class RecordingMediaAuthService {
  constructor(private readonly db: DatabaseService) {}

  /** Test-event discovery is advertised only after an admin has provisioned media access. */
  async isProvisioned(connectionId: string): Promise<boolean> {
    const [connection] = await this.db.db
      .select({
        enabled: meetingRecorderConnections.enabled,
        mediaTokenHash: meetingRecorderConnections.mediaTokenHash,
      })
      .from(meetingRecorderConnections)
      .where(eq(meetingRecorderConnections.id, connectionId))
      .limit(1)
    return Boolean(connection?.enabled && connection.mediaTokenHash)
  }

  /** One-time response. The raw token is never stored, logged or returned by listConnections. */
  async replaceToken(connectionId: string, actorUserId: string): Promise<{ token: string }> {
    return this.db.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: meetingRecorderConnections.id })
        .from(meetingRecorderConnections)
        .where(eq(meetingRecorderConnections.id, connectionId))
        .for('update')
        .limit(1)
      if (!existing)
        throw new HttpException({ code: 'MEDIA_CONNECTION_NOT_FOUND' }, HttpStatus.NOT_FOUND)

      const token = `mrmt_${randomBytes(32).toString('base64url')}`
      await tx
        .update(meetingRecorderConnections)
        .set({
          mediaTokenHash: tokenHash(token),
          mediaTokenUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(meetingRecorderConnections.id, connectionId))
      await tx.insert(meetingRecorderAuditLog).values({
        action: 'token-issued',
        connectionId,
        actorUserId,
      })
      return { token }
    })
  }

  async authenticate(header: string | undefined): Promise<string> {
    if (!header || !/^Bearer mrmt_[A-Za-z0-9_-]{43}$/.test(header)) {
      throw new HttpException({ code: 'MEDIA_UNAUTHORIZED' }, HttpStatus.UNAUTHORIZED)
    }
    const [row] = await this.db.db
      .select({
        id: meetingRecorderConnections.id,
        enabled: meetingRecorderConnections.enabled,
      })
      .from(meetingRecorderConnections)
      .where(eq(meetingRecorderConnections.mediaTokenHash, tokenHash(header.slice(7))))
      .limit(1)
    if (!row) throw new HttpException({ code: 'MEDIA_UNAUTHORIZED' }, HttpStatus.UNAUTHORIZED)
    if (!row.enabled)
      throw new HttpException({ code: 'MEDIA_CONNECTION_DISABLED' }, HttpStatus.GONE)
    return row.id
  }
}
