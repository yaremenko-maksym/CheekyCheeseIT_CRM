import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { LegendsController } from './legends.controller'
import { LegendsService } from './legends.service'

@Module({
  imports: [DatabaseModule],
  controllers: [LegendsController],
  providers: [LegendsService],
  exports: [LegendsService],
})
export class LegendsModule {}
