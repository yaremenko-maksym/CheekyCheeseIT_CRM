# Workflow Registry — read-only audit/research fan-outs (on-demand)

Каталог **read-only audit/research воркфлоу** (Решение 2 из `rules/common/orchestration-routing.md`).
Движок — `Workflow` tool ИЛИ skill `codebase-audit` (N×haiku explore волнами ≤ 3-4 → opus synthesis → adversarial verify).

**PM не читает upfront** — сверяется с этим файлом, когда событие похоже на trigger ниже.

---

## 🔴 Дисциплина запуска (НЕ жечь токены)

Воркфлоу ≈ **15× токенов** обычного чата (Anthropic multi-agent research). Поэтому:

1. **Default-deny.** Запуск ТОЛЬКО при (а) явном trigger-match из таблицы ниже, подтверждённом machine-checkable якорем Решения 2 (≥ 3 независимых модуля, read-only, материал > одного контекст-окна), ИЛИ (б) явном запросе владельца («запусти воркфлоу X» / ultracode on). Никогда «на всякий случай».
2. **Middle-path ПЕРЕД fan-out.** Неоднозначная-но-ограниченная задача → сначала дешёвый тир (haiku разведка / sonnet работа, `model-routing.md`); полный fan-out — только при настоящем breadth.
3. **Опт-ин владельца на тяжёлый прогон.** ultracode off → PM предлагает воркфлоу + примерную стоимость, запускает после «да». ultracode on → запускает по trigger-match.
4. **Лог `routing_decision`** в `pm-state.json.events[]` (`{ at, type: "audit-fanout", track: "audit-fanout", workflow, reason }`) — только нестандартный трек (не light-track / single-pipeline).
5. **Это НЕ dev-pipeline.** Воркфлоу не реализуют фичи (это PM → Coder). Только read-only аудит/разведка → ledger, который PM триажит и роутит в light-track / pipeline.

---

## Каталог (10)

| #   | Воркфлоу                                | Когда запускать (trigger)                                                                            | Что делает (fan-out)                                                                                            |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | **RBAC / security-surface sweep**       | перед/после изменений RBAC; периодический аудит ролей; «может ли роль X дойти до Y»                  | по контроллеру на агента: `@Roles`/`@UseGuards` + тело сервиса; cross-check матрицы 5 ролей + DROP; adversarial обход |
| 2   | **Design-fidelity sweep**               | после реализации UI; перед merge UI                                                                  | pipeline `экран × {320,768,1024,1440}`: localhost ↔ `design.png` diff + severity (требует живого стека)         |
| 3   | **E2E flake-triage**                    | CI краснеет несколькими E2E разом                                                                    | classify по спеку (код/гонка/окружение/pre-existing) → кто чинит (AutoTest spec vs Coder code)                  |
| 4   | **«Как устроено X по репо»**            | перед крупным рефактором (pre-refactor understanding)                                                | N читателей по подсистемам → карта call-sites + blast-radius                                                    |
| 5   | **Money-precision / rounding audit**    | перед правкой сплит-математики; баланс разошёлся на минор-юниты; перед деплоем финансов              | каталог денежной арифметики (scaled-int vs float) + фикстуры-доказательства дрейфа                              |
| 6   | **Money-mutation safety matrix**        | перед новым денежным эндпоинтом/типом транзакции; «balance doubled / paid twice»; перед внешним аудитором | concurrency-гарды + аудит-трейл по всем точкам записи денег                                                |
| 7   | **Web↔API contract sweep**              | перед релизом; PR трогает сериализатор / shared-схему; «API возвращает X, UI показывает undefined»   | JOIN-матрица endpoint ↔ схема ↔ парс по контроллерам; мёртвые схемы / невалидированный вывод                    |
| 8   | **Language / locale-leak sweep**        | перед локализацией / i18n-вехой; после батча фич                                                     | RU/EN/UK reach-классификация (англ в Exception = баг). **После i18n → translation-coverage** (непокрытые ключи) |
| 9   | **Doc-vs-reality drift sweep**          | после вехи (route/dep/storage/phase change); месячная гигиена; онбординг агента                      | стейл-факты доков vs ground-truth кода (package.json / route-tree / deploy)                                     |
| 10  | **md-coherence + AI-infra reinforcement** | после большого изменения agent-инфры; месячная гигиена; lessons → rules                            | docs-vs-docs когерентность (дубли / мёртвые ссылки / противоречия) + петля «работа над ошибками» (lessons → правила) |

> Бэклог-статус и детали дизайна каждого — память владельца `project_candidate_workflows`.
> Trigger-карта эволюционирует: новый воркфлоу → строка сюда (+ если нужно — trigger в `pm.md`).

---

## Связанные правила

- `rules/common/orchestration-routing.md` — агент vs воркфлоу vs light-track (Решение 1/2 + default-deny).
- `rules/common/model-routing.md` — тир модели + middle-path эскалация.
- `.claude/skills/codebase-audit/SKILL.md` — механика audit-fanout.
