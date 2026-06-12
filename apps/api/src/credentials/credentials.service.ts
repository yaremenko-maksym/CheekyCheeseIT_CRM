import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type {
  CreateCredentialDto,
  ProjectCredential,
  SessionUser,
  UpdateCredentialDto,
} from '@crm/shared'
import { projectCredentialSchema } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { CredentialsCryptoService } from './credentials-crypto.service'
import { DatabaseService } from '../database/database.service'
import { projectCredentials, projectMembers, projects } from '../database/schema'

type ProjectRow = { id: string; seniorId: string | null }

/**
 * Project credentials — work-account passwords, encrypted at-rest.
 *
 * SECURITY:
 *   - Passwords are stored ONLY as AES-256-GCM ciphertext (CredentialsCryptoService).
 *   - List/read NEVER select the ciphertext column nor return plaintext.
 *   - Plaintext is decrypted only by `reveal`, gated by the same RBAC check.
 *   - Nothing here logs the plaintext password.
 *
 * RBAC (relationship-based, mirrors legends.canAccess):
 *   ADMIN                                  → all projects
 *   JUNIOR active project_member of :id    → yes
 *   HR sharing active team with senior     → yes (HrAccessService)
 *   SENIOR / DROP / ACCOUNTANT             → 403 always
 *   anyone not matching                    → 403
 * view == create == edit == delete == reveal (single assertAccess gate).
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: CredentialsCryptoService,
    private readonly hrAccess: HrAccessService,
  ) {}

  // ── RBAC ────────────────────────────────────────────────────────────────

  /**
   * Loads the project and asserts the viewer may act on its credentials.
   * Throws NotFoundException (project missing) or ForbiddenException (no access).
   * Returns the project row for downstream use.
   */
  private async assertAccess(viewer: SessionUser, projectId: string): Promise<ProjectRow> {
    const rows = await this.db.db
      .select({ id: projects.id, seniorId: projects.seniorId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)

    const project = rows[0]
    if (!project) throw new NotFoundException('Проект не найден')

    const allowed = await this.canAccess(viewer, project)
    if (!allowed) throw new ForbiddenException('Нет доступа к паролям проекта')

    return project
  }

  /**
   * Pure RBAC predicate. ACCOUNTANT / SENIOR / DROP and unrelated users → false.
   * (SENIOR/DROP are NOT excluded "as subject" here the way legends does — the
   * task allowlist is junior+hr+admin only, so any SENIOR/DROP gets 403.)
   */
  private async canAccess(viewer: SessionUser, project: ProjectRow): Promise<boolean> {
    if (viewer.role === 'ADMIN') return true

    if (viewer.role === 'JUNIOR') return this.juniorIsActiveMember(viewer.id, project.id)

    if (viewer.role === 'HR') {
      if (!project.seniorId) return false
      return this.hrAccess.hrSharesActiveTeamWith(viewer.id, project.seniorId)
    }

    // SENIOR, DROP, ACCOUNTANT, and anything else.
    return false
  }

  private async juniorIsActiveMember(juniorId: string, projectId: string): Promise<boolean> {
    const membership = await this.db.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, juniorId),
          eq(projectMembers.projectId, projectId),
          isNull(projectMembers.leftAt),
        ),
      )
      .limit(1)

    return membership.length > 0
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * List credentials for a project. NEVER selects password_ciphertext —
   * the column is omitted from the projection entirely (defense in depth:
   * even an accidental serializer change cannot leak it).
   */
  async list(viewer: SessionUser, projectId: string): Promise<ProjectCredential[]> {
    await this.assertAccess(viewer, projectId)

    const rows = await this.db.db
      .select({
        id: projectCredentials.id,
        projectId: projectCredentials.projectId,
        label: projectCredentials.label,
        login: projectCredentials.login,
        url: projectCredentials.url,
        notes: projectCredentials.notes,
        createdAt: projectCredentials.createdAt,
        updatedAt: projectCredentials.updatedAt,
      })
      .from(projectCredentials)
      .where(eq(projectCredentials.projectId, projectId))
      .orderBy(asc(projectCredentials.createdAt))

    return rows.map((r) =>
      projectCredentialSchema.parse({
        id: r.id,
        projectId: r.projectId,
        label: r.label,
        login: r.login ?? null,
        url: r.url ?? null,
        notes: r.notes ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }),
    )
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  async create(
    viewer: SessionUser,
    projectId: string,
    dto: CreateCredentialDto,
  ): Promise<ProjectCredential> {
    await this.assertAccess(viewer, projectId)

    const now = new Date()
    const rows = await this.db.db
      .insert(projectCredentials)
      .values({
        projectId,
        label: dto.label,
        login: dto.login ?? null,
        // Encrypt — plaintext never persisted, never logged.
        passwordCiphertext: this.crypto.encrypt(dto.password),
        url: dto.url ?? null,
        notes: dto.notes ?? null,
        createdBy: viewer.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: projectCredentials.id,
        projectId: projectCredentials.projectId,
        label: projectCredentials.label,
        login: projectCredentials.login,
        url: projectCredentials.url,
        notes: projectCredentials.notes,
        createdAt: projectCredentials.createdAt,
        updatedAt: projectCredentials.updatedAt,
      })

    const row = rows[0]
    if (!row) throw new NotFoundException('Не удалось создать запись')

    return projectCredentialSchema.parse({
      id: row.id,
      projectId: row.projectId,
      label: row.label,
      login: row.login ?? null,
      url: row.url ?? null,
      notes: row.notes ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }

  async update(
    viewer: SessionUser,
    projectId: string,
    credentialId: string,
    dto: UpdateCredentialDto,
  ): Promise<ProjectCredential> {
    await this.assertAccess(viewer, projectId)
    await this.loadOwnedCredentialId(projectId, credentialId)

    // Build a partial update. password is re-encrypted ONLY when a non-empty
    // value is supplied; absent / empty → keep the stored ciphertext untouched.
    const patch: {
      label?: string
      login?: string | null
      url?: string | null
      notes?: string | null
      passwordCiphertext?: string
      updatedAt: Date
    } = { updatedAt: new Date() }

    if (dto.label !== undefined) patch.label = dto.label
    if (dto.login !== undefined) patch.login = dto.login ?? null
    if (dto.url !== undefined) patch.url = dto.url ?? null
    if (dto.notes !== undefined) patch.notes = dto.notes ?? null
    if (dto.password !== undefined && dto.password.length > 0) {
      patch.passwordCiphertext = this.crypto.encrypt(dto.password)
    }

    const rows = await this.db.db
      .update(projectCredentials)
      .set(patch)
      .where(
        and(eq(projectCredentials.id, credentialId), eq(projectCredentials.projectId, projectId)),
      )
      .returning({
        id: projectCredentials.id,
        projectId: projectCredentials.projectId,
        label: projectCredentials.label,
        login: projectCredentials.login,
        url: projectCredentials.url,
        notes: projectCredentials.notes,
        createdAt: projectCredentials.createdAt,
        updatedAt: projectCredentials.updatedAt,
      })

    const row = rows[0]
    if (!row) throw new NotFoundException('Запись не найдена')

    return projectCredentialSchema.parse({
      id: row.id,
      projectId: row.projectId,
      label: row.label,
      login: row.login ?? null,
      url: row.url ?? null,
      notes: row.notes ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }

  async remove(viewer: SessionUser, projectId: string, credentialId: string): Promise<void> {
    await this.assertAccess(viewer, projectId)
    await this.loadOwnedCredentialId(projectId, credentialId)

    await this.db.db
      .delete(projectCredentials)
      .where(
        and(eq(projectCredentials.id, credentialId), eq(projectCredentials.projectId, projectId)),
      )
  }

  /**
   * Reveal the plaintext password for one credential. Same RBAC gate as list.
   * The plaintext is returned to the caller and never logged / cached here.
   */
  async reveal(
    viewer: SessionUser,
    projectId: string,
    credentialId: string,
  ): Promise<{ password: string }> {
    await this.assertAccess(viewer, projectId)

    const rows = await this.db.db
      .select({ ciphertext: projectCredentials.passwordCiphertext })
      .from(projectCredentials)
      .where(
        and(eq(projectCredentials.id, credentialId), eq(projectCredentials.projectId, projectId)),
      )
      .limit(1)

    const row = rows[0]
    if (!row) throw new NotFoundException('Запись не найдена')

    return { password: this.crypto.decrypt(row.ciphertext) }
  }

  /**
   * Verifies a credential belongs to the project. Throws 404 otherwise.
   * Prevents cross-project id confusion on update/delete (the credentialId
   * must be scoped to the asserted project).
   */
  private async loadOwnedCredentialId(projectId: string, credentialId: string): Promise<void> {
    const rows = await this.db.db
      .select({ id: projectCredentials.id })
      .from(projectCredentials)
      .where(
        and(eq(projectCredentials.id, credentialId), eq(projectCredentials.projectId, projectId)),
      )
      .limit(1)

    if (!rows[0]) throw new NotFoundException('Запись не найдена')
  }
}
