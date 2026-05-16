import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { FastifyRequest } from 'fastify'

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>()
    const token = request.cookies?.['jwt']
    if (!token) throw new UnauthorizedException()
    try {
      const payload = this.jwt.verify(token)
      ;(request as FastifyRequest & { user: unknown }).user = payload
      return true
    } catch {
      throw new UnauthorizedException()
    }
  }
}
