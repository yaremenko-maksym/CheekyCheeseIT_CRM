/**
 * DocumentsModule — wires together the documents API.
 *
 *   DatabaseModule is global (see database.module.ts @Global()), so no need
 *   to import it explicitly — DatabaseService is injectable everywhere.
 *
 *   AuthModule is forwardRef'd because JwtAuthGuard / CurrentUser depend on
 *   @nestjs/jwt's JwtService, which is provided by AuthModule. We export
 *   DocumentsService so that future modules (Finance receipt integration,
 *   ProfileModule avatar uploads, ProjectsModule logo uploads) can reuse the
 *   upload pipeline directly.
 */
import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { CompressionService } from './compression.service'
import { DocumentsController } from './documents.controller'
import { DocumentsReconciliationService } from './documents-reconciliation.service'
import { DocumentsService } from './documents.service'
import { S3Service } from './s3.service'

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [DocumentsController],
  providers: [DocumentsService, S3Service, CompressionService, DocumentsReconciliationService],
  exports: [DocumentsService, S3Service, CompressionService, DocumentsReconciliationService],
})
export class DocumentsModule {}
