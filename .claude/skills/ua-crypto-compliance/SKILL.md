---
name: ua-crypto-compliance
description: When Legal-agent advises on USDT / crypto payouts in CRM Phase 8 (smart contracts) or при review PR-ов трогающих wallets/transactions. UA-specific snapshot — Закон 2074-IX status (НЕ введён, ждёт 10225-д), AML thresholds (Закон 361-IX), ДПС-заборона крипто на ЄП. Использовать в Mode A consultation про crypto channel + Mode B PR-review.
when_to_use: "Use when Legal advises on USDT / crypto payouts (Phase 8 smart contracts) or reviews a PR touching wallets/transactions. Examples: 'можно ли платить в USDT', 'VASP лицензия', 'AML пороги', 'крипто на ЄП запрещено?', 'статус закона 2074-IX', 'PR трогает walletAddress/smart-contract'."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# UA Crypto Compliance (Legal knowledge primitive)

UA-specific crypto / virtual assets / AML knowledge для CRM Phase 8 (Smart Contracts USDT). НЕ покрыто ECC. Лифтнуто из `.claude/agents/memory/legal/lessons.md` (#usdt #aml items).

**Disclaimer:** Legal vacuum status. Любая production crypto channel = legal risk. Этот skill — справочный материал; final sign-off — IT-corporate lawyer.

## When to invoke

- Перед Mode A consultation про smart contracts / USDT payouts
- Перед Mode B PR-review на любые changes в wallets / transactions / smart contracts / payouts
- Когда user iterates по cash/USDT channel variants
- При обсуждении wallet field changes в users profile (Phase 7)

## Patterns

### 1. Закон 2074-IX «Про віртуальні активи» — status

**Правило:** Закон 2074-IX прийнятий **17.02.2022** але **НЕ введений у дію** — ждёт зміни ПКУ (законопроект 10225-д).

**Timeline 10225-д:**

- Перше читання: **03.09.2025**
- Plan активація: **01.01.2026**

**Decision rule:** Будь-яка production crypto channel зараз = legal vacuum + risk ДПС корректировки фінрезультату. Crypto features = `feature_flag: false` до реальної активації 10225-д.

**В CRM:** Phase 8 (smart contracts) розробляється тестово / на testnet, production rollout — після активації 10225-д ИЛИ explicit legal sign-off від IT-corporate lawyer.

### 2. AML Thresholds (Закон 361-IX)

**Правило:** Фінмоніторинг crypto thresholds — **30k грн (~$720) на транзакцію** триггерит обязательство screening per Закон 361-IX.

**Decision rule:** Для типичных IT outsource выплат це поріг превищується практично завжди → без KYC процедур = AML риск на каждой транзакции.

**Mechanism для CRM:**

- Каждая crypto-транзакция > 30k грн eq. → must capture KYC data (source of funds, beneficiary owner ID).
- Smart contract не звільняє від KYC — banking layer (cash-out) все одно вимагає.

### 3. ДПС-заборона крипто на ЄП (ФОП-3)

**Правило:** ДПС офіційно заборонила крипто-доход на Єдиному податку (ФОП-3). Crypto = бартер → exclusion + 15% штраф.

**Decision rule:** ФОП-3 + USDT в договорі = autopath до exclusion з ЄП. Не пропонувати як solution навіть для коротких bridges.

**Реальний impact:** Якщо user отримує USDT як ФОП-3 — це autorisk reclassification + retroactive перерахунок на загальну систему 18% ПДФО + 15% штраф.

### 4. Multi-issuer / cash-channel — hard refuse zone

**Правило:** Multi-issuer схема (cash/crypto оплачується на entity ≠ основна компанія) = **pattern податкового уклонення**, ст. 212 ККУ при порозі ₴4.99M (легко перевищується при наших оборотах).

**Hard refuse zone** — § 1 escalation-zones.md. Never recommend, при user assumption такого формату — явно отказувати + escalate to criminal defense lawyer.

**Cash channel в IT-outsource** практично неможливий legally:

- NBU ліміт ₴10k/день B2B (Постанова № 148)
- Заборона FX-cash з нерезидентами (Постанова НБУ № 5 від 24.02.2022)

**Decision rule:** При user'ах хотячих cash в архітектурі — категорично виписувати на проектному рівні, не намагатися оптимізувати.

### 5. Wallet field changes — minimal trigger для crypto compliance review

**Правило:** Будь-яка PR трогающий wallet field в users profile (Phase 7) — required Legal Mode B review.

**Чому:** Wallet = identifier для crypto channel. Зміна wallet + збереження history = audit trail для Mode B. Якщо wallet changed без consent re-confirm — GDPR Art.6 violation (lawful basis missing).

**Decision rule (Mode B):**

- PR трогає `users.walletAddress` → Mode B with crypto-specific checklist.
- PR додає wallet update flow → требує consent re-confirmation UI + audit log entry.

## Anti-patterns

| ❌ Don't                                            | ✅ Do                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Радити USDT payout як production-ready solution     | Поясняти Закон 2074-IX status + feature_flag false до 10225-д активації |
| Skip KYC для crypto-транзакцій < 30k грн            | Все одно capture source of funds (audit-ready)                          |
| Радити ФОП-3 + USDT як «легальний bridge»           | Hard refuse — ДПС-заборона + 15% штраф                                  |
| Розглядати multi-issuer cash/crypto schemes         | Hard refuse + escalate до criminal defense lawyer                       |
| Радити cash-channel в IT-outsource                  | Hard refuse — NBU ліміт ₴10k/день + заборона FX-cash з нерезидентами    |
| Зміна wallet field без consent re-confirmation flow | Require consent re-confirm UI + audit log entry перед production deploy |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 4 substantive items #usdt #aml)
- Citations within patterns:
  - Закон 2074-IX «Про віртуальні активи» (17.02.2022, не введений)
  - Законопроект 10225-д (перше читання 03.09.2025)
  - Закон 361-IX (фінмоніторинг threshold 30k грн)
  - ст. 212 ККУ (податкове уклонення поріг ₴4.99M)
  - Постанова НБУ № 148 (cash NBU ліміт)
  - Постанова НБУ № 5 (24.02.2022 заборона FX-cash з нерезидентами)
- Related skills:
  - `ua-tax-compliance` (ФОП/ТОВ structure context)
  - `ua-it-contract` (wallet/payment requisites in contracts)
  - `legal-escalation-patterns` (hard refuse zone handling)
- Related agent docs:
  - `.claude/agents/legal.md` Mode A + Mode B
  - `.claude/agents/legal-escalation-zones.md` (если existing)
