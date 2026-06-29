import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import {
  contractTargetRoleSchema,
  createContractTemplateSchema,
  previewContractPdfSchema,
  type ContractTargetRole,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { AdminWriteThrottle } from '../config/throttle-decorators'
import { DatabaseService } from '../database/database.service'
import { ContractTemplatesService } from './contract-templates.service'
import { ContractPdfService } from './contract-pdf.service'
import { appendCompanyRequisitesSection, renderContractTemplate } from './contract-rendering'

/**
 * RBAC summary (Phase 6A):
 *
 * | Endpoint                                        | Allowed roles / guard        |
 * | ----------------------------------------------- | ---------------------------- |
 * | GET    /api/contracts/templates                 | ADMIN                        |
 * | GET    /api/contracts/templates/current/:role   | ADMIN or self (role match)   |
 * | POST   /api/contracts/templates                 | ADMIN                        |
 * | POST   /api/contracts/templates/preview-pdf     | ADMIN                        |
 * | GET    /api/contracts/templates/preview-rendered/:id | any authenticated user  |
 * | GET    /api/contracts/templates/:id             | ADMIN                        |
 *
 * `current/:role` and `preview-rendered/:id` are both reachable through the
 * OnboardingGuard bypass list so pre-onboarding users can see the wizard and
 * the personalised preview before signing. `preview-rendered` resolves user
 * data from `req.user.id` (JWT) — no IDOR surface.
 */
// JwtAuthGuard runs globally (AppModule APP_GUARD); RolesGuard stays
// controller-level because it depends on `req.user.role`.
@Controller('contracts/templates')
@UseGuards(RolesGuard)
export class ContractTemplatesController {
  // Explicit @Inject so Nest's DI can construct this controller in the
  // vitest/esbuild test env (which omits `design:paramtypes`), letting the
  // preview-pdf integration spec exercise the REAL controller + guards. No-op
  // in prod (tsc/SWC emit the metadata). Mirrors CompanyAccountController.
  constructor(
    @Inject(ContractTemplatesService) private readonly service: ContractTemplatesService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ContractPdfService) private readonly contractPdf: ContractPdfService,
  ) {}

  @Get()
  @Roles('ADMIN')
  list() {
    return this.service.listAll()
  }

  @Get('current/:role')
  async current(@Param('role') role: string, @CurrentUser() user: SessionUser) {
    const parsed = contractTargetRoleSchema.safeParse(role)
    if (!parsed.success) {
      throw new BadRequestException('Invalid role')
    }
    const targetRole = parsed.data as ContractTargetRole

    // Non-ADMIN callers can only fetch their OWN role's template.
    if (user.role !== 'ADMIN' && user.role !== targetRole) {
      throw new ForbiddenException()
    }

    return this.service.getCurrentForRole(targetRole)
  }

  // Publishing a new template version is a sensitive write — limit to
  // 5 requests per minute per IP to prevent abuse.
  // Raised to global limit in non-prod when THROTTLE_RELAXED=true.
  @Post()
  @Roles('ADMIN')
  @AdminWriteThrottle()
  publish(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { targetRole, bodyMarkdown, customVariables } = createContractTemplateSchema.parse(body)
    return this.service.publish({
      targetRole,
      bodyMarkdown,
      customVariables,
      createdByUserId: user.id,
    })
  }

  /**
   * `POST /api/contracts/templates/preview-pdf` — ADMIN-only PDF preview of the
   * template editor's CURRENT markdown (unsaved edits included).
   *
   * Owner decisions baked in:
   *   1. `{{tokens}}` stay VISIBLE — we do NOT run `renderContractTemplate`
   *      (no standard-variable substitution). The admin sees exactly where each
   *      token sits in the laid-out document.
   *   2. The company requisites section is appended (same helper as sign-time)
   *      so the preview matches what a signed contract will contain.
   *   3. Rendered in UNSIGNED/preview mode — empty `contractNumber` (shows '—'),
   *      empty `signedTypedName` (signature block shows «Требуется подпись» /
   *      «Awaiting signature»), `signedAt = now` (deterministic metadata only),
   *      and empty `verifyUrl` (no QR / no verify footer). Same letterhead /
   *      legal / layout as a real contract so the preview is faithful.
   *
   * Streams `application/pdf` bytes via `@Res()` (bypasses the global JSON
   * serialization interceptor). `no-store` because previews are ephemeral and
   * may contain unsaved draft content.
   */
  @Post('preview-pdf')
  @Roles('ADMIN')
  @AdminWriteThrottle()
  @Header('Cache-Control', 'no-store, private')
  async previewPdf(@Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    // `role` is validated for parity with the editor; the unsigned preview does
    // not branch on it (the body markdown drives rendering).
    const { bodyMarkdown } = previewContractPdfSchema.parse(body)

    // Append the CURRENT company requisites (mirrors sign-time), so the preview
    // shows the same trailing «Реквизиты компании» section. Tokens are NOT
    // substituted — bodyMarkdown is used verbatim.
    const companyRow = await this.db.db.query.companyAccount.findFirst()
    const previewBody = appendCompanyRequisitesSection(bodyMarkdown, companyRow?.requisitesMarkdown)

    const { pdfBuffer } = await this.contractPdf.generateContractPdf({
      contractNumber: '', // unsigned → renders '—'
      bodyMarkdown: previewBody,
      signedTypedName: '', // unsigned → «Требуется подпись» / «Awaiting signature»
      signedAt: new Date(), // deterministic metadata only; no «Подписан» line when unsigned
      verifyUrl: '', // no QR / no verify footer in preview
    })

    await reply
      .status(200) // POST defaults to 201 in Nest; a PDF body is a 200 OK read.
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="contract-preview.pdf"')
      .send(pdfBuffer)
  }

  /**
   * `GET /api/contracts/templates/preview-rendered/:templateId`
   *
   * Returns the template body with all `{{placeholder}}` tokens substituted
   * using the calling user's current profile data. This lets the onboarding
   * wizard show a personalised preview before the user signs.
   *
   * Auth: any authenticated user (no role restriction). ADMIN will always see
   * `onboardingDate = today` with their own profile data — they bypass the
   * gate anyway so this endpoint is for non-ADMIN previewing their own MSA.
   *
   * No throttle: read-only, cheap query, no side-effects.
   */
  @Get('preview-rendered/:templateId')
  async previewRendered(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ bodyMarkdown: string }> {
    const template = await this.service.getById(templateId)
    if (!template) {
      throw new NotFoundException('Contract template not found')
    }

    const userRow = await this.db.db.query.users.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, user.id),
    })
    if (!userRow) {
      throw new NotFoundException('User not found')
    }

    const { body } = renderContractTemplate(template.bodyMarkdown, userRow, new Date())
    return { bodyMarkdown: body }
  }

  @Get(':id')
  @Roles('ADMIN')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getById(id)
  }
}
