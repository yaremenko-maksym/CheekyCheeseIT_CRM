# landing-redesign — дизайн-артефакт (Claude Design)

**Статус:** экспортирован 2026-07-23, правки владельца применены (без фильтров на Careers;
единый имейл `hr@cheekycheese.tech`).
**Claude Design проект:** https://claude.ai/design/p/9c07d82e-ea1b-4b84-a8a1-94aa5210f051
**Дизайн-система:** `CheekyCheeseIT CRM` (synced; цвета/типографика — из наших токенов).
**Спека фичи:** `docs/superpowers/specs/2026-07-22-landing-refactor-design.md`

## Состав `assets/landing-redesign/`

| Файл | Что это |
| --- | --- |
| `Home.dc.html` | Главная `/` — все секции (hero+терминал, about, cases, services, how-we-work, stack, careers-тизер, footer) |
| `Careers.dc.html` | `/careers` — список вакансий БЕЗ фильтров, empty state через tweak `hasOpenRoles` |
| `Vacancy.dc.html` | `/careers/:slug` — деталка + форма отклика (default/submitting/success/error) |
| `Nav.dc.html` / `Footer.dc.html` / `Terminal.dc.html` / `VacancyCard.dc.html` | Компоненты (переиспользуются страницами) |
| `site.css` / `support.js` | Layout/responsive-слой экспорта (цвета/шрифты — из DS-токенов) |
| `_ds/**` | Бандл дизайн-системы (нужен для standalone-рендера .dc.html) |
| `screenshots/` | Кадры из генерации (desktop) |

## Правила для кодера (design-gate)

- **НЕ копировать сырой HTML** — это визуальный референс. Строить нашими компонентами
  `apps/landing` + токенами `apps/landing/app/styles/globals.css`.
- Полный coder-spec (token-map, разбор компонентов, a11y, responsive, edge-cases) —
  готовит ui-ux-designer **Mode E** поверх этого артефакта → дописывается в этот файл.
- Fidelity-референсы для Mode B: `screenshots/` + рендер `.dc.html` на тест-ширинах
  320/768/1024/1440 (файлы самодостаточны благодаря `_ds/`).

## Известные отклонения от live-дизайна

- Chat-сессия генерации оборвалась на лимите АККАУНТА владельца ПОСЛЕ применения правок
  (Careers/Footer/Home отредактированы; Vacancy-страница имейлов не содержит — проверить
  в Mode E, что нигде не осталось `careers@`/`contact@`-адресов, ожидаемый — только
  `hr@cheekycheese.tech`).
