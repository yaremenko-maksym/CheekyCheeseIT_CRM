import { Global, Module } from '@nestjs/common'
import { DatabaseService } from './database.service'
import { PrivilegeDeniedReporter } from './privilege-denied-reporter'

@Global()
@Module({
  // `PrivilegeDeniedReporter` is the alert's chokepoint for SQLSTATE 42501 — see its header.
  providers: [DatabaseService, PrivilegeDeniedReporter],
  exports: [DatabaseService],
})
export class DatabaseModule {}
