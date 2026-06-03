# MCP Configs — CheekyCheeseIT CRM × ECC

Сохранены **canonical ECC MCP server configs** для аудита (`mcp-servers.json`) — это reference из upstream ECC v2.0.0-rc.1.

**Наш реальный setup** для MCP-серверов — в user-level `~/.claude/settings.json` (per-user), не в проектном tracked файле. Это by design — токены и paths personalized.

## Cross-reference: наш setup vs ECC canonical

| Server            | Наш setup | ECC canonical                             | Action                                                                                         |
| ----------------- | --------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ast-grep`        | Active    | ❌ Not in ECC mcp-servers.json            | **Keep custom** — наш ключевой инструмент для structural search per CLAUDE.md MCP-first policy |
| `context7`        | Active    | ✅ `mcp-servers.json`                     | **Adopt ECC config** (identical: `@upstash/context7-mcp@latest` через npx)                     |
| `postgres`        | Active    | ❌ (ECC ships `clickhouse` instead)       | **Keep custom** — PostgreSQL via Drizzle, нужен for schema inspection                          |
| `eslint`          | Active    | ❌                                        | **Keep custom** — наш pre-lint hook                                                            |
| `playwright`      | Active    | ✅ `mcp-servers.json`                     | **Adopt ECC config** (identical: `@playwright/mcp --browser chrome`)                           |
| `github`          | Active    | ✅ `mcp-servers.json`                     | **Adopt ECC config** (identical: `@modelcontextprotocol/server-github` с PAT env var)          |
| `scheduled-tasks` | Active    | ❌                                        | **Keep custom** — наш Layer 2 cross-session wakeups (Anthropic скрипт)                         |
| `ccd-session`     | Active    | ❌ (ECC ships `longhand` для similar use) | **Keep custom** — наш session orchestrator                                                     |

### Servers в ECC которые мы НЕ adoptим

| ECC server                                                  | Reason skip                                      |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `jira`, `confluence`                                        | Не используем Atlassian stack                    |
| `firecrawl`, `exa-web-search`, `browserbase`, `browser-use` | Web scraping не часть нашего workflow            |
| `supabase`                                                  | Используем self-hosted Postgres                  |
| `memory`, `omega-memory`, `longhand`, `squish`              | У нас уже `ccd-session` для memory orchestration |
| `vercel`, `railway`, `cloudflare-*`                         | Deployment не через эти платформы                |
| `clickhouse`, `laraplugins`                                 | Не используем                                    |
| `magic`, `fal-ai`                                           | UI generation не часть workflow                  |
| `filesystem`                                                | Используем встроенный Read/Write/Edit            |
| `sequential-thinking`                                       | Используем встроенный thinking                   |
| `devfleet`                                                  | Используем `Agent` tool через PM                 |
| `token-optimizer`                                           | Полагаемся на встроенный manage                  |
| `evalview`                                                  | Не делаем agent regression testing yet           |

### Phase 2+ план

- Phase 2: рассмотреть adoption ECC `block-no-verify` hook pattern (уже есть наш analog)
- Phase 5: при extraction rules, переписать MCP-first policy из CLAUDE.md в `rules/common/mcp-first.md`

### Источники

- ECC upstream `mcp-configs/mcp-servers.json` (этот файл, immutable copy)
- Наш `CLAUDE.md` "MCP серверы (активные)" секция — авторитет нашего setup
- ADR Section 2.7.1 — decision matrix
