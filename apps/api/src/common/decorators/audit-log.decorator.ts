import { SetMetadata } from '@nestjs/common'
import type { AuditAction } from '@crm/shared'

export const AUDIT_LOG_KEY = 'audit_log_action'
export const AuditLog = (action: AuditAction) => SetMetadata(AUDIT_LOG_KEY, action)
