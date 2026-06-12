import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { createCredentialSchema, updateCredentialSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { CredentialsService } from './credentials.service'

// JwtAuthGuard runs globally (AppModule APP_GUARD) — authentication is covered.
// RBAC for credentials is relationship-based (project membership / HR team),
// handled entirely inside CredentialsService.assertAccess. Adding a RolesGuard
// without a matching @Roles() decorator would be a no-op that misleads readers.
//
// SECURITY: only GET :id/reveal returns plaintext — it is throttled and
// Cache-Control: no-store. List/create/update never expose plaintext.

@Controller('projects')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  /**
   * GET /api/projects/:projectId/credentials
   * List credentials (NO password / ciphertext).
   */
  @Get(':projectId/credentials')
  list(@CurrentUser() user: SessionUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.credentials.list(user, projectId)
  }

  /**
   * POST /api/projects/:projectId/credentials
   * Create a credential. Password is encrypted server-side.
   */
  @Post(':projectId/credentials')
  create(
    @CurrentUser() user: SessionUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
  ) {
    const dto = createCredentialSchema.parse(body)
    return this.credentials.create(user, projectId, dto)
  }

  /**
   * PATCH /api/projects/:projectId/credentials/:id
   * Update a credential. Absent / empty password keeps the stored one.
   */
  @Patch(':projectId/credentials/:id')
  update(
    @CurrentUser() user: SessionUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = updateCredentialSchema.parse(body)
    return this.credentials.update(user, projectId, id, dto)
  }

  /**
   * DELETE /api/projects/:projectId/credentials/:id
   */
  @Delete(':projectId/credentials/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.credentials.remove(user, projectId, id)
  }

  /**
   * GET /api/projects/:projectId/credentials/:id/reveal
   * The ONLY plaintext path. Throttled (30/min) + Cache-Control: no-store.
   */
  @Get(':projectId/credentials/:id/reveal')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reveal(
    @CurrentUser() user: SessionUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credentials.reveal(user, projectId, id)
  }
}
