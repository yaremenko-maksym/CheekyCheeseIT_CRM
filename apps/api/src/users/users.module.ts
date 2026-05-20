import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { UsersController } from './users.controller'
import { UsersAccessService } from './users-access.service'
import { UsersService } from './users.service'

@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule)],
  controllers: [UsersController],
  providers: [UsersService, UsersAccessService],
  exports: [UsersService, UsersAccessService],
})
export class UsersModule {}
