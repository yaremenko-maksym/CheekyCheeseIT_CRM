import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { Env } from '../config/env'
import * as schema from './schema'

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool!: Pool
  db!: NodePgDatabase<typeof schema>

  constructor(private config: ConfigService<Env>) {}

  async onModuleInit() {
    this.pool = new Pool({ connectionString: this.config.get('DATABASE_URL', { infer: true }) })
    this.db = drizzle(this.pool, { schema })
  }

  async onModuleDestroy() {
    await this.pool.end()
  }
}
