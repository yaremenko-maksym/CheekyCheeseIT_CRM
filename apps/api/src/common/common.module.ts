import { Global, Module } from '@nestjs/common'
import { HrAccessService } from './hr-access.service'

/**
 * Cross-cutting providers shared across feature modules.
 *
 * @Global so HrAccessService is injectable in legends / projects / credentials
 * without each module importing CommonModule explicitly (DatabaseModule is also
 * @Global, so HrAccessService's dependency resolves transparently).
 */
@Global()
@Module({
  providers: [HrAccessService],
  exports: [HrAccessService],
})
export class CommonModule {}
