# Скриншоты этого аудита — где они физически лежат

Playwright MCP в этой сессии был жёстко привязан к allowed-roots другого чекаута
(`.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/.playwright-mcp/`), а не к
worktree, выданному этому диспатчу (`agent-a2671bf461d172802`). Bash-операции у
меня корректно шли в СВОЙ worktree (подтверждено `git rev-parse --show-toplevel`
в начале сессии) — расхождение именно в конфигурации Playwright MCP tool, не в
моей навигации. `agent-isolation.md` запрещает мутировать чужое дерево
(`pre:bash:cross-agent-blast`, предикат `FOREIGN-WORKTREE`), поэтому скопировать
файлы сюда через Bash я не смог — команда была заблокирована хуком, как и
задумано правилом.

Файлы физически лежат здесь (относительно корня репозитория, чужой чекаут):

```
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-1440.png            — до фикса, десктоп, залезает на кнопки
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-1024.png            — до фикса, обрезано за кнопками
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-768.png             — до фикса, обрезано краем viewport
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-375.png             — до фикса, обрезано краем viewport
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-320-after.png       — после фикса, читаемо
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-768-after.png       — после фикса
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-1024-after.png      — после фикса
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-1440-after.png      — после фикса
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/create-user-dialog-1440.png        — форма создания, состояние по умолчанию
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/create-user-dialog-personal-email-error3.png — ошибка валидации "должен отличаться от рабочего"
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/create-user-dialog-320.png         — форма на мобильном
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-empty-personal-email.png — состояние "личного адреса нет"
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/profile-header-accountant-view.png — RBAC: ACCOUNTANT не видит personalEmail (та же картинка, что и "нет адреса")
```

PM/владелец видит оба worktree и может перенести нужные файлы в этот каталог
(`docs/design/assets/user-dual-email/design.png` и т.д.) одной командой `cp` из
основной сессии — там ограничения `cross-agent-blast` на диспетчера не действуют
(это не изолированный агент, а оркестратор/владелец).

## Раунд 2 (`CR-H-4`, worktree `agent-adaf986e595b8b208`)

Та же инфраструктурная привязка Playwright MCP к чужому worktree повторилась
(другой запуск — другой чужой чекаут, `.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/`,
живой на момент этого раунда, не трогал по `agent-isolation.md`). Файлы этого
раунда:

```
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/badge-longmail-1440.png            — бейдж+перенос, до фикса, ок на 1440
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/badge-longmail-320.png             — бейдж застрял в середине адреса (140-симв. кейс), UX-H-2 до фикса
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/badge-realmail-320.png             — то же, реалистичный 44-симв. адрес — нагляднее
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/badge-realmail-320-itemsstart-proto2.png — прототип фикса (items-start) через DOM-патч, до правки исходника
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/badge-realmail-1440-itemsstart-proto.png — прототип, 1440, без регрессии на однострочном контенте
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/after-fix-badge-320.png            — реальный фикс из исходника, 320
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/after-fix-badge-768.png            — реальный фикс, 768
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/after-fix-badge-1024-extreme.png   — реальный фикс, 1024, экстремальный 140-симв. адрес
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/actions-menu-1440.png              — меню «Действия» с тремя новыми пунктами
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/change-personal-email-dialog-default-1440.png — диалог, дефолтное состояние
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-error-samework-1440.png     — ошибка валидации, ДО фикса UX-H-3 (серая рамка)
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-error-after-fix-1440.png    — ошибка, ПОСЛЕ фикса UX-H-3 (красная рамка+лейбл) + красная кнопка (UX-M-2)
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-removal-state-1440.png      — состояние удаления, ДО фикса кнопки (золотая)
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-removal-after-fix-1440.png  — состояние удаления, ПОСЛЕ фикса (красная кнопка)
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-removal-320.png             — 320, без overflow
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-error-320-c-after-submit.png — 320, ошибка через submit, без overflow
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-768.png                     — 768, фикс виден
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/menu-no-personal-email-1440.png    — меню для пользователя без личного email (resend скрыт, change показан)
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/dialog-empty-state-1440.png        — диалог при первом добавлении — описание звучит не по месту (см. UX-H-4)
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/login-invited-1440-b.png           — баннер приглашения, 1440
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/login-invited-320.png              — баннер приглашения, 320
.claude/worktrees/paid-transaction-edit-cascade-d0b6d1/login-error-mismatch-320.png       — самый длинный error-текст, 320, без overflow
```
