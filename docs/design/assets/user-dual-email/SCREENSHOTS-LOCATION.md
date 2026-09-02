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
