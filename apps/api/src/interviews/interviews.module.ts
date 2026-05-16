import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { ProjectsModule } from '../projects/projects.module'
import { InterviewsController } from './interviews.controller'
import { InterviewsService } from './interviews.service'

@Module({
  imports: [DatabaseModule, AuthModule, ProjectsModule],
  controllers: [InterviewsController],
  providers: [InterviewsService],
})
export class InterviewsModule {}
