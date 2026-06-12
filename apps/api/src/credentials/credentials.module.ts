import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { CredentialsController } from './credentials.controller'
import { CredentialsCryptoService } from './credentials-crypto.service'
import { CredentialsService } from './credentials.service'

// HrAccessService comes from the @Global CommonModule; DatabaseService from the
// @Global DatabaseModule. CredentialsCryptoService is local to this module.
@Module({
  imports: [DatabaseModule],
  controllers: [CredentialsController],
  providers: [CredentialsService, CredentialsCryptoService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
