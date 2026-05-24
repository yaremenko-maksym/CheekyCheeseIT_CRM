import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { AppModule } from './app.module'
import { ZodExceptionFilter } from './zod-exception.filter'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: process.env['NODE_ENV'] !== 'test' }),
  )

  await app.register(helmet, {
    // Disable CSP in dev for easier debugging
    contentSecurityPolicy: process.env['NODE_ENV'] === 'production',
  })

  await app.register(cookie, {
    secret: process.env['SESSION_SECRET'] ?? '',
  })

  // Multipart uploads for /api/documents. Hard cap = 10 MB (DOCUMENT_MAX_BYTES
  // from @crm/shared); the controller also re-checks via Zod to surface a
  // clean 413 message instead of Fastify's generic 413.
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB
      files: 1,
    },
  })

  app.enableCors({
    origin: process.env['FRONTEND_URL'] ?? 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })

  app.useGlobalFilters(new ZodExceptionFilter())
  app.setGlobalPrefix('api')
  app.enableShutdownHooks()

  const port = process.env['API_PORT'] ?? 3001
  await app.listen(port, '0.0.0.0')
}

bootstrap()
