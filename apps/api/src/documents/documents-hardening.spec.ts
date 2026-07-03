/**
 * Documents hardening — audit fix tests.
 *
 * Covers three audit findings:
 *
 * 1. RBAC guards on restore / hardDelete endpoints
 *    Non-ADMIN callers must receive 403 from the controller layer (RolesGuard),
 *    not just from the service ForbiddenException. Both guards are tested via an
 *    NestJS TestingModule that wires the real RolesGuard + Reflector so we prove
 *    the controller decorators work end-to-end.
 *
 * 2. Magic-byte MIME detection (detectMimeFromBuffer)
 *    - Pure-function unit tests for each supported format.
 *    - DocumentsService.upload rejects when declared MIME ≠ detected MIME.
 *    - DocumentsService.upload rejects when bytes are unrecognised.
 *
 * 3. CompressionService.compress error → CompressionError thrown (not passthrough)
 *    DocumentsService.upload surfaces this as 415.
 *
 * 4. presignTtlForCategory — category-based presigned URL TTL
 *    Sensitive categories → SENSITIVE_PRESIGN_TTL_SEC; others → DEFAULT_PRESIGN_TTL_SEC.
 */
import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { CompressionError, detectMimeFromBuffer } from './compression.service'
import { DocumentsService } from './documents.service'
import {
  DEFAULT_PRESIGN_TTL_SEC,
  SENSITIVE_PRESIGN_TTL_SEC,
  presignTtlForCategory,
} from './s3.service'

// =============================================================================
// Section 1 — RBAC guard tests (restore + hardDelete via HTTP)
// =============================================================================

/**
 * Minimal controller that mirrors the real guard decorators on restore/hardDelete.
 * We use a sentinel controller so we don't need to wire up the full multipart
 * infrastructure that DocumentsController depends on.
 */
@Controller('test-docs')
class GuardSentinelController {
  @Post(':id/restore')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return { action: 'restore', id, role: user.role }
  }

  @Delete(':id/hard')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  hardDelete(@Param('id', ParseUUIDPipe) _id: string) {
    return null
  }

  // Soft-delete has no guard (owner OR ADMIN, enforced in service) — control endpoint.
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  softDelete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return { action: 'softDelete', id, role: user.role }
  }
}

const JWT_SECRET = 'hardening-test-secret-minimum-32-chars!'

function makeToken(user: Partial<SessionUser> & { id: string; role: string }, svc: JwtService) {
  return svc.sign(user)
}

const TEST_UUID = '11111111-2222-3333-4444-555555555555'

describe('RBAC guards — restore and hardDelete controller endpoints', () => {
  let app: NestFastifyApplication
  let jwtService: JwtService

  beforeAll(async () => {
    @Module({
      imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
      controllers: [GuardSentinelController],
      providers: [
        Reflector,
        // JwtAuthGuard first: populates req.user from the `jwt` cookie.
        // useFactory avoids esbuild metadata stripping (same pattern as
        // contract-controllers.integration.spec.ts and onboarding guard spec).
        {
          provide: APP_GUARD,
          useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
          inject: [JwtService, Reflector],
        },
        // RolesGuard second: reads req.user.role + @Roles() metadata.
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) => new RolesGuard(reflector),
          inject: [Reflector],
        },
      ],
    })
    class GuardTestModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [GuardTestModule],
    })
      // When `@UseGuards(RolesGuard)` appears on a controller method, NestJS tries
      // to DI-resolve RolesGuard — but vitest/esbuild strips `design:paramtypes`
      // so the reflector arg comes in as undefined. Override with a manually
      // constructed instance (same pattern as admin-summary.integration.spec.ts).
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    // cookie plugin required — JwtAuthGuard reads request.cookies['jwt']
    await app.register(cookie as never)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwtService = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    await app?.close()
  })

  // JwtAuthGuard reads the JWT from the `jwt` cookie (not Authorization header).
  function jwtCookie(role: string) {
    const token = makeToken(
      { id: 'd0c00000-0000-4000-a000-000000000001', role, displayName: 'Test', email: 'test-user@test.spec', seniorSharePercent: 26 },
      jwtService,
    )
    return { Cookie: `jwt=${token}` }
  }

  // ---- restore ----

  it('restore: non-ADMIN (SENIOR) → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/test-docs/${TEST_UUID}/restore`,
      headers: jwtCookie('SENIOR'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('restore: non-ADMIN (JUNIOR) → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/test-docs/${TEST_UUID}/restore`,
      headers: jwtCookie('JUNIOR'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('restore: non-ADMIN (HR) → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/test-docs/${TEST_UUID}/restore`,
      headers: jwtCookie('HR'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('restore: ADMIN → 201 (guard passes, POST default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/test-docs/${TEST_UUID}/restore`,
      headers: jwtCookie('ADMIN'),
    })
    // NestJS defaults @Post handlers to 201 Created unless @HttpCode overrides.
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ action: 'restore', role: 'ADMIN' })
  })

  // ---- hardDelete ----

  it('hardDelete: non-ADMIN (SENIOR) → 403', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/test-docs/${TEST_UUID}/hard`,
      headers: jwtCookie('SENIOR'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('hardDelete: non-ADMIN (ACCOUNTANT) → 403', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/test-docs/${TEST_UUID}/hard`,
      headers: jwtCookie('ACCOUNTANT'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('hardDelete: ADMIN → 204 (guard passes)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/test-docs/${TEST_UUID}/hard`,
      headers: jwtCookie('ADMIN'),
    })
    expect(res.statusCode).toBe(204)
  })

  // ---- softDelete has no RBAC guard (sanity check) ----
  it('softDelete: non-ADMIN (JUNIOR) reaches controller (no RolesGuard → no 403 at guard layer)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/test-docs/${TEST_UUID}`,
      headers: jwtCookie('JUNIOR'),
    })
    // The sentinel controller has no RolesGuard — JWT passes → reaches handler
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).not.toBe(401)
  })
})

// =============================================================================
// Section 2 — detectMimeFromBuffer unit tests
// =============================================================================

describe('detectMimeFromBuffer — magic-byte MIME detection', () => {
  it('detects JPEG from FF D8 FF signature', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    expect(detectMimeFromBuffer(buf)).toBe('image/jpeg')
  })

  it('detects PNG from 89 50 4E 47 signature', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    expect(detectMimeFromBuffer(buf)).toBe('image/png')
  })

  it('detects WebP from RIFF????WEBP signature', () => {
    // bytes 0-3 = RIFF, 4-7 = file size (arbitrary), 8-11 = WEBP
    const buf = Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x24,
      0x00,
      0x00,
      0x00, // file size
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
      0x56,
      0x50,
      0x38,
      0x20, // VP8 chunk
    ])
    expect(detectMimeFromBuffer(buf)).toBe('image/webp')
  })

  it('detects PDF from %PDF signature', () => {
    const buf = Buffer.from('%PDF-1.4 rest of header')
    expect(detectMimeFromBuffer(buf)).toBe('application/pdf')
  })

  it('detects HEIC from ftyp box with heic brand', () => {
    // offset 4-7 = "ftyp", offset 8-11 = "heic"
    const buf = Buffer.alloc(20)
    buf.write('ftyp', 4, 'ascii')
    buf.write('heic', 8, 'ascii')
    expect(detectMimeFromBuffer(buf)).toBe('image/heic')
  })

  it('detects HEIC from ftyp box with mif1 brand', () => {
    const buf = Buffer.alloc(20)
    buf.write('ftyp', 4, 'ascii')
    buf.write('mif1', 8, 'ascii')
    expect(detectMimeFromBuffer(buf)).toBe('image/heic')
  })

  it('returns null for unknown binary (zip signature)', () => {
    // ZIP: 50 4B 03 04
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
    expect(detectMimeFromBuffer(buf)).toBeNull()
  })

  it('returns null for buffer shorter than 4 bytes', () => {
    expect(detectMimeFromBuffer(Buffer.from([0xff, 0xd8]))).toBeNull()
  })

  it('does not detect SVG/HTML as known type (XSS hardening — svg+xml not in whitelist)', () => {
    const buf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(detectMimeFromBuffer(buf)).toBeNull()
  })
})

// =============================================================================
// Section 3 — DocumentsService.upload magic-byte + compression error (unit)
// =============================================================================

/**
 * Minimal harness for DocumentsService — just enough to reach the MIME checks.
 * Uses the same compression mock pattern from documents.service.spec.ts.
 */
function makeMimeHarness() {
  const docsRows: unknown[] = []
  const db = {
    db: {
      query: {
        documents: { findFirst: async () => undefined },
        users: { findFirst: async () => undefined },
      },
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => [
            {
              id: v['id'],
              ownerId: v['ownerId'],
              projectId: null,
              category: v['category'],
              name: v['name'],
              originalName: v['originalName'],
              s3Key: v['s3Key'],
              thumbnailS3Key: null,
              sizeBytes: v['sizeBytes'],
              mimeType: v['mimeType'],
              uploadedBy: v['uploadedBy'],
              deletedAt: null,
              deletedBy: null,
              createdAt: new Date(),
            },
          ],
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      delete: () => ({ where: async () => undefined }),
    },
  }

  const s3 = {
    upload: vi.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: vi.fn().mockResolvedValue({
      url: 'https://signed.example/abc',
      expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  }

  const compression = {
    compress: vi.fn(async (buffer: Buffer, mime: string) => ({
      buffer,
      finalMimeType: mime,
      sizeBytes: buffer.length,
    })),
    makeThumbnail: vi.fn().mockResolvedValue(null),
  }

  const service = new DocumentsService(db as never, s3 as never, compression as never)
  return { service, s3, compression, docsRows }
}

// Real JPEG magic bytes header (just enough for detection, not a valid image)
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
// Real PDF magic bytes
const PDF_MAGIC = Buffer.from('%PDF-1.4 minimal content for testing purposes only')

const ADMIN_USER: SessionUser = {
  id: 'admin-uuid-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.com',
  avatar: null,
  seniorSharePercent: 26,
}

describe('DocumentsService.upload — magic-byte MIME validation', () => {
  it('rejects when declared MIME is "image/jpeg" but bytes are PDF → 415', async () => {
    const { service } = makeMimeHarness()
    await expect(
      service.upload(
        ADMIN_USER,
        { buffer: PDF_MAGIC, mimetype: 'image/jpeg', originalname: 'fake.jpg' },
        { category: 'RESUME' },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException)
  })

  it('rejects when declared MIME is "application/pdf" but bytes are JPEG → 415', async () => {
    const { service } = makeMimeHarness()
    await expect(
      service.upload(
        ADMIN_USER,
        { buffer: JPEG_MAGIC, mimetype: 'application/pdf', originalname: 'fake.pdf' },
        { category: 'RESUME' },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException)
  })

  it('rejects unrecognised binary (zip bytes) even with valid declared MIME → 415', async () => {
    const { service } = makeMimeHarness()
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00])
    await expect(
      service.upload(
        ADMIN_USER,
        { buffer: zipBytes, mimetype: 'application/pdf', originalname: 'disguised.pdf' },
        { category: 'RESUME' },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException)
  })

  it('allows upload when declared MIME matches detected MIME (PDF)', async () => {
    const { service } = makeMimeHarness()
    await expect(
      service.upload(
        ADMIN_USER,
        { buffer: PDF_MAGIC, mimetype: 'application/pdf', originalname: 'real.pdf' },
        { category: 'RESUME' },
      ),
    ).resolves.toBeDefined()
  })

  it('allows upload when declared MIME matches detected MIME (JPEG)', async () => {
    const { service } = makeMimeHarness()
    // compression mock returns finalMimeType=image/jpeg, which after detection becomes image/jpeg
    await expect(
      service.upload(
        ADMIN_USER,
        { buffer: JPEG_MAGIC, mimetype: 'image/jpeg', originalname: 'real.jpg' },
        { category: 'RESUME' },
      ),
    ).resolves.toBeDefined()
  })
})

describe('DocumentsService.upload — compression error surfaces as 415', () => {
  it('returns 415 when CompressionService throws CompressionError', async () => {
    const { service, compression } = makeMimeHarness()
    // Override compression mock to simulate a sharp/pdf-lib failure
    compression.compress.mockRejectedValueOnce(new CompressionError('sharp: Input file is missing'))

    await expect(
      service.upload(
        ADMIN_USER,
        { buffer: PDF_MAGIC, mimetype: 'application/pdf', originalname: 'corrupt.pdf' },
        { category: 'RESUME' },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException)
  })

  it('re-throws non-CompressionError (infrastructure errors bubble up)', async () => {
    const { service, compression } = makeMimeHarness()
    const infraError = new Error('S3 connection refused')
    compression.compress.mockRejectedValueOnce(infraError)

    const rejection = await service
      .upload(
        ADMIN_USER,
        { buffer: PDF_MAGIC, mimetype: 'application/pdf', originalname: 'infra-fail.pdf' },
        { category: 'RESUME' },
      )
      .catch((e: unknown) => e)

    // Must be the original error — NOT wrapped as UnsupportedMediaTypeException
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).not.toBeInstanceOf(UnsupportedMediaTypeException)
    expect((rejection as Error).message).toBe('S3 connection refused')
  })
})

// =============================================================================
// Section 4 — presignTtlForCategory unit tests
// =============================================================================

describe('presignTtlForCategory — category-based presigned URL TTL', () => {
  it('CONTRACT → short TTL (30 min)', () => {
    expect(presignTtlForCategory('CONTRACT')).toBe(SENSITIVE_PRESIGN_TTL_SEC)
  })

  it('RECEIPT → short TTL', () => {
    expect(presignTtlForCategory('RECEIPT')).toBe(SENSITIVE_PRESIGN_TTL_SEC)
  })

  it('INVOICE → short TTL', () => {
    expect(presignTtlForCategory('INVOICE')).toBe(SENSITIVE_PRESIGN_TTL_SEC)
  })

  it('RESUME → short TTL', () => {
    expect(presignTtlForCategory('RESUME')).toBe(SENSITIVE_PRESIGN_TTL_SEC)
  })

  it('SCAN → short TTL', () => {
    expect(presignTtlForCategory('SCAN')).toBe(SENSITIVE_PRESIGN_TTL_SEC)
  })

  it('AVATAR → default TTL (24h)', () => {
    expect(presignTtlForCategory('AVATAR')).toBe(DEFAULT_PRESIGN_TTL_SEC)
  })

  it('LOGO → default TTL (24h)', () => {
    expect(presignTtlForCategory('LOGO')).toBe(DEFAULT_PRESIGN_TTL_SEC)
  })

  it('null → default TTL (24h)', () => {
    expect(presignTtlForCategory(null)).toBe(DEFAULT_PRESIGN_TTL_SEC)
  })

  it('undefined → default TTL (24h)', () => {
    expect(presignTtlForCategory(undefined)).toBe(DEFAULT_PRESIGN_TTL_SEC)
  })

  it('SENSITIVE_PRESIGN_TTL_SEC is 30 minutes', () => {
    expect(SENSITIVE_PRESIGN_TTL_SEC).toBe(30 * 60)
  })

  it('DEFAULT_PRESIGN_TTL_SEC is 24 hours', () => {
    expect(DEFAULT_PRESIGN_TTL_SEC).toBe(24 * 60 * 60)
  })
})
