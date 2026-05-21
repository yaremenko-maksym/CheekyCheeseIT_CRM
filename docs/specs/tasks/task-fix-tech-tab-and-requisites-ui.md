# task-fix-tech-tab-and-requisites-ui

## Агент: coder
## Приоритет: high
## Ветка: claude/youthful-hermann-8df1d5 (PR #28)

## КРИТИЧЕСКИ ВАЖНО

- **Fix-задача в существующую ветку:**
  ```bash
  git fetch origin
  git checkout claude/youthful-hermann-8df1d5
  git pull origin claude/youthful-hermann-8df1d5
  ```
- Push в эту же ветку.

---

## ЗАДАЧА 1 — Tech autocomplete Tab key bug

### Проблема (user feedback)

> "автокомплит на технологиях работает немного криво. Я пишу "Reac" и выбираю стрелочками React Query, далее нажимаю Tab и сабмититься React (тот что был первым в списке) а не React Query. Если нажимаю Enter, то всё работает как и задумано"

### Корень

`apps/web/app/components/ui/tech-autocomplete-input.tsx` — keyboard handler:

```ts
if (e.key === 'Tab' && suggestions[0]) { e.preventDefault(); add(suggestions[0]); return }
if (e.key === 'Enter') { e.preventDefault(); add(suggestions[activeIdx] ?? input); return }
```

Tab всегда берёт `suggestions[0]` (первый в списке), игнорируя `activeIdx` (highlighted через стрелки). Enter использует `activeIdx` корректно — поэтому работает.

### Fix

Унифицировать: Tab и Enter должны делать одно и то же — добавить `suggestions[activeIdx] ?? input`:

```ts
if ((e.key === 'Tab' || e.key === 'Enter') && (suggestions.length > 0 || input.trim())) {
  e.preventDefault()
  add(suggestions[activeIdx] ?? input)
  return
}
```

Или явно:
```ts
function commit() {
  add(suggestions[activeIdx] ?? input)
}
if (e.key === 'Tab')   { e.preventDefault(); commit(); return }
if (e.key === 'Enter') { e.preventDefault(); commit(); return }
```

### Acceptance #1

- Печатаешь "Reac" → suggestions [React, React Native, React Router, React Query, React Hook Form]
- ArrowDown → highlight "React Native" → Tab → добавляется **React Native** (не React)
- ArrowDown ×3 → highlight "React Query" → Tab → добавляется **React Query**
- ArrowDown ×3 → highlight "React Query" → Enter → то же
- Чистый input + Tab → ничего не происходит (не добавлять пустоту)

### Commit

`fix(ui): TechAutocompleteInput — Tab adds highlighted suggestion, not first`

---

## ЗАДАЧА 2 — Реквизиты UI: красивое переключение методов + красивые инпуты

### Проблема (user feedback)

> "сделай поле переключение реквизитов красивым и сами инпуты с реквизитами тоже сделай красивыми"

Сейчас:
- **Self-edit** (`apps/web/app/components/user-profile/self-edit/RequisitesEditForm.tsx`) — radio buttons `USDT_ERC20 / BANK_UAH_FOP` + плоские inputs. Скучно.
- **Read view** (`apps/web/app/components/user-profile/tabs/RequisitesTab.tsx`) — карточка с CopyableField для IBAN/РНОКПП. Лучше, но monoхромно.

### Что сделать

#### 2.1 Method switcher — segmented control с иконками

Замени radio на красивый **segmented control** (две большие кнопки рядом):

```tsx
<div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-1">
  <button
    type="button"
    onClick={() => setMethod('USDT_ERC20')}
    className={cn(
      'flex flex-col items-start gap-1 rounded-md px-4 py-3 text-left transition-all',
      method === 'USDT_ERC20'
        ? 'bg-background shadow-sm ring-1 ring-border'
        : 'hover:bg-background/50'
    )}
    aria-pressed={method === 'USDT_ERC20'}
  >
    <div className="flex items-center gap-2">
      <div className={cn('flex h-8 w-8 items-center justify-center rounded-md', method === 'USDT_ERC20' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
        <Bitcoin className="h-4 w-4" />
      </div>
      <span className="text-sm font-semibold">USDT ERC-20</span>
    </div>
    <p className="text-xs text-muted-foreground">Криптовалюта (Ethereum)</p>
  </button>

  <button
    type="button"
    onClick={() => setMethod('BANK_UAH_FOP')}
    ...
  >
    <div className="flex items-center gap-2">
      <div className={cn('flex h-8 w-8 items-center justify-center rounded-md', method === 'BANK_UAH_FOP' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
        <Landmark className="h-4 w-4" />
      </div>
      <span className="text-sm font-semibold">UAH ФОП</span>
    </div>
    <p className="text-xs text-muted-foreground">Банковский счёт в Украине</p>
  </button>
</div>
```

Иконки: `Bitcoin` или `Wallet` для USDT, `Landmark` или `Building2` для UAH ФОП — из `lucide-react`.

Для SENIOR/ADMIN второй пункт (UAH ФОП) **отключен** (disabled) с tooltip "SENIOR и ADMIN получают только в USDT ERC-20" — соответствует backend constraint.

#### 2.2 Inputs — красивые с иконками + group labels

Заменить плоские Input на **Input с leading icon + улучшенным spacing + group лейблами**:

**USDT карточка** (когда выбран USDT_ERC20):
```tsx
<Card>
  <CardHeader className="pb-3">
    <CardTitle className="flex items-center gap-2 text-base">
      <Bitcoin className="h-4 w-4 text-primary" />
      USDT ERC-20 кошелёк
    </CardTitle>
    <CardDescription>Адрес для получения выплат в сети Ethereum</CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    <div className="space-y-1.5">
      <Label htmlFor="wallet">Адрес кошелька</Label>
      <div className="relative">
        <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          id="wallet"
          value={walletUsdt}
          onChange={...}
          placeholder="0x1234...abcd (42 символа)"
          className="pl-9 font-mono"
        />
      </div>
      <p className="text-xs text-muted-foreground">Начинается с 0x, всего 42 символа</p>
    </div>
    <div className="space-y-1.5">
      <Label htmlFor="wallet-label">Метка (необязательно)</Label>
      <div className="relative">
        <Tag className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          id="wallet-label"
          value={walletLabel}
          placeholder="Например: основной кошелёк"
          className="pl-9"
        />
      </div>
    </div>
  </CardContent>
</Card>
```

**UAH ФОП карточка** (когда выбран BANK_UAH_FOP):
```tsx
<Card>
  <CardHeader className="pb-3">
    <CardTitle className="flex items-center gap-2 text-base">
      <Landmark className="h-4 w-4 text-primary" />
      Банковские реквизиты ФОП
    </CardTitle>
    <CardDescription>Для перевода в гривне на украинский ФОП</CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    {/* Получатель */}
    <div className="space-y-1.5">
      <Label htmlFor="recipient">Получатель (ФИО)</Label>
      <div className="relative">
        <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input id="recipient" placeholder="Иванов Иван Иванович" className="pl-9" />
      </div>
    </div>

    {/* IBAN + РНОКПП в две колонки на md+ */}
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="iban">IBAN</Label>
        <div className="relative">
          <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            id="iban"
            placeholder="UA12 3456 7890 1234 5678 9012 3456 7"
            className="pl-9 font-mono uppercase"
          />
        </div>
        <p className="text-xs text-muted-foreground">UA + 27 цифр</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rnokpp">РНОКПП</Label>
        <div className="relative">
          <IdCard className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            id="rnokpp"
            placeholder="1234567890"
            inputMode="numeric"
            maxLength={10}
            className="pl-9 font-mono"
          />
        </div>
        <p className="text-xs text-muted-foreground">10 цифр</p>
      </div>
    </div>

    {/* Банк */}
    <div className="space-y-1.5">
      <Label htmlFor="bank">Банк (необязательно)</Label>
      <div className="relative">
        <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input id="bank" placeholder="ПриватБанк" className="pl-9" />
      </div>
    </div>
  </CardContent>
</Card>
```

Иконки из lucide-react: `Bitcoin`, `Landmark`, `Wallet`, `Tag`, `User`, `Hash`, `IdCard`, `Building2`.

#### 2.3 Read-only view (RequisitesTab) — тоже улучшить

Применить тот же визуальный стиль к **read-only** просмотру в `RequisitesTab.tsx`:
- Карточка с иконкой+title как выше
- Copy-кнопки рядом со значениями (для IBAN, РНОКПП, USDT адрес) — кнопки `Copy` иконка → toast "Скопировано". Это **уже частично есть** (CopyableField), просто убедись что стиль матчит и иконки добавлены.
- Если поле пустое — серым "не указано"

#### 2.4 Анимация перехода между методами

При переключении USDT ↔ UAH FOP — плавный fade/slide между карточками. Через framer-motion `<AnimatePresence>`:

```tsx
<AnimatePresence mode="wait">
  {method === 'USDT_ERC20' ? (
    <motion.div key="usdt" initial={{opacity:0, y:8}} animate={{opacity:1, y:0}} exit={{opacity:0, y:-8}} transition={{duration:0.2}}>
      <UsdtCard />
    </motion.div>
  ) : (
    <motion.div key="bank" initial={{opacity:0, y:8}} animate={{opacity:1, y:0}} exit={{opacity:0, y:-8}} transition={{duration:0.2}}>
      <BankCard />
    </motion.div>
  )}
</AnimatePresence>
```

### Acceptance #2

- Открыл self-edit `/crm/profile` → таб "Реквизиты" — segmented control с двумя large buttons, иконки, описания
- SENIOR логин → UAH ФОП кнопка disabled с tooltip
- Клик USDT → анимированный switch → красивая карточка с Bitcoin иконкой, leading icon в input, формат-помощь
- Клик UAH ФОП → анимированный switch → карточка с Landmark иконкой, two-col grid для IBAN/РНОКПП, формат-help
- AlertDialog "На базе этих данных..." при сохранении — оставить как есть (нельзя терять подтверждение)
- Read view (другой профиль или ADMIN viewing SENIOR) — тот же стиль карточки + copy кнопки
- Mobile responsive — карточки не ломаются на узком экране

### Commit

`feat(profile): polished requisites editor — segmented method switch + icon-prefixed inputs + animation`

---

## ОБЩЕЕ ACCEPTANCE

- `pnpm exec turbo typecheck lint --force` — clean
- API:3001 + Web:3000 — 200
- Push в `claude/youthful-hermann-8df1d5`

## После

Короткий summary (≤200 слов): 2 SHA коммита, скриншоты через Playwright если делал.

Используй MCP:
- ast-grep для поиска всех мест использования RequisitesEditForm/RequisitesTab
- context7 для shadcn Card + framer-motion AnimatePresence docs
- eslint MCP pre-check
