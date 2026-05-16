import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { ZodError } from 'zod'

@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()
    reply.status(HttpStatus.BAD_REQUEST).send({
      statusCode: 400,
      message: 'Validation failed',
      errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
}
