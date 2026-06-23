# <Screen name> — <domain>

> Per-screen artifact (CRM redesign). Coder-ready spec на наших shadcn/ui + токенах. Headless-агенты
> опираются ТОЛЬКО на этот файл + `assets/` (браузер им недоступен). Шаблон: `docs/design/screens/_TEMPLATE.md`.
> Программа: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.

| Поле               | Значение                                             |
| ------------------ | ---------------------------------------------------- |
| Screen             | `<имя>`                                              |
| Route / trigger    | `<роут или как открыть модалку>`                     |
| Roles              | `<какие роли видят>`                                 |
| Claude Design URL  | `<ссылка на макет>`                                  |
| Status             | `captured` \| `approved` \| `implemented` \| `stale` |
| Last synced commit | `<short SHA main, на котором снят>`                  |

## Состояния

| Состояние  | Скриншот (эталон)             | Заметки                                  |
| ---------- | ----------------------------- | ---------------------------------------- |
| default    | `assets/<screen>/default.png` |                                          |
| empty      | `assets/<screen>/empty.png`   |                                          |
| loading    | `assets/<screen>/loading.png` | skeleton                                 |
| error      | `assets/<screen>/error.png`   |                                          |
| <доменное> | `assets/<screen>/<state>.png` | напр. drag / expanded / validation-error |

> Если состояние не удалось снять — явно укажи причину здесь, НЕ удаляй строку молча.

## Компоненты (маппинг на наш стек)

Из инвентаря `docs/design/assets/_design-system/inventory.md`:

| Визуальный блок | Наш компонент (shadcn/ui / композит) | Новый? |
| --------------- | ------------------------------------ | ------ |
| <блок>          | `<Button / Card / CrmDialog / ...>`  | нет    |

## Token-map

Только токены `apps/web/app/styles/globals.css` (без сырого hex / generic-градиентов).

## A11y / responsive / motion

- **A11y (WCAG 2.2):** target-size ≥ 24px, focus order + видимый focus, контраст 4.5:1/3:1, aria-label для icon-only, focus-trap для модалок.
- **Responsive:** 320 / 768 / 1024 / 1440.
- **Motion:** <описание анимаций/переходов — длительность, easing, что движется; кадры в assets, не playable>.

## Для кодера

Строй НАШИМИ компонентами по этому spec; `design.png` — fidelity-референс (Mode B сверит). НЕ копируй
сырой экспортированный HTML из `design.html` (это визуальный референс, не код для вставки).
