/**
 * PublicVacanciesController — PUBLIC surface for the landing page.
 *
 *   GET  /api/public/vacancies               — list PUBLISHED vacancies
 *   GET  /api/public/vacancies/:slug         — one vacancy (404 for DRAFT/CLOSED/missing)
 *   POST /api/public/vacancies/:slug/apply   — multipart apply (resume + fields)
 *
 * Marked `@Public()` on every handler so the globally registered JwtAuthGuard
 * (AppModule APP_GUARD) does not 401 these requests — same pattern as
 * `InvoicesVerifyController`. A SEPARATE class from `VacanciesController`
 * (the ADMIN|HR controller) — mixing public + guarded routes on one class
 * risks a copy-paste `@Roles()` ending up on the wrong handler.
 *
 * Multipart handling mirrors DocumentsController (Fastify native multipart,
 * `@fastify/multipart` registered globally in main.ts).
 *
 * Explicit @Inject on every dependency so this REAL controller can be
 * instantiated by Nest's DI in the vitest/esbuild test env (no
 * `design:paramtypes` emission there) — same pattern as VacanciesController /
 * CompanyAccountController. Lets integration specs exercise THIS controller
 * directly, not a sentinel copy.
 */
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { Public } from '../auth/public.decorator'
import { RelaxableThrottle } from '../config/throttle-decorators'
import { ApplicationsService, type ApplyResumeFile } from './applications.service'
import { VacanciesService } from './vacancies.service'

/** Minimal shape of a multipart field as returned by @fastify/multipart. */
interface MultipartField {
  type: 'field' | 'file'
  fieldname: string
  value?: unknown
  toBuffer?: () => Promise<Buffer>
  mimetype?: string
  filename?: string
}

/**
 * Prod cap for vacancy-apply submissions — task §5.1: "жёсткий бакет ~5
 * запросов/час на IP". Relaxable in non-prod via THROTTLE_RELAXED (CI/E2E).
 */
export const VACANCY_APPLY_LIMIT = 5
const VACANCY_APPLY_TTL_MS = 60 * 60 * 1000 // 1 hour

@Controller('public/vacancies')
export class PublicVacanciesController {
  constructor(
    @Inject(VacanciesService) private readonly vacanciesService: VacanciesService,
    @Inject(ApplicationsService) private readonly applicationsService: ApplicationsService,
  ) {}

  @Get()
  @Public()
  listPublic() {
    return this.vacanciesService.listPublic()
  }

  // NOTE: registered AFTER `:slug/apply` would shadow it if `apply` were a
  // GET — it's a POST, so route order between the two GETs here is safe;
  // Nest matches by method+path, not declaration order across HTTP verbs.
  @Get(':slug')
  @Public()
  getPublicBySlug(@Param('slug') slug: string) {
    return this.vacanciesService.getPublicBySlug(slug)
  }

  @Post(':slug/apply')
  @Public()
  @RelaxableThrottle(VACANCY_APPLY_LIMIT, VACANCY_APPLY_TTL_MS)
  @HttpCode(HttpStatus.CREATED)
  async apply(@Param('slug') slug: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) {
      throw new BadRequestException('Content-Type must be multipart/form-data')
    }

    let file: ApplyResumeFile | null = null
    const fields: Record<string, string> = {}

    for await (const part of req.parts() as AsyncIterable<MultipartField>) {
      if (part.type === 'file' && part.fieldname === 'resume') {
        // Only one file per submission — first one wins.
        if (file) continue
        const buffer = await (part.toBuffer
          ? part.toBuffer()
          : Promise.reject(new Error('Multipart file has no toBuffer()')))
        file = {
          buffer,
          mimetype: part.mimetype ?? 'application/octet-stream',
          originalname: part.filename ?? 'resume.pdf',
        }
      } else if (part.type === 'field') {
        if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value
        }
      }
    }

    return this.applicationsService.apply(slug, fields, file, req.ip)
  }
}
