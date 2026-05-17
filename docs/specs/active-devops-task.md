# E2E Alert — Автозапуск фікс-пайплайну при падінні тестів

## Проблема

E2E тести впали на main (issue #12, run `25999866477`), але **жоден фікс-пайплайн не запустився автоматично**.

`ci.yml` правильно відкрив issue з label `e2e-broken` — але на цьому автоматизація зупинилась.
Немає жодного workflow з тригером `on: issues` або аналогом, що реагував би на цей issue.

## Завдання

Розробити та реалізувати механізм автоматичного старту фікс-пайплайну при появі `e2e-broken` issue.

### Що треба зробити

1. **Розібратись чому пайплайн не запустився** — задокументувати root cause.

2. **Реалізувати надійний тригер** — коли `e2e-broken` issue відкривається, автоматично запускати агента на виправлення E2E. Врахувати обмеження з CLAUDE-devops.md:
   - `on: issues` може не працювати з `claude-code-action@beta`
   - Надійний тригер — `workflow_dispatch`
   - Можливий підхід: окремий workflow з `on: issues: types: [opened]` який не запускає Claude напряму, а тільки тригерить `workflow_dispatch` для autotest.yml або нового e2e-fix.yml

3. **Або** — якщо `on: issues` не підходить: додати в `notify_e2e` job виклик `gh workflow run autotest.yml` відразу після відкриття issue. Це простіше і надійніше.

### Конкретні варіанти (вибери і реалізуй кращий)

**Варіант A (рекомендований)** — модифікувати `ci.yml` `notify_e2e` job:
```yaml
# після відкриття issue — одразу тригерити autotest або e2e-fix агента
gh workflow run autotest.yml \
  --field module="" \
  --repo "$REPO"
```

**Варіант B** — новий workflow `e2e-fix.yml` з `on: issues: types: [labeled]` + label `e2e-broken`, який запускає Claude-агента для аналізу та виправлення тестів.

**Варіант C** — `on: workflow_run: workflows: [CI]: types: [completed]` з умовою `conclusion == failure` — тригер на завершення CI з failure.

### Обмеження

- Дивись `CLAUDE-devops.md` — `workflow_dispatch` inputs тільки `string/boolean/choice/environment`
- `allowed_bots: '*'` потрібен щоб бот-PR'и тригерили review
- Перевір що новий workflow не зациклюється (ci → fix → ci → ...)

## Файли для зміни

- `.github/workflows/ci.yml` — `notify_e2e` job (варіант A)
- `.github/workflows/e2e-fix.yml` — новий (варіант B)

## Acceptance criteria

- [ ] Після появи `e2e-broken` issue — фікс-пайплайн запускається автоматично без ручного втручання
- [ ] Немає циклічних запусків (e2e fix → new CI run → new fix → ...)
- [ ] Документований root cause у commit message або PR description
- [ ] `ci.yml` і нові workflows проходять `act --dry-run` або успішно реєструються в GitHub

## Контекст поточного падіння

- **Run:** https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/actions/runs/25999866477
- **45 тестів** впало у 6 файлах: `team.spec.ts`, `interviews.spec.ts`, `navigation.spec.ts`, `projects.spec.ts`, `users.spec.ts`, `finance.spec.ts`, `finance-senior-flow.spec.ts`
- AutoTest агент вже запущений окремо для виправлення тестів (через `autotest.yml`)

## Після реалізації

1. Створити PR з label `ai-review-ready`
2. Описати в PR body обраний варіант та чому
