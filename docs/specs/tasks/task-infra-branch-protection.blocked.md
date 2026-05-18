# BLOCKER: task-infra-branch-protection
## Агент: devops
## Задача: docs/specs/tasks/task-infra-branch-protection.md

## Проблема
Файл с задачей docs/specs/tasks/task-infra-branch-protection.md не существует. DevOps агент не может выполнить задачу без четкого технического задания от PM/BA.

## Вопрос к PM / пользователю
1. Какие именно branch protection rules нужно настроить для main ветки?
2. Требуются ли изменения в существующих workflow файлах (.github/workflows/)?
3. Нужно ли изменить текущие настройки CI/CD pipeline?

## Текущий статус
- Репозиторий: yaremenko-maksym/CheekyCheeseIT_CRM
- Основная ветка: main
- Branch protection API недоступен через GitHub CLI (403)

## Рекомендации DevOps агента
Основываясь на docs/agents/CLAUDE-devops.md, рекомендую следующие branch protection rules:
1. Требовать PR для merge в main
2. НЕ устанавливать required status checks (см. документацию - workflow_dispatch runs не удовлетворяют branch protection)
3. НЕ требовать code review (AI Review pipeline заменяет human review)
4. Разрешить force push для owner (для bootstrap fixes)