import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { seniorAvailabilitySchema, type SeniorAvailabilityDto } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { seniorAvailability, type SeniorAvailabilityRow } from '../database/schema'
import { loadUserById } from './user-read.util'

/** The stored row as the wire shape; the CHECK pairs FREE with its day. */
export function toAvailabilityDto(
  row: Pick<SeniorAvailabilityRow, 'status' | 'availableFrom'> | undefined,
): SeniorAvailabilityDto | null {
  if (row === undefined) return null
  if (row.status === 'BUSY') return { status: 'BUSY' }
  return row.availableFrom === null ? null : { status: 'FREE', availableFrom: row.availableFrom }
}

/**
 * A senior's own availability (vacancy-queue design §5.2), set where the HR queue card reads it.
 *
 * RBAC, viewer → target (read and write alike):
 *   - SENIOR → self: allowed;
 *   - ADMIN → any active SENIOR: allowed (another role or an archived user: 404);
 *   - every other pair (SENIOR → another senior, HR, JUNIOR, ACCOUNTANT, DROP → anyone): 403.
 * The 403 is decided from the viewer alone, before the target is read, so it says nothing about
 * whether the target exists. HR sees a senior's availability only on the queue card, inside its
 * own scope (`seniorRows`), never here. The viewer's role is read fresh, not taken from the token.
 */
@Injectable()
export class SeniorAvailabilityService {
  constructor(private readonly db: DatabaseService) {}

  async get(viewerId: string, targetId: string): Promise<SeniorAvailabilityDto | null> {
    await this.authorize(viewerId, targetId)
    const rows = await this.db.db
      .select({
        status: seniorAvailability.status,
        availableFrom: seniorAvailability.availableFrom,
      })
      .from(seniorAvailability)
      .where(eq(seniorAvailability.userId, targetId))
    return toAvailabilityDto(rows[0])
  }

  async set(viewerId: string, targetId: string, body: unknown): Promise<SeniorAvailabilityDto> {
    const dto = seniorAvailabilitySchema.parse(body)
    await this.authorize(viewerId, targetId)
    const availableFrom = dto.status === 'FREE' ? dto.availableFrom : null
    await this.db.db
      .insert(seniorAvailability)
      .values({ userId: targetId, status: dto.status, availableFrom })
      .onConflictDoUpdate({
        target: seniorAvailability.userId,
        set: { status: dto.status, availableFrom, updatedAt: sql`now()` },
      })
    return dto
  }

  private async authorize(viewerId: string, targetId: string): Promise<void> {
    const viewer = await loadUserById(this.db.db, viewerId)
    if (viewer === undefined || viewer.archivedAt !== null) throw new ForbiddenException()
    if (viewer.role === 'SENIOR' && viewer.id === targetId) return
    if (viewer.role !== 'ADMIN') throw new ForbiddenException()
    const target = await loadUserById(this.db.db, targetId)
    if (target === undefined || target.role !== 'SENIOR' || target.archivedAt !== null) {
      throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
  }
}
