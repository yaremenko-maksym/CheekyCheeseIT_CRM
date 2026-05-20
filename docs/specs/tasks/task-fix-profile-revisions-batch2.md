# task-fix-profile-revisions-batch2

## Агент: coder
## Приоритет: high
## Ветка: claude/youthful-hermann-8df1d5 (PR #28 — already open)

## КРИТИЧЕСКИ ВАЖНО

- Это **fix-задача в существующую ветку** — не создавай новую ветку.
- `git fetch origin && git checkout claude/youthful-hermann-8df1d5 && git pull origin claude/youthful-hermann-8df1d5`
- Перед каждым ✅ выполни `git diff HEAD -- <файл>` и убедись, что изменение есть в diff.
- В конце push: `git push origin claude/youthful-hermann-8df1d5` → PR #28 обновится автоматически.
- Дев-серверы запущены (port 3000 web, 3001 api), используй их для smoke-проверки.

## Контекст

PR #28 — редизайн профилей. Юзер прошёл по UI и оставил два больших запроса. Все остальные правки уже сделаны и закоммичены в той же ветке (commit `43513eb`).

UserProfileShell уже принимает `onAvatarClick` prop в UserProfileHeader (currently undefined). DOM/structure готов — нужно только подключить modal и сохранение.

ProfileEditFields сейчас имеет chip input для tech_stack с Enter-добавлением. Аналогичный chip flow есть в `apps/web/app/components/user-profile/admin-actions/EditProfileDialog.tsx` (но techStack там нет, есть только в self-edit). Других мест с tech редактированием пока нет в профиле — НО есть в `apps/web/app/routes/crm/users/$userId.tsx` создание новых юзеров — там тоже chip input.

---

## ФИЧА 1 — Avatar upload modal

### 1.1 Drizzle schema
Файл: `apps/api/src/database/schema.ts`

Добавь колонку в таблицу `users` (рядом с существующим `avatar`):

```ts
avatarOverride: text('avatar_override'),
```

Поле опциональное — может содержать либо `https://...` URL, либо `data:image/...;base64,...` data-url. Когда оно заполнено — используется вместо `avatar` (Google-аватар) для отображения.

### 1.2 Drizzle migration
Создай файл `apps/api/drizzle/migrations/0008_avatar_override.sql` со statement-breakpoint:

```sql
ALTER TABLE "users" ADD COLUMN "avatar_override" text;
```

Обнови journal `apps/api/drizzle/meta/_journal.json` — добавь новый entry для idx 8 (увеличь `version` если нужно). Формат смотри по существующим entries.

Применить локально:
```bash
PGPASSWORD=password psql -h localhost -p 5432 -U crm_user -d crm_db -c 'ALTER TABLE "users" ADD COLUMN "avatar_override" text;'
```

### 1.3 Shared schema
Файл: `packages/shared/src/schemas/users.ts`

В `userProfileSchema`:
```ts
avatarOverride: z.string().nullable(),
```

В `updateProfileSchema` добавь поле:
```ts
avatarOverride: z.string().max(1_500_000, 'Аватар слишком большой (макс ~1MB)').nullable().optional(),
```

В `adminUpdateUserSchema` — то же самое.

В `userProfileSchema` существующий `avatar: z.string().url().nullable()` — оставить. Они оба сохраняются: `avatar` = Google, `avatarOverride` = пользовательский. Frontend выбирает override если есть.

### 1.4 Backend handler
Файл: `apps/api/src/users/users.service.ts`

В `updateProfile`:
```ts
if ('avatarOverride' in data) set.avatarOverride = data.avatarOverride ?? null
```

Аналогично в `adminUpdateUser`.

В `buildProfileView` — `filteredUser` уже включает все колонки через `{...target}`. Ничего фильтровать не надо.

### 1.5 Frontend hook update
Файл: `apps/web/app/hooks/use-user-profile.ts`

Hook `useUpdateMe` уже принимает любой patch — ничего менять не нужно (схема валидируется бекендом).

### 1.6 Avatar upload dialog component
Создай файл `apps/web/app/components/user-profile/AvatarUploadDialog.tsx`.

Требования:
- Используй shadcn `Dialog`, `Tabs` (если нет — создать через `pnpm dlx shadcn@latest add tabs`)
- Tabs: "Файл" и "Ссылка"
- "Файл":
  - `<input type="file" accept="image/*">` через ref + label-кнопка
  - Drag&drop overlay на всю площадь `DialogContent` (drop events с `preventDefault`)
  - При выборе файла: проверь size ≤ 500*1024 (показать ошибку при превышении)
  - Конвертация: `new FileReader(); fr.readAsDataURL(file)` → получаем `data:image/...;base64,...`
  - Preview: показать `<img src={dataUrl}>` под input (max-h-48)
- "Ссылка":
  - `<Input type="url">` для прямого URL
  - Preview: `<img src={urlValue}>` (с onError fallback)
- Кнопки: "Отмена" / "Сохранить"
- На "Сохранить": call `useUpdateMe()` с `{ avatarOverride: <dataUrl или URL> }`, потом `onClose()`
- Также добавь кнопку "Очистить" — отправляет `{ avatarOverride: null }`, чтобы вернуться к Google-аватару

Псевдокод:
```tsx
export function AvatarUploadDialog({ open, onClose, currentAvatarUrl }: Props) {
  const [tab, setTab] = useState<'file' | 'url'>('file')
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const updateMe = useUpdateMe()
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    if (!file.type.startsWith('image/')) { setError('Только изображения'); return }
    if (file.size > 500 * 1024) { setError(`Файл ${(file.size/1024).toFixed(0)} KB — макс 500 KB`); return }
    const fr = new FileReader()
    fr.onload = () => { setDataUrl(fr.result as string); setError(null) }
    fr.readAsDataURL(file)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleSave() {
    const value = tab === 'file' ? dataUrl : url
    if (!value) return
    updateMe.mutate({ avatarOverride: value } as any, { onSuccess: () => onClose() })
  }

  function handleClear() {
    updateMe.mutate({ avatarOverride: null } as any, { onSuccess: () => onClose() })
  }

  // ... JSX with Dialog, Tabs, drag handlers on DialogContent ...
}
```

### 1.7 Wire avatar button to dialog
Файл: `apps/web/app/components/user-profile/UserProfileShell.tsx`

В компоненте `UserProfileShell`:
- Добавь `useState<boolean>(false)` для `avatarOpen`
- Передай `onAvatarClick={mode === 'self' ? () => setAvatarOpen(true) : undefined}` в `<UserProfileHeader>`
- Рендери `<AvatarUploadDialog open={avatarOpen} onClose={() => setAvatarOpen(false)} currentAvatarUrl={user.avatarOverride ?? user.avatar} />`

### 1.8 Header avatar display logic
Файл: `apps/web/app/components/user-profile/UserProfileHeader.tsx`

В `<AvatarImage>` использовать `user.avatarOverride ?? user.avatar`:
```tsx
{(user.avatarOverride ?? user.avatar) && (
  <AvatarImage src={user.avatarOverride ?? user.avatar} alt={user.displayName} />
)}
```

### 1.9 AuthContext avatar (если есть)
В `apps/web/app/context/auth.tsx` или wherever SessionUser используется в Header страницы CRM — там тоже отображается avatar в шапке (dropdown). Если этот avatar приходит из `/users/me`, то после mutation cache invalidate должен обновить. `useUpdateMe` уже должен инвалидировать `['user-me']` и `['user', userId]` queries — проверь в hook'е.

### 1.10 Тесты для avatar
Не обязательны для этой итерации (юзер сказал deferred E2E). Smoke-проверка локально:
1. Залогинься admin (yaremenkomaksym99@gmail.com через POST /api/auth/dev-login).
2. Открой `/crm/profile`, кликни аватар → modal открывается.
3. Загрузи изображение из файловой системы → preview → "Сохранить".
4. Аватар на странице обновился.
5. Refresh страницы → аватар сохранился.
6. "Очистить" → возвращается Google-аватар.

---

## ФИЧА 2 — Tech autocomplete component

### 2.1 Technologies dictionary
Создай файл `packages/shared/src/data/technologies.ts`:

```ts
/**
 * Curated tech/skill dictionary used by TechAutocompleteInput.
 * ~500 entries covering programming languages, frameworks, databases, cloud, tools,
 * recruiting/HR soft-skills, accounting skills.
 */
export const TECHNOLOGIES: readonly string[] = [
  // Languages
  'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin', 'Swift',
  'C', 'C++', 'C#', 'Ruby', 'PHP', 'Scala', 'Elixir', 'Erlang', 'Haskell',
  'Clojure', 'F#', 'OCaml', 'Dart', 'Lua', 'Perl', 'R', 'Julia', 'MATLAB',
  'Solidity', 'Vyper', 'Move', 'Cairo', 'Zig', 'V', 'Nim', 'Crystal',
  'Bash', 'Shell', 'PowerShell', 'GraphQL', 'SQL', 'PL/SQL', 'T-SQL', 'HCL',
  'Assembly', 'COBOL', 'Fortran', 'Pascal', 'Delphi', 'VB.NET', 'ABAP',

  // Frontend frameworks / libs
  'React', 'Vue', 'Angular', 'Svelte', 'Solid.js', 'Preact', 'Lit', 'Alpine.js',
  'Next.js', 'Nuxt', 'Remix', 'Astro', 'Gatsby', 'SvelteKit', 'Qwik', 'Fresh',
  'Redux', 'Zustand', 'MobX', 'Recoil', 'Jotai', 'XState', 'Effector',
  'TanStack Query', 'TanStack Router', 'TanStack Table', 'TanStack Form',
  'React Router', 'React Hook Form', 'Formik', 'React Native', 'Expo',
  'Tailwind CSS', 'CSS Modules', 'Styled Components', 'Emotion', 'Stitches',
  'shadcn/ui', 'Radix UI', 'Headless UI', 'Material UI', 'Chakra UI', 'Mantine',
  'Ant Design', 'Bootstrap', 'Bulma', 'PrimeNG', 'PrimeReact',
  'Framer Motion', 'GSAP', 'Lottie', 'Three.js', 'D3.js', 'Recharts', 'Chart.js',
  'Storybook', 'Vite', 'Webpack', 'Rollup', 'Parcel', 'esbuild', 'SWC', 'Turbopack',
  'Babel', 'PostCSS', 'Sass', 'LESS', 'Stylus', 'Tailwind v4',

  // Backend frameworks
  'NestJS', 'Express', 'Fastify', 'Koa', 'Hapi', 'Hono', 'Elysia',
  'Django', 'FastAPI', 'Flask', 'Tornado', 'Sanic', 'Starlette',
  'Spring Boot', 'Quarkus', 'Micronaut', 'Vert.x', 'Play Framework',
  'Ruby on Rails', 'Sinatra', 'Hanami', 'Laravel', 'Symfony', 'CodeIgniter',
  'ASP.NET Core', '.NET 8', 'Blazor', 'Phoenix', 'Gin', 'Echo', 'Fiber', 'Chi',
  'Actix', 'Axum', 'Rocket', 'Tower', 'gRPC', 'tRPC', 'GraphQL Yoga', 'Apollo Server',

  // Mobile
  'iOS', 'Android', 'SwiftUI', 'UIKit', 'Jetpack Compose', 'Flutter',
  'React Native', 'Ionic', 'Capacitor', 'NativeScript', 'KMP', 'Xamarin',

  // Databases
  'PostgreSQL', 'MySQL', 'MariaDB', 'SQLite', 'Oracle DB', 'SQL Server',
  'MongoDB', 'Redis', 'DragonflyDB', 'Memcached', 'ScyllaDB', 'Cassandra',
  'DynamoDB', 'Firestore', 'CosmosDB', 'Neo4j', 'ArangoDB', 'OrientDB',
  'Elasticsearch', 'OpenSearch', 'Algolia', 'Meilisearch', 'Typesense',
  'ClickHouse', 'BigQuery', 'Snowflake', 'Redshift', 'Databricks',
  'DuckDB', 'Supabase', 'Firebase', 'PlanetScale', 'Neon', 'CockroachDB',
  'TimescaleDB', 'InfluxDB', 'QuestDB', 'RisingWave', 'Materialize',
  'Pinecone', 'Weaviate', 'Qdrant', 'Milvus', 'Chroma', 'pgvector',

  // ORM
  'Drizzle ORM', 'Prisma', 'TypeORM', 'Sequelize', 'Knex', 'Kysely', 'MikroORM',
  'Hibernate', 'jOOQ', 'Doctrine', 'SQLAlchemy', 'Tortoise ORM', 'Diesel', 'sqlx',

  // Cloud / IaaS / PaaS
  'AWS', 'GCP', 'Azure', 'DigitalOcean', 'Linode', 'Hetzner', 'Vultr',
  'Cloudflare', 'Vercel', 'Netlify', 'Heroku', 'Render', 'Fly.io', 'Railway',
  'Deno Deploy', 'AWS Lambda', 'Google Cloud Functions', 'Cloudflare Workers',
  'AWS EC2', 'AWS S3', 'AWS RDS', 'AWS DynamoDB', 'AWS Cognito', 'AWS SQS',
  'AWS SNS', 'AWS EventBridge', 'AWS Step Functions', 'AWS API Gateway',
  'Cloud Run', 'GCP App Engine', 'GCS', 'Pub/Sub', 'Vercel KV', 'Vercel Postgres',

  // DevOps / IaC
  'Docker', 'Kubernetes', 'Helm', 'Kustomize', 'ArgoCD', 'Flux',
  'Terraform', 'Pulumi', 'Ansible', 'Chef', 'Puppet', 'SaltStack',
  'Jenkins', 'GitHub Actions', 'GitLab CI', 'CircleCI', 'TravisCI', 'Buildkite',
  'Drone', 'TeamCity', 'Bamboo', 'Azure DevOps', 'AWS CodeBuild',
  'Nginx', 'Caddy', 'Traefik', 'Apache', 'HAProxy', 'Envoy', 'Istio', 'Linkerd',
  'Prometheus', 'Grafana', 'Loki', 'Tempo', 'Jaeger', 'OpenTelemetry',
  'Datadog', 'New Relic', 'Sentry', 'PagerDuty', 'Honeycomb', 'CloudWatch',

  // Auth
  'OAuth 2.0', 'OpenID Connect', 'SAML', 'JWT', 'Passport.js',
  'Auth0', 'Clerk', 'WorkOS', 'Stytch', 'Keycloak', 'Supabase Auth',
  'Firebase Auth', 'AWS Cognito', 'Okta', 'Ory', 'Lucia',

  // Testing
  'Jest', 'Vitest', 'Mocha', 'Chai', 'AVA', 'Tap', 'Bun:test',
  'Playwright', 'Cypress', 'Selenium', 'Puppeteer', 'WebdriverIO',
  'Testing Library', 'Enzyme', 'React Testing Library',
  'Pytest', 'unittest', 'JUnit', 'TestNG', 'RSpec', 'Capybara', 'Cucumber',
  'k6', 'JMeter', 'Locust', 'Artillery', 'Gatling', 'Insomnia', 'Postman',

  // AI / ML
  'PyTorch', 'TensorFlow', 'JAX', 'Keras', 'Scikit-learn', 'XGBoost', 'LightGBM',
  'Hugging Face Transformers', 'LangChain', 'LlamaIndex', 'Haystack',
  'OpenAI API', 'Anthropic Claude API', 'Cohere', 'Mistral AI', 'Groq',
  'Ollama', 'vLLM', 'TGI', 'Triton Inference', 'Ray', 'Modal', 'BentoML',
  'MLflow', 'Weights & Biases', 'DVC', 'Kubeflow', 'Vertex AI', 'SageMaker',
  'Numpy', 'Pandas', 'Polars', 'Dask', 'Spark', 'Airflow', 'Prefect', 'Dagster',
  'Kafka', 'Pulsar', 'NATS', 'RabbitMQ', 'Redpanda',

  // Blockchain / Web3
  'Ethereum', 'Solana', 'Polygon', 'Arbitrum', 'Optimism', 'Base', 'zkSync',
  'StarkNet', 'Avalanche', 'Cosmos', 'NEAR', 'Sui', 'Aptos',
  'Hardhat', 'Foundry', 'Truffle', 'ethers.js', 'viem', 'wagmi', 'web3.js',
  'OpenZeppelin', 'Chainlink', 'The Graph', 'IPFS', 'Filecoin', 'Arweave',
  'MetaMask', 'WalletConnect', 'RainbowKit', 'ConnectKit',

  // Game / Graphics
  'Unity', 'Unreal Engine', 'Godot', 'Cocos2d', 'Phaser', 'PixiJS', 'Babylon.js',
  'OpenGL', 'WebGL', 'WebGPU', 'Vulkan', 'DirectX', 'Metal',

  // Design / Product
  'Figma', 'Sketch', 'Adobe XD', 'Photoshop', 'Illustrator', 'After Effects',
  'Adobe Premiere', 'DaVinci Resolve', 'Blender', 'Maya', 'Cinema 4D',
  'Notion', 'Linear', 'Jira', 'Confluence', 'Asana', 'Trello', 'Monday.com',
  'Slack', 'Discord', 'Microsoft Teams', 'Zoom', 'Google Meet',

  // Collaboration / Version Control
  'Git', 'GitHub', 'GitLab', 'Bitbucket', 'Mercurial', 'SVN',

  // Recruiting / HR (added for HR role)
  'Рекрутинг', 'Human Resources', 'Account Support', 'Sourcing', 'Tech-recruiting',
  'Headhunting', 'Talent Acquisition', 'ATS', 'Workable', 'Greenhouse', 'Lever',
  'LinkedIn Recruiter', 'Boolean Search', 'X-ray Search',
  'Employer Branding', 'Onboarding', 'Performance Review', 'OKRs', 'KPIs',
  'Compensation & Benefits', 'Employee Engagement', 'HR Analytics', 'HRIS',

  // Accounting / Finance (added for ACCOUNTANT role)
  'Бухгалтерія', '1С', 'ФОП', 'M.E.Doc', 'Liga:Закон', 'BAS', 'Парус',
  'QuickBooks', 'Xero', 'Sage', 'FreshBooks', 'Wave',
  'IFRS', 'GAAP', 'Tax Reporting', 'VAT', 'Payroll', 'Audit',
  'Financial Modeling', 'Budgeting', 'Forecasting', 'Cash Flow', 'AP/AR',

  // Methodologies / Concepts
  'Agile', 'Scrum', 'Kanban', 'Waterfall', 'DevOps', 'SRE', 'TDD', 'BDD',
  'DDD', 'CQRS', 'Event Sourcing', 'Microservices', 'Monolith', 'SOA',
  'REST', 'GraphQL', 'gRPC', 'WebSocket', 'SSE', 'Server-Sent Events',
  'Hexagonal Architecture', 'Clean Architecture', 'SOLID', 'OOP', 'FP',
] as const

export type Technology = (typeof TECHNOLOGIES)[number]
```

Экспортируй из `packages/shared/src/index.ts`:
```ts
export * from './data/technologies'
```

### 2.2 TechAutocompleteInput component
Создай файл `apps/web/app/components/ui/tech-autocomplete-input.tsx`.

API:
```ts
export interface TechAutocompleteInputProps {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  /** Custom dictionary override — defaults to shared TECHNOLOGIES */
  options?: readonly string[]
  maxItems?: number  // default 30
}
```

Поведение:
- Текущие теги отображаются как chip'ы (Badge с X-кнопкой удаления). Reuse from current ProfileEditFields.
- Input под chip'ами. При вводе:
  - Debounce 150ms
  - Фильтр: сначала `startsWith` case-insensitive, потом `includes` — максимум 5 предложений
  - Исключить те что уже в `value`
- Если input не пустой и есть предложения — показать popover-dropdown под input
- Keyboard:
  - **Tab** или **Enter** — добавить первое предложение (если есть), иначе добавить input как новый тег
  - **Arrow Down/Up** — навигация по предложениям (highlight)
  - **Enter** на highlighted suggestion — добавить его
  - **Escape** — закрыть dropdown
- Click на suggestion — добавить
- Если введён точный текст (`raw === item case-insensitive`) — добавить как есть
- Лимит maxItems — не добавлять больше

Псевдокод (упрощённый):
```tsx
import { useState, useRef, useDeferredValue, useMemo } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { TECHNOLOGIES } from '@crm/shared'
import { cn } from '@/lib/utils'

export function TechAutocompleteInput({ value, onChange, placeholder, options = TECHNOLOGIES, maxItems = 30 }: TechAutocompleteInputProps) {
  const [input, setInput] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const deferred = useDeferredValue(input)

  const suggestions = useMemo(() => {
    const q = deferred.trim().toLowerCase()
    if (!q) return []
    const already = new Set(value.map((v) => v.toLowerCase()))
    const starts: string[] = []
    const includes: string[] = []
    for (const tech of options) {
      const lc = tech.toLowerCase()
      if (already.has(lc)) continue
      if (lc.startsWith(q)) starts.push(tech)
      else if (lc.includes(q)) includes.push(tech)
      if (starts.length >= 5) break
    }
    return [...starts, ...includes].slice(0, 5)
  }, [deferred, options, value])

  function add(tag: string) {
    const t = tag.trim()
    if (!t || value.length >= maxItems) return
    if (value.some((v) => v.toLowerCase() === t.toLowerCase())) return
    onChange([...value, t])
    setInput('')
    setActiveIdx(0)
  }

  function remove(t: string) {
    onChange(value.filter((x) => x !== t))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Tab' && suggestions[0]) { e.preventDefault(); add(suggestions[0]); return }
    if (e.key === 'Enter') { e.preventDefault(); add(suggestions[activeIdx] ?? input); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Escape')    { setInput(''); setActiveIdx(0) }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((t) => (
            <Badge key={t} variant="outline" className="gap-1">
              {t}
              <button type="button" onClick={() => remove(t)} className="hover:text-destructive" aria-label={`Удалить ${t}`}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="relative">
        <Input
          value={input}
          onChange={(e) => { setInput(e.target.value); setActiveIdx(0) }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Начните вводить технологию...'}
        />
        {suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover shadow-md">
            {suggestions.map((s, i) => (
              <button
                key={s}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); add(s) }}
                onMouseEnter={() => setActiveIdx(i)}
                className={cn(
                  'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm',
                  i === activeIdx ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
              >
                <span>{s}</span>
                {i === activeIdx && <span className="text-[10px] text-muted-foreground">Tab/Enter</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

### 2.3 Apply в ProfileEditFields
Файл: `apps/web/app/components/user-profile/self-edit/ProfileEditFields.tsx`

Замени блок с chip-input технологий (после email/phone сетки) на `<TechAutocompleteInput value={techStack} onChange={(next) => { setTechStack(next); scheduleSave({ techStack: next }) }} />`.

Удали `addTech`, `removeTech`, `techInput` state и chip-render — всё это теперь в TechAutocompleteInput.

### 2.4 Apply в другие места
Найди другие места которые редактируют tech_stack — поищи `techStack` и chip patterns:
```bash
git grep -nE "techStack|tech_stack" -- apps/web/app
```

Кандидаты:
- `apps/web/app/routes/crm/users/$userId.tsx` — диалог создания юзера (есть chip input)
- `apps/web/app/routes/crm/users/index.tsx` — может быть фильтр

Если нашёл chip-input для technologies — замени на TechAutocompleteInput. Если просто display (chips render) — не трогай.

### 2.5 Smoke
1. Залогинься admin, открой `/crm/profile`, перейди в OverviewTab → "Личные данные".
2. Начни печатать "Re" в поле "Добавить технологию".
3. Видишь dropdown: React, Redux, Redis, Recoil, RxJS (или похожее).
4. Tab → React добавляется.
5. Enter — добавляет highlighted suggestion.
6. ArrowDown/Up — навигация.
7. Сохраняется (debounce 800ms) → toast.

---

## ОБЩИЙ ACCEPTANCE

После завершения обеих фич:
- `pnpm exec turbo typecheck --force` — 4/4 packages успешно
- `pnpm exec turbo lint --force` — 0 warnings
- API на 3001, web на 3000 запущены и не падают
- Avatar upload работает (file + URL + drag&drop + clear)
- Tech autocomplete работает в ProfileEditFields + во всех других местах редактирования techStack
- Migration 0008 в `apps/api/drizzle/migrations/` и применена локально
- Commit-сообщения отдельные для двух фич:
  - `feat(profile): avatar override with upload/URL modal + drag&drop`
  - `feat(profile): tech autocomplete with ~500 curated technologies`

Push в `claude/youthful-hermann-8df1d5` → PR #28 автоматически обновится.

В конце оставь короткий отчёт в чат: список коммитов, что покрыто, что НЕ покрыто, есть ли blockers.
