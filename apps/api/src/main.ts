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

  const isProd = process.env['NODE_ENV'] === 'production'

  await app.register(helmet, {
    // In development CSP is disabled for easier debugging (hot-reload, devtools).
    // In production an explicit policy is applied:
    //   script-src 'self'          — no inline scripts, no CDN
    //   frame-src 'none'           — no embedding in iframes
    //   img-src 'self' data:       — allow inline data: images (avatars, logos)
    //   font-src 'self'            — self-hosted fonts only
    //   connect-src 'self'         — XHR/fetch to same origin only
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https://api.dicebear.com', 'https:'],
            fontSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"], // clickjacking defense (#100 MED-1)
            formAction: ["'self'"], // restrict form submissions to same origin (#100 LOW-1)
          },
        }
      : false,
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
    origin: [
      process.env['FRONTEND_URL'] ?? 'http://localhost:3000',
      /\.serveo\.net$/,
      /\.serveousercontent\.com$/,
    ],
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
