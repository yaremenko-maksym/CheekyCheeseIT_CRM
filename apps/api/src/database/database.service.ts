import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { Env } from '../config/env'
import * as schema from './schema'

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name)
  private pool!: Pool
  db!: NodePgDatabase<typeof schema>

  constructor(private config: ConfigService<Env>) {}

  async onModuleInit() {
    this.pool = new Pool({ connectionString: this.config.get('DATABASE_URL', { infer: true }) })
    // An error on an IDLE client is emitted on the pool; with no listener Node treats it as an
    // unhandled 'error' event and kills the process (a database restart then crash-loops the API).
    // pg already discards the broken client and opens a fresh one on the next query, so the
    // listener only has to make the event visible. The SQLSTATE rides in the message because the
    // production log alert matches on it (e.g. 42501).
    this.pool.on('error', (err: Error & { code?: string }) => {
      const sqlstate = err.code ? ` sqlstate=${err.code}` : ''
      this.logger.error(`Postgres pool idle-client error${sqlstate}: ${err.message}`, err.stack)
    })
    this.db = drizzle(this.pool, { schema })
  }

  async onModuleDestroy() {
    await this.pool.end()
  }
}
