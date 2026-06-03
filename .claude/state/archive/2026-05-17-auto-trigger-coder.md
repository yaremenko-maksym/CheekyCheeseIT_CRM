# Auto-trigger Coder after REQUEST_CHANGES in AI Review pipeline

## Контекст

Зараз пайплайн AI Review зупиняється на REQUEST_CHANGES — Coder не запускається автоматично.
Це вимагає ручного запуску і написання active-task.md.

Мета: якщо Reviewer або AutoTest залишив REQUEST_CHANGES — автоматично запустити Coder
з поясненням що потрібно виправити.

## Задача

Додати Job 5 `trigger_coder` в `.github/workflows/ai-review.yml`.

### Логіка запуску

```
trigger_coder запускається якщо:
  (reviewer == REQUEST_CHANGES)
  АБО (autotest == REQUEST_CHANGES / failure)
```

Тобто будь-який REQUEST_CHANGES або failure в AutoTest → запускає Coder.

### Що робить Job `trigger_coder`

1. Читає review body з GitHub API (остання REQUEST_CHANGES review)
2. Формує `docs/specs/active-task.md` з findings від reviewer/autotest
3. Запускає `gh workflow run coder.yml --repo $GITHUB_REPOSITORY`

### Реалізація

**Job потребує:**

- `needs: [reviewer, autotest]`
- `if: always() && (needs.reviewer.outputs.approved != 'true' || needs.autotest.result == 'failure')`
- `permissions: contents: write, actions: write`

**Кроки:**

```yaml
steps:
  - uses: actions/checkout@v4

  - name: Get review body
    id: review
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      PR="${{ github.event.pull_request.number || inputs.pr_number }}"
      # Отримати останній REQUEST_CHANGES review
      REVIEW_BODY=$(gh api repos/${{ github.repository }}/pulls/$PR/reviews \
        --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | last | .body')
      echo "body<<EOF" >> $GITHUB_OUTPUT
      echo "$REVIEW_BODY" >> $GITHUB_OUTPUT
      echo "EOF" >> $GITHUB_OUTPUT

  - name: Write active-task.md
    run: |
      PR="${{ github.event.pull_request.number || inputs.pr_number }}"
      cat > docs/specs/active-task.md << 'TASK_EOF'
      # Fix PR #$PR — Reviewer REQUEST_CHANGES

      ## Гілка для виправлення
      Checkout і push в існуючу гілку PR #$PR (НЕ створювати нову).

      ## Findings від Reviewer
      ${{ steps.review.outputs.body }}

      ## Алгоритм
      1. git fetch && git checkout <PR branch>
      2. Виправити всі знайдені проблеми
      3. pnpm typecheck && pnpm lint
      4. git commit та git push в ту ж гілку
      5. НЕ створювати новий PR — коміт йде в існуючий PR #$PR
      TASK_EOF

  - name: Trigger Coder
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      gh workflow run coder.yml \
        --repo ${{ github.repository }} \
        -f task_hint="fix-pr-${{ github.event.pull_request.number || inputs.pr_number }}"
```

**Важливо:** `coder.yml` checkout потребує `token: ${{ secrets.GITHUB_TOKEN }}` щоб пушити в PR гілку.

### Outputs від reviewer job

Зараз `reviewer` виводить тільки `needs_qa` і `approved`.
Потрібно додати output `review_state`:

```yaml
- name: Check reviewer decision
  id: check_approved
  run: |
    if [ -f autotest-approved.flag ]; then
      echo "approved=true" >> $GITHUB_OUTPUT
      echo "review_state=APPROVED" >> $GITHUB_OUTPUT
    else
      echo "approved=false" >> $GITHUB_OUTPUT
      echo "review_state=CHANGES_REQUESTED" >> $GITHUB_OUTPUT
    fi
```

І додати в `outputs` секцію job:

```yaml
review_state: ${{ steps.check_approved.outputs.review_state }}
```

## Файли для зміни

- `.github/workflows/ai-review.yml` — додати Job 5 + output `review_state`

## Acceptance Criteria

- [ ] Після REQUEST_CHANGES від Reviewer — автоматично запускається Coder workflow
- [ ] Після REQUEST_CHANGES від AutoTest — автоматично запускається Coder workflow
- [ ] `active-task.md` формується з реальним body review
- [ ] Coder отримує PR номер і checkout правильної гілки
- [ ] Якщо Reviewer APPROVE і AutoTest success — `trigger_coder` НЕ запускається
