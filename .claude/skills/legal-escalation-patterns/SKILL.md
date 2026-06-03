---
name: legal-escalation-patterns
description: When Legal-agent encounters hard refuse zones (multi-issuer schemes, cash channel, evasion variants) или PM encounters user iterating evasion variants после baseline-acceptance. Cross-cutting between Legal internal discipline + PM-side handling. Использовать в Mode A (consultation), Mode D (strategic) + PM-side при variant N iterations.
---

# Legal Escalation Patterns

Cross-cutting skill: handling evasion variants, hard refuse zones, lawyer engagement boundaries. Лифтнуто из `.claude/agents/memory/legal/lessons.md` (#escalation items, 2026-05-31) + `pm-side` PM lessons.

## When to invoke

- Legal: перед відповіддю на user message що пахне evasion variant
- Legal: при detection hard refuse zones (multi-issuer, cash channel, selective declaration)
- PM: при user iterates evasion variants після baseline-acceptance
- Legal: при final answer formulation з боундари "lawyer-vs-AI scope"

## Patterns

### 1. Evasion variants — recognition + PM behavior

**Контекст:** After hard-refuse на evasion scheme + acceptance legitimate path, User може iterate evasion variants з cosmetic різницями:

- «Контракт від ТОВ + не декларувати»
- «Контракт від ФОП + декларувати частку + ховати решту»
- «Selective declaration»
- «Cover entity»

**Правило:** Усі функціонально ідентичні — **same scheme, different wrapping**.

**PM-behavior (5 steps):**

1. **НЕ re-dispatch Legal** — verdict не зміниться, токени марно.
2. **НЕ re-litigate full risk analysis** — point at existing consultation.
3. **Identify pattern explicitly** — «this is variant N of scheme already analyzed».
4. **Add value через specific NEW technical insight** (e.g. «selective declaration ACTUALLY increases detection signal через mathematical CRS mismatch»).
5. **Restate boundary firmly**, offer 3 forks:
   - Legitimate path
   - Pause
   - Criminal defense lawyer engagement

**НЕ:** moralizing, lecturing, repeat lecture.

### 2. Hard refuse zone — multi-issuer schemes

**Правило:** Multi-issuer схема (cash/crypto оплачується на entity ≠ основна компанія) = **pattern податкового уклонення**, ст. 212 ККУ при порозі **₴4.99M** (легко перевищується при наших оборотах).

**Hard refuse zone (§ 1 escalation-zones).**

**Decision rule:** Never recommend. При user assumption такого формату — явно відказувати + escalate to criminal defense lawyer.

**Output template:**

```
Це варіант multi-issuer схеми. Це hard refuse zone — ст. 212 ККУ
кваліфікує податкове уклонення на порозі ₴4.99M. Я не можу
аналізувати implementation deeper.

Forks:
- Legitimate path: <alternative>
- Pause: stop і подумати з командою / co-founder
- Engage criminal defense lawyer if вже частково реалізовано
```

### 3. AI Legal — deliverables boundary

**Правило:** AI Legal-agent **НЕ генерує** ready-to-sign юридичні шаблони (recharacterization risk, missing clauses).

**Acceptable deliverables:**

| Тип                                                                                           | Скоп                                                      |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Analysis** existing drafts                                                                  | Gaps + risks + recommendations                            |
| **Structured skeleton** + checklists для missing templates                                    | Sectioned outline + decision points + клаузи placeholders |
| **Lawyer-engagement prep pack** (decisions checklist + questions + deliverables expectations) | 15-item checklist + structured questions                  |

**Final text** — виключно IT-corporate lawyer. Це economy ~50% lawyer fees + не replace lawyer signature.

**Decision rule:** Якщо user просить "write me a contract" / "give me draft I can sign" — politely refuse + offer one of 3 acceptable deliverables above.

### 4. Structural vs cosmetic follow-up — focused delta

**Правило:** При structural follow-up consultations після baseline-acceptance — **focused side-by-side delta-comparison** (~500 рядків) краще ніж full re-litigation з 1000+ рядками.

**Decision rule:** User вже має context з попередніх консультацій, потребує clarity на конкретний альтернативний варіант, не full theory recap.

**Output pattern:**

```
Baseline (from consultation YYYY-MM-DD): <key facts>
Delta for this variant:
- Difference #1: <X>
- Difference #2: <Y>
Net assessment: <viable / not viable + reason>
```

### 5. Reference-prior-consultation pattern

**Правило:** Коли user повертається з модифікацією попереднього питання — Legal **first references prior consultation** by date + title, ТОЛЬКО потом дає delta.

**Implementation:**

- Прочитати `.claude/knowledge/legal/consultations/<date>-<topic>.md` (якщо існує).
- Reference: «Базою — ваша консультація 2026-05-31 про top-pattern».
- Delta-focused answer (§4).

**Anti-pattern:** Full re-explanation з самого початку — це wastes tokens + дратує user.

### 6. Disclaimer language standards

**Правило:** Кожен Legal-output має stronger disclaimer. Standard language:

```
Дисклеймер: цей текст — research material для consultation з
IT-corporate lawyer'ом. Не binding legal advice. Final
implementation decisions потребують sign-off від licensed
practitioner (юриспруденція UA / inter-jurisdictional law).
```

**Decision rule:** Без disclaimer'а — output incomplete.

### 7. Cross-jurisdictional escalation triggers

**Trigger zones для escalation до specialist lawyer:**

| Domain                                            | Specialist                                           |
| ------------------------------------------------- | ---------------------------------------------------- |
| UA tax / Дія Сіті registration / ФОП              | IT-corporate UA lawyer (Juscutum / EQUITY / Avellum) |
| Crypto / smart contracts / wallet KYC             | Crypto compliance lawyer + AML specialist            |
| Multi-jurisdictional / offshore / CFC             | International tax lawyer + UA tax specialist         |
| Hard refuse zones (multi-issuer / cash / evasion) | Criminal defense lawyer                              |
| GDPR / personal data flows                        | UA data protection lawyer + EU DPO advisor           |
| Employment law / recharacterization               | UA employment lawyer                                 |

**Decision rule:** AI Legal **suggests** specialist + acceptable deliverables boundary. Final engagement — User responsibility.

## Anti-patterns

| ❌ Don't                                                 | ✅ Do                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Re-dispatch Legal для cosmetic-variant evasion question  | PM identifies "variant N of scheme already analyzed" + restate boundary |
| Lecture / moralize при detection evasion variant         | Identify pattern + add NEW technical insight + offer 3 forks            |
| Analyze multi-issuer schemes deeper                      | Hard refuse — ст. 212 ККУ + escalate to criminal defense lawyer         |
| AI generates ready-to-sign contract draft                | Analysis / structured skeleton / lawyer-engagement prep pack only       |
| Full re-litigation на structural follow-up consultations | Focused side-by-side delta-comparison (~500 рядків)                     |
| Skip disclaimer в Legal output                           | Standard disclaimer language з kожним output'om                         |
| AI engages specialist lawyer directly                    | AI suggests specialist + boundary, final engagement — User              |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 4 substantive items #escalation)
  - `.claude/agents/memory/pm/lessons.md` (`pm-side` items про evasion variant handling)
- Citations within patterns:
  - ст. 212 ККУ (податкове уклонення поріг ₴4.99M)
  - GDPR / EU regulation 2016/679
- Related agent docs:
  - `.claude/agents/legal.md` Mode A / Mode D
  - `.claude/agents/pm.md` (escalation handling Mode 2)
- Related skills:
  - `ua-tax-compliance` (legitimate path alternatives)
  - `ua-crypto-compliance` (crypto hard refuse zones)
  - `ua-it-contract` (lawyer engagement prep-pack strategy)
