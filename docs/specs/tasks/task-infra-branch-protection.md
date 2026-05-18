# task-infra-branch-protection

## Агент: devops
## Приоритет: high
## Ветка: infra/branch-protection

## Контекст

Потрібно посилити branch protection для `main`. Зараз захист є, але:
- Немає required status checks — PR можна злити без проходження CI
- Немає required approving reviews — PR можна злити без апруву

Мета: жоден PR не може потрапити в `main` без того, щоб пройшли всі CI кроки і був хоча б один апрув від рев'юера.

## Конкретні зміни

Використовувати секрет `ADMIN_PAT` (Personal Access Token з `repo` + `administration` scopes) замість дефолтного `GITHUB_TOKEN`.

В workflow DevOps секрет доступний як `${{ secrets.ADMIN_PAT }}`. Налаштувати `gh` CLI:
```bash
export GH_TOKEN="${ADMIN_PAT}"
# або передати через --token при кожному виклику gh api
```

Оновити branch protection rule для `main` через GitHub API (`gh api`):

```bash
gh api \
  --method PUT \
  repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "Typecheck · Lint · Unit Tests" },
      { "context": "E2E Tests" },
      { "context": "AutoTest" },
      { "context": "Code Review" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF
```

Пояснення полів:
- `strict: true` — гілка має бути up-to-date з main перед merge
- `checks` — обов'язкові job-и з CI (`ci.yml`) і AI Review (`ai-review.yml`), назви беруться з поля `name:` у workflow
- `enforce_admins: true` — адміни теж підпадають під захист
- `dismiss_stale_reviews: true` — апрув скидається якщо в PR з'явились нові коміти
- `required_approving_review_count: 1` — мінімум 1 апрув
- `required_conversation_resolution: true` — всі коментарі мають бути resolved
- `required_linear_history: true` — тільки squash/rebase merge (вже включено)

Після виконання — перевірити що захист застосований:
```bash
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/branches/main/protection \
  --jq '{
    required_checks: .required_status_checks.checks[].context,
    required_reviews: .required_pull_request_reviews.required_approving_review_count,
    enforce_admins: .enforce_admins.enabled
  }'
```

## Acceptance criteria

- [ ] `required_status_checks` містить усі 4 checks: `Typecheck · Lint · Unit Tests`, `E2E Tests`, `AutoTest`, `Code Review`
- [ ] `required_approving_review_count` = 1
- [ ] `enforce_admins.enabled` = true
- [ ] `dismiss_stale_reviews` = true
- [ ] `required_conversation_resolution` = true

## Запрещено трогать

- `apps/`, `packages/` — тільки інфраструктура
- `.github/workflows/` — тільки branch protection через API
