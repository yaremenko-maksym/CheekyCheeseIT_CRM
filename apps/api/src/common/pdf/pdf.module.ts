/**
 * PdfModule — NestJS module exporting PdfGenerationService.
 *
 * Import this module in any feature module that needs to generate PDFs:
 *
 *   @Module({ imports: [PdfModule, ...], ... })
 *   export class InvoicesModule {}
 *
 * PdfGenerationService is a stateless injectable (it only holds references to
 * process-level font cache Map which lives in pdf.utils.ts). Multiple feature
 * modules can import PdfModule safely — NestJS will provide a single shared
 * instance.
 */
import { Module } from '@nestjs/common'
import { PdfGenerationService } from './pdf-generation.service'

@Module({
  providers: [PdfGenerationService],
  exports: [PdfGenerationService],
})
export class PdfModule {}
