import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  adminUpdateUserSchema,
  createUserSchema,
  updateProfileSchema,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { UsersService } from './users.service'

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async findAll(@CurrentUser() currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
      throw new ForbiddenException()
    }
    if (currentUser.role === 'ADMIN') {
      return this.usersService.findAllIncludingAdmin()
    }
    return this.usersService.findAll()
  }

  @Post()
  async createUser(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') throw new ForbiddenException()
    const dto = createUserSchema.parse(body)
    if (currentUser.role === 'HR' && dto.role !== 'SENIOR') throw new ForbiddenException('HR может создавать только синьоров')
    return this.usersService.createUser({
      email: dto.email,
      displayName: dto.displayName,
      role: dto.role,
      telegram: dto.telegram ?? null,
      phone: dto.phone ?? null,
      avatar: dto.avatar ?? null,
      techStack: dto.techStack ?? null,
      ...(dto.seniorSharePercent !== undefined && { seniorSharePercent: dto.seniorSharePercent }),
      monthlySalary: dto.monthlySalary ?? null,
      hrIds: dto.hrIds ?? [],
      accountantId: dto.accountantId ?? null,
      projectId: dto.projectId ?? null,
    })
  }

  // Static named routes MUST come before :id to avoid NestJS matching "me" as an id param
  @Get('me')
  async getMe(@CurrentUser() currentUser: SessionUser) {
    return this.usersService.getProfile(currentUser.id)
  }

  @Patch('me')
  async updateMe(@CurrentUser() currentUser: SessionUser, @Body() body: unknown) {
    const dto = updateProfileSchema.parse(body)
    return this.usersService.updateProfile(currentUser.id, {
      telegram: dto.telegram ?? undefined,
      phone: dto.phone ?? undefined,
    })
  }

  @Get(':id')
  async getProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getProfile(id)
  }

  @Patch(':id')
  async updateUser(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const dto = adminUpdateUserSchema.parse(body)
    const data: Parameters<typeof this.usersService.adminUpdateUser>[1] = {}
    if (dto.displayName !== undefined) data.displayName = dto.displayName
    if (dto.role !== undefined) data.role = dto.role
    if ('telegram' in dto) data.telegram = dto.telegram ?? null
    if ('phone' in dto) data.phone = dto.phone ?? null
    if ('avatar' in dto) data.avatar = dto.avatar ?? null
    if ('techStack' in dto) data.techStack = dto.techStack ?? null
    if (dto.seniorSharePercent !== undefined) data.seniorSharePercent = dto.seniorSharePercent
    if ('monthlySalary' in dto) data.monthlySalary = dto.monthlySalary ?? null
    return this.usersService.adminUpdateUser(id, data)
  }

  @Delete(':id')
  async deleteUser(@CurrentUser() currentUser: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    if (id === currentUser.id) throw new ForbiddenException('Cannot delete yourself')
    await this.usersService.deleteUser(id)
    return { success: true }
  }
}
