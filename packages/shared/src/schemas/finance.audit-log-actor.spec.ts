import { describe, expect, it } from 'vitest'
import { transactionAuditLogEntrySchema } from './finance'

// i18n server-text PR4 (S4): `transaction_audit_log.actor_id` is ON DELETE SET
// NULL, so a removed actor has no name. The API sends `actorName: null` (it used
// to send the Russian «— (пользователь удалён)»); the client localizes it.

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const entry = {
  id: uuid,
  action: 'DELETE',
  actorId: null,
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('transactionAuditLogEntrySchema.actorName', () => {
  it('accepts null (actor row gone) and a real name', () => {
    expect(transactionAuditLogEntrySchema.parse({ ...entry, actorName: null }).actorName).toBeNull()
    expect(transactionAuditLogEntrySchema.parse({ ...entry, actorName: 'Admin' }).actorName).toBe(
      'Admin',
    )
  })

  it('still requires the field to be present', () => {
    expect(transactionAuditLogEntrySchema.safeParse(entry).success).toBe(false)
  })
})
