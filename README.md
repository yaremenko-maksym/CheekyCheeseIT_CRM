# CheekyCheeseIT CRM

CRM system for reverse-recruiting workspace — multi-agent driven development.

**Stack:** Turborepo · React + Vite SPA + TanStack Router/Query/Form · NestJS 11 + Fastify · Drizzle ORM + PostgreSQL · Redis · Tailwind v4 + shadcn/ui · Playwright E2E

## Prerequisites

- Node 20 LTS
- pnpm 7.32.4 (`npm install -g pnpm@7.32.4`)
- Docker (for Postgres + Redis)

## Setup

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # fill in secrets
cp apps/web/.env.example apps/web/.env
docker compose up -d                     # start Postgres + Redis
pnpm --filter @crm/api db:push           # sync schema (push-based, no migrations)
pnpm --filter @crm/api db:seed           # seed initial data
```

## Development

```bash
pnpm dev:start   # docker compose up -d + turbo dev (all apps)
```

- Frontend: http://localhost:3000
- API: http://localhost:3001
- API health: http://localhost:3001/api/health

## Commands

```bash
pnpm typecheck   # TypeScript check (all packages)
pnpm lint        # ESLint (all packages)
pnpm test        # Vitest unit tests
pnpm build       # Production build (shared → api, web)

pnpm --filter @crm/e2e test   # Playwright E2E
```

## Architecture

See [docs/README.md](docs/README.md) for agent workflow and documentation structure.

```
apps/
  web/      # Vite SPA — TanStack Router, port 3000
  api/      # NestJS 11 + Fastify, port 3001
  e2e/      # Playwright E2E tests
packages/
  shared/   # Zod schemas + types (Single Source of Truth)
docs/
  agents/   # System prompts for AI development agents
  business/ # User flows, stories, module specs
  specs/    # Active task + archive
```
