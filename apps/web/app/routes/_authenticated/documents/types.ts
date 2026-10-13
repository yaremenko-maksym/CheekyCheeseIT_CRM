import type { DocumentCategory, SessionUser } from '@crm/shared'

export type Role = SessionUser['role']
export type StatusTab = 'ALL' | 'ACTIVE' | 'ARCHIVED'
export type CategoryFilter = DocumentCategory | 'ALL'
export type DocumentView = 'list' | 'grid'
