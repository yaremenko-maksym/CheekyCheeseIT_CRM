# Auto-merge on PR approval

## Контекст

Сейчас после того как AI Review и AutoTest одобряют PR — мерж всё равно нужно делать вручную.
Нужно автоматизировать: одобрение → все чеки прошли → PR мерджится сам.

---

## Задача

Создать workflow `.github/workflows/auto-merge.yml`, который:
1. Срабатывает когда на PR выставляется review с состоянием `APPROVED`
2. Включает auto-merge на этом PR через `gh pr merge --auto --squash`
3. GitHub сам мерджит PR когда все required status checks пройдут

### Что нужно изменить

- [ ] Создать `.github/workflows/auto-merge.yml`

### Логика workflow

```yaml
name: Auto Merge on Approval

on:
  pull_request_review:
    types: [submitted]

jobs:
  auto-merge:
    name: Enable auto-merge
    runs-on: ubuntu-latest
    # Только если review = APPROVED и PR не черновик
    if: |
      github.event.review.state == 'approved' &&
      github.event.pull_request.draft == false
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: Enable auto-merge
        run: gh pr merge ${{ github.event.pull_request.number }} --auto --squash --repo ${{ github.repository }}
        env:
          GH_TOKEN: ${{ github.token }}
```

### Acceptance Criteria

- [ ] После APPROVE review на PR — auto-merge включается автоматически
- [ ] PR мерджится сам когда все required status checks проходят
- [ ] Черновики (draft PR) не трогаются
- [ ] Workflow не падает если auto-merge уже включён (gh pr merge --auto идемпотентен)

---

## Файлы для изменения

```
.github/workflows/auto-merge.yml   ← создать
```

## Важное замечание

`gh pr merge --auto` ставит PR в очередь авто-мержа. GitHub сам дождётся когда
все required checks (CI, AI Review, AutoTest) пройдут и только тогда смержит.
Если какой-то чек упадёт — авто-мерж не произойдёт, PR останется открытым.
