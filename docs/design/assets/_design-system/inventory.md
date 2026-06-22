# CRM design-surface inventory — для верификации Claude Design sync (T1 Step 6)

> Сгенерировано автоматически 2026-06-22. Источник: `apps/web`. Цель: эталон для coverage-check засинхроненной системы 'CheekyCheeseIT CRM'.

---

## Токены (globals.css)

Полная токен-система из `globals.css`. **Dark mode (`.dark`) — режим по умолчанию** (применяется через класс `.dark` на `<html>`); light mode живёт в `:root` без класса `.dark`. Бренд-жёлтый — основной акцент на `oklch` hue **85.3°** (light/dark parity по hue). Базис скругления `--radius = 0.625rem` (10px) с шагами −4px / −2px / 0 / +4px. Шрифт — Inter с system-fallback.

### Ключевые факты

| Свойство              | Значение                                                                               |
| --------------------- | -------------------------------------------------------------------------------------- |
| Бренд-жёлтый hue      | `85.3°` (oklch)                                                                        |
| `--primary` (dark)    | `oklch(0.84 0.183 85.3)`                                                               |
| `--primary` (light)   | `oklch(0.8 0.183 85.3)`                                                                |
| `--radius` (базис)    | `0.625rem` (10px)                                                                      |
| Шрифт (`--font-sans`) | `'Inter', system-ui, sans-serif`                                                       |
| Default mode          | `.dark` (через класс `.dark` на root-элементе)                                         |
| Light/dark parity     | Параллельные наборы токенов для `:root` (light) и `.dark` (dark); hue бренда совпадает |

### Цветовые токены — Primary / бренд

| Токен                  | Light (`:root`)         | Dark (`.dark`)           | Назначение                             |
| ---------------------- | ----------------------- | ------------------------ | -------------------------------------- |
| `--primary`            | `oklch(0.8 0.183 85.3)` | `oklch(0.84 0.183 85.3)` | **Бренд-жёлтый** — кнопки, бейджи, CTA |
| `--primary-foreground` | `oklch(0.09 0 0)`       | `oklch(0.08 0 0)`        | Near-black текст на бренд-жёлтом       |
| `--ring`               | `oklch(0.8 0.183 85.3)` | `oklch(0.84 0.183 85.3)` | Focus-ring (равен primary)             |

### Цветовые токены — жёлтые оттенки (3 shade)

| Токен             | Light (`:root`)         | Dark (`.dark`)           | Назначение                                 |
| ----------------- | ----------------------- | ------------------------ | ------------------------------------------ |
| `--yellow-muted`  | `oklch(0.75 0.14 85.3)` | `oklch(0.72 0.13 85.3)`  | Приглушённый жёлтый — hover-rings, glow    |
| `--yellow-subtle` | `oklch(0.93 0.018 85)`  | `oklch(0.22 0.04 85.3)`  | Очень слабый amber-tint для поверхностей   |
| `--avatar-text`   | `oklch(0.3 0.02 85)`    | `oklch(0.84 0.183 85.3)` | Текст аватаров (контраст на yellow-subtle) |

### Цветовые токены — фоны

| Токен          | Light (`:root`)        | Dark (`.dark`)         | Назначение                                    |
| -------------- | ---------------------- | ---------------------- | --------------------------------------------- |
| `--background` | `oklch(0.98 0 0)`      | `oklch(0.08 0 0)`      | Канвас/фон страницы (глубочайший в dark)      |
| `--card`       | `oklch(1 0 0)`         | `oklch(0.12 0 0)`      | Поднятая поверхность карточки                 |
| `--popover`    | `oklch(1 0 0)`         | (наследует card-семью) | Фон поповеров                                 |
| `--surface`    | `oklch(0.95 0.008 85)` | `oklch(0.16 0.006 85)` | Sidebar active, popovers — faint amber warmth |

### Цветовые токены — текст (foreground)

| Токен                  | Light (`:root`)   | Dark (`.dark`)    | Назначение                       |
| ---------------------- | ----------------- | ----------------- | -------------------------------- |
| `--foreground`         | `oklch(0.12 0 0)` | `oklch(0.97 0 0)` | Основной текст                   |
| `--card-foreground`    | `oklch(0.12 0 0)` | `oklch(0.97 0 0)` | Текст на карточках               |
| `--popover-foreground` | `oklch(0.12 0 0)` | `oklch(0.97 0 0)` | Текст на поповерах               |
| `--surface-foreground` | `oklch(0.12 0 0)` | —                 | Текст на surfaces (light)        |
| `--muted-foreground`   | `oklch(0.5 0 0)`  | `oklch(0.58 0 0)` | Подписи, хинты — вторичный текст |

### Цветовые токены — интерактивные состояния

| Токен                    | Light (`:root`)        | Dark (`.dark`)         | Назначение                          |
| ------------------------ | ---------------------- | ---------------------- | ----------------------------------- |
| `--secondary`            | `oklch(0.94 0 0)`      | `oklch(0.2 0 0)`       | Hover-состояния, вторичные фоны     |
| `--secondary-foreground` | `oklch(0.2 0 0)`       | `oklch(0.97 0 0)`      | Текст на secondary                  |
| `--muted`                | `oklch(0.94 0 0)`      | `oklch(0.16 0 0)`      | Muted/disabled фон                  |
| `--accent`               | `oklch(0.93 0.018 85)` | `oklch(0.19 0.012 85)` | Sidebar active & ghost hover — warm |
| `--accent-foreground`    | `oklch(0.2 0.04 85)`   | `oklch(0.97 0 0)`      | Текст на accent (всегда читаемый)   |

### Цветовые токены — системные

| Токен           | Light (`:root`)          | Dark (`.dark`)          | Назначение                |
| --------------- | ------------------------ | ----------------------- | ------------------------- |
| `--destructive` | `oklch(0.58 0.245 27.3)` | `oklch(0.65 0.21 22.2)` | Ошибки/удаление — красный |
| `--border`      | `oklch(0.9 0 0)`         | `oklch(0.22 0.004 85)`  | Цвет границ (warm в dark) |
| `--input`       | `oklch(0.92 0 0)`        | `oklch(0.16 0 0)`       | Фон полей ввода           |

### Шкала скругления (`--radius`)

| Токен         | Значение                    | Вычислено         |
| ------------- | --------------------------- | ----------------- |
| `--radius`    | `0.625rem`                  | 10px (базис)      |
| `--radius-sm` | `calc(var(--radius) - 4px)` | 0.25rem (4px)     |
| `--radius-md` | `calc(var(--radius) - 2px)` | 0.425rem (6.8px)  |
| `--radius-lg` | `var(--radius)`             | 0.625rem (10px)   |
| `--radius-xl` | `calc(var(--radius) + 4px)` | 1.025rem (16.4px) |

### Typography & extended palette

- **`--font-sans`**: `'Inter', system-ui, sans-serif` (оба режима).
- **Extended palette (Tailwind-маппинг)**: `--color-yellow-subtle → var(--yellow-subtle)`, `--color-yellow-muted → var(--yellow-muted)`, `--color-avatar-text → var(--avatar-text)`.

---

## UI-примитивы (`components/ui/`)

shadcn/ui примитивы на базе Radix UI + Tailwind. (Исключены кастомные/прикладные компоненты — `AmountCurrencyInput`, `AnimatedTabs`, `CrmDialog`, `DatePicker`, `ImageUploadField`, `PhoneInput`, `RoleSelect`, `SegmentedToggle`, `ShareSlider`, `SliderNumberInput`, `TechAutocompleteInput` — и Sonner toast-обёртка; они учтены среди композитов.)

| name         | file                              | variants                                                                                                                                  |
| ------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Alert        | `components/ui/alert.tsx`         | variant: default, destructive                                                                                                             |
| AlertDialog  | `components/ui/alert-dialog.tsx`  | Root, Trigger, Portal, Overlay, Content, Header, Footer, Title, Description, Action, Cancel                                               |
| Avatar       | `components/ui/avatar.tsx`        | Root, Image, Fallback                                                                                                                     |
| Badge        | `components/ui/badge.tsx`         | default, secondary, destructive, outline, admin, senior, junior, hr, accountant, drop, status-active, status-closed, paid, pending        |
| Button       | `components/ui/button.tsx`        | variant: default, destructive, outline, secondary, ghost, link \| size: default, sm, lg, icon                                             |
| Calendar     | `components/ui/calendar.tsx`      | showOutsideDays, classNames для months/month_grid/weekday/day/selected/today/outside/disabled/range_middle                                |
| Card         | `components/ui/card.tsx`          | Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter                                                                     |
| Command      | `components/ui/command.tsx`       | Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandSeparator, CommandItem, CommandShortcut             |
| Dialog       | `components/ui/dialog.tsx`        | Root, Trigger, Portal, Overlay, Close, Content, Header, Footer, Title, Description                                                        |
| DropdownMenu | `components/ui/dropdown-menu.tsx` | Root, Trigger, Group, Portal, Sub, RadioGroup, SubTrigger, SubContent, Content, Item, CheckboxItem, RadioItem, Label, Separator, Shortcut |
| Input        | `components/ui/input.tsx`         | Standard HTML input + Tailwind styling, без вариантов                                                                                     |
| Label        | `components/ui/label.tsx`         | Без вариантов, на базе Radix Label primitive                                                                                              |
| Popover      | `components/ui/popover.tsx`       | Root, Trigger, Content, Anchor \| sideOffset=4, align=center                                                                              |
| RadioGroup   | `components/ui/radio-group.tsx`   | Root, Item (with indicator)                                                                                                               |
| ScrollArea   | `components/ui/scroll-area.tsx`   | Root, ScrollBar \| orientation: vertical, horizontal                                                                                      |
| Select       | `components/ui/select.tsx`        | Root, Group, Value, Trigger, ScrollUpButton, ScrollDownButton, Content, Label, Item, Separator \| position=popper                         |
| Separator    | `components/ui/separator.tsx`     | orientation: horizontal, vertical \| decorative=true                                                                                      |
| Sheet        | `components/ui/sheet.tsx`         | Root, Trigger, Portal, Overlay, Close, Content (side: top/bottom/left/right), Header, Footer, Title, Description                          |
| Skeleton     | `components/ui/skeleton.tsx`      | animate-pulse, без CVA-вариантов                                                                                                          |
| Table        | `components/ui/table.tsx`         | Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption                                                  |
| Tabs         | `components/ui/tabs.tsx`          | Root, List, Trigger, Content \| data-slot attributes для стилизации                                                                       |
| Tooltip      | `components/ui/tooltip.tsx`       | Provider, Root, Trigger, Content \| sideOffset=4                                                                                          |
| Textarea     | `components/ui/textarea.tsx`      | Standard HTML textarea + Tailwind styling, без вариантов, min-h-[80px]                                                                    |

**ИТОГО 22 ui/-примитива.**

---

## Композиты

Просканировано 103 композитных компонента в `apps/web/app/components` (non-ui подпапки) и `apps/web/app/routes/*/components`. **ДОМИНИРУЮЩИЕ** (наиболее переиспользуемые, формируют визуальный язык) помечены явно.

### Доминирующие композиты (формируют визуальный язык)

| name                          | file                                                    | purpose                                                                                                                       |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **CrmDialog** ⭐              | `components/ui/crm-dialog.tsx`                          | Обёртка диалога с фикс-header/body/footer, scrollable body, `max-h-[90dvh]` — стандарт для finance/documents/invoices/archive |
| **Card-семья** ⭐             | `components/ui/card.tsx`                                | Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter — фундамент всех поверхностей                      |
| **KpiCard** ⭐                | `routes/_authenticated/finance/components/KpiCards.tsx` | Метрик-карточка дашборда (title/value/icon/color), finance-сводки и drop-плюрализация                                         |
| **NavSidebar** ⭐             | `components/crm/nav-sidebar.tsx`                        | Главная навигация с role-based фильтром, sheet-mode для мобайла, маршрутизация dashboard-хаба                                 |
| **AnimatedTabs** ⭐           | `components/ui/animated-tabs.tsx`                       | Framer-motion таб-переключение со sliding-pill, используется `UserProfileShell` для 8-таб навигации                           |
| **SegmentedToggle** ⭐        | `components/ui/segmented-toggle.tsx`                    | iOS-style segmented control с motion-pill (pill/tabs), для payment-method/sort/layout-переключателей                          |
| **AmountCurrencyInput** ⭐    | `components/ui/amount-currency-input.tsx`               | Amount + currency-селектор (USDT/USD/EUR/UAH) с live-конвертацией, во всех finance-диалогах                                   |
| **ShareSlider** ⭐            | `components/ui/share-slider.tsx`                        | Range slider + number input для senior/drop % аллокации, визуализация split (company/role %)                                  |
| PageHeader / StickyPageHeader | `components/crm/StickyPageHeader.tsx`                   | Фикс-заголовок страницы (flex-none, z-20) с scrollable-контентом, opaque-фон для list/detail-страниц                          |

### Финанс-диалоги (доминирующее семейство в финансовом домене)

| name                       | file                                                                              | purpose                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ConfirmPayoutDialog ⭐     | `components/finance/ConfirmPayoutDialog.tsx`                                      | Подтверждение off-platform выплаты: CRYPTO/CASH (admin-селектор) vs COMPANY_ACCOUNT (shared) (high reuse) |
| PayoutDialog               | `routes/_authenticated/finance/components/dialogs/PayoutDialog.tsx`               | Step 1 SENIOR payout — выбор транзакций, создаёт payout_request                                           |
| PayoutDetailDialog         | `routes/_authenticated/finance/components/dialogs/PayoutDetailDialog.tsx`         | Step 2 payout — форма оплаты, Polygon/Solana network-селектор, contract address + tx-hash                 |
| CreateTransactionDialog    | `routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx`    | Ввод транзакции: funding source, AmountCurrencyInput, counterparty, receipt upload                        |
| PaySalaryDialog            | `routes/_authenticated/finance/components/dialogs/PaySalaryDialog.tsx`            | Выплата зарплаты: user-селектор, amount, funding source, batch-режим                                      |
| TransactionDetailDialog    | `routes/_authenticated/finance/components/dialogs/TransactionDetailDialog.tsx`    | Детали транзакции: метаданные, signature, status timeline, edit/confirm                                   |
| EditSeniorIncomeDialog     | `routes/_authenticated/finance/components/dialogs/EditSeniorIncomeDialog.tsx`     | Правка senior income для VALIDATED транзакций, AmountCurrencyInput с currency-lock                        |
| AdminEditTransactionDialog | `routes/_authenticated/finance/components/dialogs/AdminEditTransactionDialog.tsx` | Admin-only полная правка транзакции                                                                       |
| SettleSeniorPayoutDialog   | `routes/_authenticated/finance/components/dialogs/SettleSeniorPayoutDialog.tsx`   | Закрытие payout как paid (receipt upload / manual)                                                        |
| ValidateDialog             | `routes/_authenticated/finance/components/dialogs/ValidateDialog.tsx`             | Валидация SENIOR_INCOME транзакций перед созданием payout request                                         |
| FundingSourceFields        | `routes/_authenticated/finance/components/dialogs/FundingSourceFields.tsx`        | Переиспользуемый фрагмент funding-source (bank/wallet/company account)                                    |
| ReceiptPanel               | `routes/_authenticated/finance/components/dialogs/receipt-panel.tsx`              | Receipt-панель для деталей транзакции                                                                     |

### Финанс-страницы и строки/виджеты дашбордов

| name                | file                                                               | purpose                                                                          |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| TransactionRow      | `routes/_authenticated/finance/components/TransactionRow.tsx`      | Строка финанс-таблицы: status badge, amount/currency, counterparty, дата, экшены |
| DropFinancePage     | `routes/_authenticated/finance/components/DropFinancePage.tsx`     | Drop-специфичный layout finance-страницы (роль-вариант AccountantDashboard)      |
| Pagination          | `routes/_authenticated/finance/components/Pagination.tsx`          | Контрол пагинации списков финансов                                               |
| ReceiptInput        | `routes/_authenticated/finance/components/ReceiptInput.tsx`        | Поле загрузки receipt-документа для форм транзакций                              |
| AccountantDashboard | `routes/_authenticated/routing/components/AccountantDashboard.tsx` | Дашборд-шелл бухгалтера: finance-метрики + список транзакций                     |
| SeniorDashboard     | `routes/_authenticated/routing/components/SeniorDashboard.tsx`     | Дашборд синьора: project earnings + payout status                                |
| HRDashboard         | `routes/_authenticated/routing/components/HRDashboard.tsx`         | Дашборд HR: team + interview метрики                                             |
| DropDashboard       | `routes/_authenticated/routing/components/DropDashboard.tsx`       | Дашборд drop (phase 3 consolidated routing hub)                                  |
| DropBalanceCard     | `routes/_authenticated/routing/components/DropBalanceCard.tsx`     | Карточка earnings/balance для drop                                               |
| InProgressPanel     | `routes/_authenticated/routing/components/InProgressPanel.tsx`     | Панель активных проектов/собеседований для дашборда                              |
| EarningsStatsBlock  | `routes/_authenticated/routing/components/EarningsStatsBlock.tsx`  | Блок сводных earnings-метрик                                                     |
| EarningsSparkline   | `routes/_authenticated/routing/components/EarningsSparkline.tsx`   | Мини-чарт тренда earnings                                                        |
| SliderNumberInput   | `components/ui/slider-number-input.tsx`                            | Generic slider + number input (0–100), для salary-change и % селекторов          |

### Документы / Инвойсы

| name                 | file                                              | purpose                                                                             |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| DocumentCard         | `components/documents/document-card.tsx`          | Карточка-grid документа: thumbnail (image/PDF), filename, метаданные, экшены        |
| DocumentDetailDialog | `components/documents/document-detail-dialog.tsx` | Полный просмотр документа: preview, метаданные, Cyrillic-filename, presigned S3     |
| DocumentList         | `components/documents/document-list.tsx`          | Обёртка grid-layout документов + управление состоянием                              |
| UploadDocumentDialog | `components/documents/upload-document-dialog.tsx` | Модалка загрузки: category-селектор, drag-drop, presigned S3 upload                 |
| DocumentRow          | `components/documents/document-row.tsx`           | Табличная строка документа (альтернатива card-grid)                                 |
| DocumentStatusBadge  | `components/documents/document-status-badge.tsx`  | Бейдж статуса документа                                                             |
| DocumentImage        | `components/documents/document-image.tsx`         | Превью image/PDF документа с thumbnail-вариантом                                    |
| PdfPreview           | `components/documents/pdf-preview.tsx`            | PDF iframe-вьюер с presigned URL                                                    |
| InvoiceCard          | `components/invoices/invoice-card.tsx`            | Строка-карточка транзакции: type/status badges, amount, counterparty, relative time |
| InvoiceDetailDialog  | `components/invoices/invoice-detail-dialog.tsx`   | Модальный вьюер: PDF iframe, signature table, public verify URL, sign-action        |

### Профиль пользователя (UserProfileShell + табы + admin/self-edit)

| name                            | file                                                               | purpose                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| UserProfileShell                | `components/user-profile/UserProfileShell.tsx`                     | Контейнер профиля с AnimatedTabs (overview/finance/projects/team/interviews/requisites/documents/contract) |
| OverviewTab                     | `components/user-profile/tabs/OverviewTab.tsx`                     | Таб summary + KPI cards                                                                                    |
| FinanceTab                      | `components/user-profile/tabs/FinanceTab.tsx`                      | Таб финансовых транзакций и выплат                                                                         |
| ProjectsTab                     | `components/user-profile/tabs/ProjectsTab.tsx`                     | Таб назначенных проектов                                                                                   |
| TeamTab                         | `components/user-profile/tabs/TeamTab.tsx`                         | Таб участников команды под управлением                                                                     |
| InterviewsTab                   | `components/user-profile/tabs/InterviewsTab.tsx`                   | Таб истории собеседований                                                                                  |
| RequisitesTab                   | `components/user-profile/tabs/RequisitesTab.tsx`                   | Таб bank/wallet реквизитов                                                                                 |
| DocumentsTab                    | `components/user-profile/tabs/DocumentsTab.tsx`                    | Таб списка документов пользователя                                                                         |
| ContractTab                     | `components/user-profile/contract/ContractTab.tsx`                 | Таб редактора контракта с PDF-preview                                                                      |
| ContractActionBar               | `components/user-profile/contract/ContractActionBar.tsx`           | Кнопки действий контракта (save/download/sign)                                                             |
| ContractEditor                  | `components/user-profile/contract/ContractEditor.tsx`              | Редактор шаблона контракта с подстановкой переменных                                                       |
| ContractFillForm                | `components/user-profile/contract/ContractFillForm.tsx`            | Форма заполнения переменных шаблона                                                                        |
| ContractPdfPreview              | `components/user-profile/contract/ContractPdfPreview.tsx`          | PDF-превью сгенерированного контракта                                                                      |
| AdminActionsMenu (user-profile) | `components/user-profile/admin-actions/AdminActionsMenu.tsx`       | Меню admin-действий профиля (note/role/salary/requisites/archive)                                          |
| AdminNoteDialog                 | `components/user-profile/admin-actions/AdminNoteDialog.tsx`        | Добавить/изменить admin-заметку на профиле                                                                 |
| ArchiveUserDialog               | `components/user-profile/admin-actions/ArchiveUserDialog.tsx`      | Подтверждение архивации пользователя с impact                                                              |
| ChangeRequisitesDialog          | `components/user-profile/admin-actions/ChangeRequisitesDialog.tsx` | Admin-override реквизитов (bank/wallet)                                                                    |
| ChangeRoleDialog                | `components/user-profile/admin-actions/ChangeRoleDialog.tsx`       | Смена роли (SENIOR/HR/ACCOUNTANT/ADMIN/JUNIOR)                                                             |
| ChangeSalaryDialog              | `components/user-profile/admin-actions/ChangeSalaryDialog.tsx`     | Обновление зарплаты и % доли через SliderNumberInput                                                       |
| EditProfileDialog               | `components/user-profile/admin-actions/EditProfileDialog.tsx`      | Admin bulk-правка профиля (name/email/phone)                                                               |
| ProfileEditFields               | `components/user-profile/self-edit/ProfileEditFields.tsx`          | Self-edit форма полей профиля (name/email/phone/avatar)                                                    |
| RequisitesEditForm              | `components/user-profile/self-edit/RequisitesEditForm.tsx`         | Self-edit форма реквизитов (bank/wallet/company account)                                                   |

### Пользователи / Команда

| name                         | file                                            | purpose                                                                                            |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| UserDialog ⭐                | `components/users/UserDialog.tsx`               | Создание/правка пользователя: SegmentedToggle, AmountCurrencyInput, role-builder, Zod (high reuse) |
| UserRow                      | `components/users/UserRow.tsx`                  | Строка списка: avatar/name/role/status/actions                                                     |
| UserAvatar                   | `components/users/UserAvatar.tsx`               | Аватар с fallback-инициалами                                                                       |
| ProfileNameLink              | `components/users/ProfileNameLink.tsx`          | Кликабельная ссылка имени на профиль                                                               |
| CreateWizardStepper          | `components/users/CreateWizardStepper.tsx`      | Multi-step мастер создания пользователя                                                            |
| ArchiveConfirmDialog (users) | `components/users/ArchiveConfirmDialog.tsx`     | Вариант подтверждения архивации пользователя                                                       |
| UnarchiveButton              | `components/users/UnarchiveButton.tsx`          | Кнопка восстановления архивированного пользователя                                                 |
| RejoinTeamDialog             | `components/users/RejoinTeamDialog.tsx`         | Диалог возврата архивированного пользователя в команду                                             |
| HrChipsField                 | `components/users/HrChipsField.tsx`             | Селектор HR с multi-select (Radix chips)                                                           |
| AccountantChipField          | `components/users/AccountantChipField.tsx`      | Селектор бухгалтера с multi-select                                                                 |
| AdminActionsMenu (users)     | `components/admin-actions/AdminActionsMenu.tsx` | Глобальное меню admin-действий (переиспользуется в разных контекстах)                              |

### Проекты

| name                      | file                                                | purpose                                               |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| ProjectRow                | `components/projects/ProjectRow.tsx`                | Строка списка проектов: name/desc/team/status/actions |
| ProjectCredentialsSection | `components/projects/ProjectCredentialsSection.tsx` | Креды проекта (API keys/tokens)                       |
| ProjectLegendSection      | `components/projects/ProjectLegendSection.tsx`      | Легенда/цветовой референс проекта для команды         |
| ProjectLogo               | `components/projects/ProjectLogo.tsx`               | Логотип проекта или category-icon                     |

### Архив

| name                  | file                                           | purpose                                                                        |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| ArchiveConfirmDialog  | `components/archive/ArchiveConfirmDialog.tsx`  | Подтверждение архивации сущности с impact (N users/teams/projects), role-aware |
| CascadeUnarchiveModal | `components/archive/CascadeUnarchiveModal.tsx` | Каскадный unarchive (users/teams/projects) с разрешением зависимостей          |

### Контракты / Онбординг

| name                    | file                                               | purpose                                     |
| ----------------------- | -------------------------------------------------- | ------------------------------------------- |
| AddCustomVariableDialog | `components/contracts/AddCustomVariableDialog.tsx` | Добавление кастомной переменной в шаблон    |
| VariablesPanel          | `components/contracts/VariablesPanel.tsx`          | Панель подстановки переменных контракта     |
| AcceptTosStep           | `components/onboarding/AcceptTosStep.tsx`          | Шаг онбординга — принятие ToS               |
| SignContractStep        | `components/onboarding/SignContractStep.tsx`       | Шаг онбординга — подписание контракта       |
| ContractWaitScreen      | `components/onboarding/ContractWaitScreen.tsx`     | Экран ожидания во время обработки контракта |
| TosUpdateBanner         | `components/onboarding/TosUpdateBanner.tsx`        | Баннер уведомления об обновлении ToS        |

### Layout / Notifications / Admin / Interviews

| name                         | file                                                                           | purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| NotificationsBell            | `components/layout/notifications-bell.tsx`                                     | Header-bell dropdown: in-app уведомления, 30s polling, mark-as-read |
| ChangeWalletAddressDialog    | `routes/_authenticated/admin/ChangeWalletAddressDialog.tsx`                    | Admin-обновление wallet address                                     |
| CreateProjectFromHiredDialog | `routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx` | Создание проекта из hired-кандидата                                 |
| InterviewDetailSheet         | `routes/_authenticated/interviews/components/InterviewDetailSheet.tsx`         | Sheet/modal деталей собеседования с инфо кандидата                  |
| CreateInterviewDialog        | `routes/_authenticated/interviews/components/CreateInterviewDialog.tsx`        | Форма создания собеседования (кандидат/проект/дата)                 |
| KanbanColumn                 | `routes/_authenticated/interviews/components/KanbanColumn.tsx`                 | Колонка kanban статуса (applied/interview/offered/hired/archived)   |
| ArchiveSection               | `routes/_authenticated/interviews/components/ArchiveSection.tsx`               | Секция архива в kanban-борде собеседований                          |

**ИТОГО 103 композитных файла** (включая все строки/виджеты выше; полный список покрывает finance, dashboards, documents, invoices, user-profile, users/team, projects, archive, contracts/onboarding, layout, admin, interviews).

---

## Диалоги / модалки (сгруппированы по домену)

Найдено **42** dialog/modal-компонента (выделенные `*Dialog.tsx`/`*Modal.tsx` + inline-использования `CrmDialog` / `Dialog` / `Sheet` / `AlertDialog` из Radix-примитивов), сгруппированных в 10 доменов.

### finance (10)

- PayoutDetailDialog — `routes/_authenticated/finance/components/dialogs/PayoutDetailDialog.tsx`
- PaySalaryDialog — `routes/_authenticated/finance/components/dialogs/PaySalaryDialog.tsx`
- TransactionDetailDialog — `routes/_authenticated/finance/components/dialogs/TransactionDetailDialog.tsx`
- EditSeniorIncomeDialog — `routes/_authenticated/finance/components/dialogs/EditSeniorIncomeDialog.tsx`
- CreateTransactionDialog — `routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx`
- AdminEditTransactionDialog — `routes/_authenticated/finance/components/dialogs/AdminEditTransactionDialog.tsx`
- SettleSeniorPayoutDialog — `routes/_authenticated/finance/components/dialogs/SettleSeniorPayoutDialog.tsx`
- PayoutDialog — `routes/_authenticated/finance/components/dialogs/PayoutDialog.tsx`
- ValidateDialog — `routes/_authenticated/finance/components/dialogs/ValidateDialog.tsx`
- ConfirmPayoutDialog — `components/finance/ConfirmPayoutDialog.tsx`

### profile (9)

- AvatarUploadDialog — `components/user-profile/AvatarUploadDialog.tsx`
- ChangeRequisitesDialog — `components/user-profile/admin-actions/ChangeRequisitesDialog.tsx`
- AdminNoteDialog — `components/user-profile/admin-actions/AdminNoteDialog.tsx`
- ChangeSalaryDialog — `components/user-profile/admin-actions/ChangeSalaryDialog.tsx`
- EditProfileDialog — `components/user-profile/admin-actions/EditProfileDialog.tsx`
- ChangeRoleDialog — `components/user-profile/admin-actions/ChangeRoleDialog.tsx`
- ArchiveUserDialog — `components/user-profile/admin-actions/ArchiveUserDialog.tsx`
- UserProfileShell (Sheet usage) — `components/user-profile/UserProfileShell.tsx`
- ContractActionBar (Dialog usage) — `components/user-profile/contract/ContractActionBar.tsx`
- RequisitesEditForm (AlertDialog usage) — `components/user-profile/self-edit/RequisitesEditForm.tsx`

### team (3)

- RejoinTeamDialog — `components/users/RejoinTeamDialog.tsx`
- ArchiveConfirmDialog — `components/users/ArchiveConfirmDialog.tsx`
- UserDialog — `components/users/UserDialog.tsx`

### interviews (3)

- CreateProjectFromHiredDialog — `routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx`
- CreateInterviewDialog — `routes/_authenticated/interviews/components/CreateInterviewDialog.tsx`
- InterviewDetailSheet — `routes/_authenticated/interviews/components/InterviewDetailSheet.tsx`

### documents (4)

- upload-document-dialog — `components/documents/upload-document-dialog.tsx`
- document-detail-dialog — `components/documents/document-detail-dialog.tsx`
- document-card (Dialog usage) — `components/documents/document-card.tsx`
- document-row (Dialog usage) — `components/documents/document-row.tsx`

### invoices (1)

- invoice-detail-dialog — `components/invoices/invoice-detail-dialog.tsx`

### projects (3)

- ProjectCredentialsSection (AlertDialog usage) — `components/projects/ProjectCredentialsSection.tsx`
- projects/index (Dialog usage) — `routes/_authenticated/projects/index.tsx`
- projects/$projectId (Dialog usage) — `routes/_authenticated/projects/$projectId.tsx`

### admin (3)

- ChangeWalletAddressDialog — `routes/_authenticated/admin/ChangeWalletAddressDialog.tsx`
- contracts.$role (Dialog usage) — `routes/_authenticated/admin/contracts.$role.tsx`
- tos.new (Dialog usage) — `routes/_authenticated/admin/tos.new.tsx`

### archive (2)

- CascadeUnarchiveModal — `components/archive/CascadeUnarchiveModal.tsx`
- ArchiveConfirmDialog — `components/archive/ArchiveConfirmDialog.tsx`

### contracts (1)

- AddCustomVariableDialog — `components/contracts/AddCustomVariableDialog.tsx`

### navigation / onboarding (2)

- AdminActionsMenu (Dialog usage) — `components/admin-actions/AdminActionsMenu.tsx`
- nav-sidebar (Dialog usage) — `components/crm/nav-sidebar.tsx`

**ИТОГО ~42 диалога/модалки** (finance 10 · profile 9 · team 3 · interviews 3 · documents 4 · invoices 1 · projects 3 · admin 3 · archive 2 · contracts 1 · navigation/onboarding 2).

---

## Role-conditional поверхности (6 ролей)

6 RBAC-ролей: **ADMIN · SENIOR · JUNIOR · HR · ACCOUNTANT · DROP**. Выявлено 15 role-conditional UI-поверхностей. Ключевые паттерны: role-specific дашборды, видимость категорий документов, фильтрация навигации, маскировка профиля, gate финансовых KPI.

| Поверхность                                   | Роли                                        | Заметка                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard (Root `/`)                          | ADMIN, SENIOR, HR, ACCOUNTANT, DROP         | Routing по роли: JUNIOR→redirect `/project`; DROP→DropDashboard; ACCOUNTANT→AccountantDashboard; HR→HRDashboard; SENIOR→SeniorDashboard; ADMIN→generic. 5 компонентов.                                                               |
| Navigation Sidebar                            | ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP | Фильтр через `navRolesFor()`. JUNIOR — 5 пунктов (Project/Legend/Finance/Docs/Profile); DROP — Dashboard/Profile/Team/Finance; SENIOR+HR+ACCOUNTANT — full; ADMIN — Admin panel. Teamless SENIOR прячет Projects/Interviews.         |
| Documents — Category Filter                   | ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP | `TAB_VISIBILITY`: ADMIN [RESUME,SCAN,CONTRACT,RECEIPT,INVOICE,AVATAR,LOGO]; SENIOR/DROP [RESUME,SCAN,CONTRACT,RECEIPT,INVOICE]; JUNIOR [RESUME,SCAN,CONTRACT,INVOICE]; HR [RESUME,SCAN,CONTRACT]; ACCOUNTANT [SCAN,RECEIPT,INVOICE]. |
| Documents — Upload Permission                 | ADMIN, SENIOR, JUNIOR, HR, ACCOUNTANT, DROP | `UPLOADABLE_PER_ROLE`: ADMIN/SENIOR [RESUME,SCAN,CONTRACT]; JUNIOR/HR [RESUME,SCAN]; ACCOUNTANT []; DROP [RESUME,SCAN,CONTRACT]. Кнопка upload disabled по роли.                                                                     |
| Documents — Owner Filter                      | ADMIN, HR                                   | `canSeeOwnerFilter()` → true только для ADMIN/HR. Owner-dropdown скрыт для остальных.                                                                                                                                                |
| Documents — Status Tabs (All/Active/Archived) | ADMIN                                       | SegmentedToggle только для ADMIN. Не-админы видят active-docs; deleted/archived фильтруются на UI-слое.                                                                                                                              |
| Legend Page (`/legend`)                       | JUNIOR, ADMIN, HR                           | `useRoleGuard(['JUNIOR','ADMIN','HR'])` + redirect: SENIOR/DROP→`/profile`. Persona/Cover/Journal-блоки editable.                                                                                                                    |
| User Profile — Finance Tab                    | ADMIN, ACCOUNTANT                           | `isPrivileged` gate: карточка «Всего заработано» только для ADMIN/ACCOUNTANT на SENIOR/DROP/JUNIOR/HR targets. Privileged `/users/:id/transactions` vs public `/transactions`.                                                       |
| User Profile — Overview — Requisites          | DROP                                        | `isDropSelfView`: DROP self-view показывает RequisitesMissingBanner (если paymentMethod=null) или DropRequisitesSnippet (read-only). USDT/Bank display conditional.                                                                  |
| User Profile — Overview — KPI Cards           | SENIOR, DROP, JUNIOR, HR                    | Salary/Share/PaymentMethod KPI через `permissions.fields` gates: разные viewers (ADMIN/ACCOUNTANT) видят разные комбо карточек per target role.                                                                                      |
| User Profile — Overview — Project Credentials | JUNIOR                                      | `ProfileCredentialsSection` для JUNIOR-профилей только для ADMIN/HR viewers (`permissions.fields.projectCredentials=true`).                                                                                                          |
| User Profile — Interviews Link (Header)       | SENIOR                                      | `showInterviewsLink = user.role === 'SENIOR'`. Ссылка на kanban только в SENIOR-профиле в header.                                                                                                                                    |
| Stats Page (`/stats`)                         | ADMIN, ACCOUNTANT                           | Вся страница за `isPrivilegedViewer` (ADMIN\|ACCOUNTANT). Finance/Income только для privilege-gate; иначе redirect.                                                                                                                  |
| User Profile — Admin Note Card                | ADMIN                                       | `canSeeAdminNote = permissions.actions.includes('set-note')`. ADMIN на non-self user видит editable note; self/non-admin скрывают.                                                                                                   |
| User Profile — ToS Acceptance Badge           | ADMIN                                       | `canSeeTos = tosAcceptedAt !== undefined`. Backend отдаёт поле только ADMIN viewers или self. Masking-бейдж per viewer role.                                                                                                         |

---

## Coverage checklist для /design-sync verification

- [ ] Токены захвачены (цвета oklch + `--radius` + Inter + light/dark)
  - [ ] Бренд-жёлтый hue 85.3° (`--primary` light `0.8` / dark `0.84`)
  - [ ] Шкала `--radius` (sm/md/lg/xl от базиса `0.625rem`)
  - [ ] `--font-sans` = Inter + system fallback
  - [ ] Light (`:root`) и Dark (`.dark`) parity; dark — default
  - [ ] 3 жёлтых shade (muted/subtle/avatar-text) + extended palette маппинг
- [ ] Все 22 ui/-примитива
  - [ ] Badge с 14 role/status вариантами (admin/senior/junior/hr/accountant/drop/status-\*)
  - [ ] Button (6 variant × 4 size)
  - [ ] Overlay-семья: Dialog / AlertDialog / Sheet / Popover / DropdownMenu / Tooltip / Command
- [ ] Доминирующие композиты
  - [ ] Card-семья (Card/Header/Title/Description/Content/Footer)
  - [ ] KpiCard
  - [ ] CrmDialog (стандарт-обёртка диалогов)
  - [ ] Финанс-диалоги (Payout/Transaction/Salary/Validate-семейство + ConfirmPayoutDialog)
  - [ ] NavSidebar (role-filtered навигация)
  - [ ] AnimatedTabs / SegmentedToggle / AmountCurrencyInput / ShareSlider
- [ ] Семейство диалогов (~42 в 10 доменах)
  - [ ] finance (10) · profile (9) · team (3) · interviews (3) · documents (4) · invoices (1) · projects (3) · admin (3) · archive (2) · contracts (1) · navigation/onboarding (2)
- [ ] Role-conditional поверхности (15 surfaces × 6 ролей) — маскировка/gate проверены
