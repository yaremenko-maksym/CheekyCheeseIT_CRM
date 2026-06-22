---
name: codebase-audit
description: Read-only breadth-first аудит ≥3 независимых модулей репозитория через параллельный fan-out (N × haiku explore → opus synthesis → adversarial-проверка). Use when the orchestrator needs a wide sweep that exceeds one context window.
when_to_use: "Use when Master/PM запускает breadth-first read-only аудит ≥3 независимых модулей, материал превышает одно контекст-окно, БЕЗ записи кода (Решение 2 из orchestration-routing). Examples: 'RBAC-sweep всех контроллеров', 'найди dead-code по всему репо', 'security-поверхность по всем модулям', 'как устроено X по всему коду', 'аудит зависимостей/секретов', 'инвентаризация перед рефактором'."
---

# Codebase Audit — read-only breadth-first fan-out

**Когда:** только когда `orchestration-routing.md` **Решение 2** совпало — ≥3 независимых
модуля/контроллера, материал > одного контекст-окна, **read-only** (агенты ничего не пишут в код).
Это ЕДИНСТВЕННЫЙ кейс, где параллельный fan-out несёт новую ценность поверх интерактивного PM.

**Когда НЕ запускать (→ обычный single-agent pipeline):**

- < 3 модулей, или участки пересекаются → один агент дешевле и без context-thrash.
- Нужна ЗАПИСЬ кода (фикс/рефактор) → это `feature-implementation` PM-pipeline, не аудит.
- Вопрос влезает в один контекст («как работает этот один сервис») → прочитай напрямую через `codegraph`/Read.

## Форма (fan-out → synth → verify)

```
RECON (1 дешёвый проход)  → собрать карту: список модулей/файлов, разбить на N disjoint срезов
   │
FAN-OUT (волнами ≤ 3-4)   → N × explore-агент (model=haiku), каждый ВЛАДЕЕТ своим срезом,
   │                          возвращает СТРУКТУРНЫЙ результат (не прозу) по фиксированной схеме
SYNTH (1 агент, opus)     → собрать все срезы в один отчёт с приоритизацией (H/M/L)
   │
VERIFY (опц., свежий)     → adversarial-проверка топ-находок (refute-prompt), отсев false-positive
```

Движок — **Workflow tool** (`parallel`/`pipeline` со `schema`-выходом) ИЛИ
`superpowers:dispatching-parallel-agents`. Workflow-скрипт предпочтительнее, когда срезов много
и нужен детерминированный сбор; dispatching-parallel-agents — для ad-hoc 3-5 агентов.

## Правила (что делает этот аудит надёжным)

1. **Каждый воркер ВЛАДЕЕТ непересекающимся срезом** (явный список файлов/путей в промпте) — иначе
   агенты дублируют работу и возвращают перекрытия. Disjoint = дешевле и полнее.
2. **Структурный schema-выход, не проза.** Воркер возвращает типизированный объект (например
   `{ slice, findings: [{ issue, evidence: "file:line", severity }], coverage }`). Synth ветвится
   по машинным полям, не парсит нарратив.
3. **Воркеры — `model=haiku`** (read-only разведка, `model-routing.md` даунгрейд). Synth — `opus`
   (judgment-heavy приоритизация). Никаких записей: read-only гейт обязателен.
4. **Волны ≤ 3-4 одновременных** (`light-track.md` «Потолок concurrency»): 5+ стартов одним
   сообщением → 529/CPU-starvation. Диспатчить волнами, стаггерить. После завершившихся волн —
   sweep zombie dev-портов, если воркеры что-то поднимали (для read-only обычно не нужно).
5. **Adversarial verify топ-находок** свежим агентом (scope = «попробуй опровергнуть»), чтобы
   plausible-but-wrong находки не дожили до отчёта. Прецедент — обе фазы этого аудита и
   `review-branch`-логика.
6. **Evidence обязателен:** каждая находка несёт `file:line` или цитату. «Кажется, есть проблема»
   без пруфа → отсев на synth.

## Анти-паттерны

- **Fan-out на 1-2 модуля / пересекающиеся участки** — over-spawn (~15× токенов), один агент лучше.
- **Запись кода во время аудита** — аудит read-only; фиксы идут отдельной задачей в PM-pipeline.
- **Проза вместо схемы** — synth не сможет детерминированно агрегировать; «разойдётся».
- **Один гигантский воркер на весь репо** — теряется смысл fan-out; либо влезает в контекст (тогда
  не нужен fan-out), либо нет (тогда нужны disjoint срезы).
- **Открытый цикл без cap** — фиксируй число волн/воркеров заранее (effort-scaling: обзор = 2-4,
  глубокий аудит = больше волнами); не «спавнить пока не надоест».

## Трекинг

Запуск аудита → `routing_decision` event в `pm-state.json` (`track: "audit-fanout"`, `reason`) —
как в `orchestration-routing.md`. Это делает запуск аудируемым в едином event-stream.

## Связанные

- `.claude/rules/common/orchestration-routing.md` — Решение 2 (когда вообще запускать audit-fanout).
- `.claude/rules/common/model-routing.md` — haiku для read-only разведки, opus для synth.
- `.claude/rules/common/light-track.md` — потолок concurrency (волны ≤ 3-4) + zombie-port sweep.
- `superpowers:dispatching-parallel-agents` — альтернативный движок для ad-hoc 3-5 воркеров.
