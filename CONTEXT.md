# CheekyCheeseIT CRM — project language

Domain glossary. **Only** terms specific to this business: if a concept is general to programming
(timeout, cache, hook), it does not belong here.

Usage rules:

- A term from `_Avoid_` in a PR body, a variable name, a test name or an agent report is a **review
  finding**, not a stylistic remark. We chose one word deliberately.
- The Russian term is for communication and reports; the identifier in parentheses is how it is
  named in code. Different languages, one concept; we do not introduce synonyms in either of them.
- Since 2026-09-19 the product is bilingual (`uk` default / `en`, spec `docs/superpowers/specs/2026-09-19-crm-i18n-design.md`):
  each term will gain `uk` and `en` forms — added by the first PR of stage 3 (`web-core`), and those are
  the source for the Lingui catalogs and for `copy-reviewer`. Until then the Russian form remains the glossary's language.
- A concept is missing here but needed — that is a signal: either a language the project does not have
  is being invented (reconsider), or a real gap (add it here in the same PR).

Implementation, phases, migrations, the RBAC matrix — **not here**, but in `.claude/agents/project-state.md`.
This file is not a spec and not a scratchpad: it is a glossary and nothing more.

---

## People and roles

**Role** (product term: «Роль»; `roleEnum`):
One of six: `ADMIN`, `SENIOR`, `JUNIOR`, `HR`, `ACCOUNTANT`, `DROP`. A role determines both
permissions (RBAC) and a place in the money flows.
_Avoid_: «пермишен», «уровень доступа», «тип пользователя»

**Drop** (product term: «Дроп»; `DROP`):
A payment-routing role: a person through whose payment details the project's money passes. Not a
«fake employee» and not a substitution of a contract party — a drop has its own share and its own
obligations.
_Avoid_: «подставное лицо», «номинал», «прокси»

**Legend** (product term: «Легенда»; `legends`, `legendEntries`):
A per-project set of facts that a junior sees instead of the real ones. The masking is built as an
**allow-list**, not a deny-list: a new surface is hidden by default.
_Avoid_: «маска», «фейк-данные», «подмена»

**Legal name** (product term: «Юридическое имя»):
The full legal name under which a person signs a contract. Set by an admin. It differs from the
display name in the platform, and it is exactly this name that goes into the contract.
_Avoid_: «display name», «никнейм», «имя в системе»

## Money

**Transaction** (product term: «Транзакция»; `transactions`):
A single line of money movement with a type (`transactionTypeEnum`) and a status
(`transactionStatusEnum`). The unit of accounting: balances are not stored but computed from transactions.
_Avoid_: «платёж», «проводка», «запись баланса»

**Obligation** (product term: «Обязательство»; `pendingObligations`):
A debt that is recognized but not yet paid: it has a creditor, a debtor type (`COMPANY` for new
rows) and a lifecycle `PENDING → PAID | CANCELLED`. While `PENDING`, the creditor's balance **does
not move**. It is closed by a transaction, referenced by `closingTransactionId`.
_Avoid_: «долг», «IOU», «начисление», «pending-строка»

**Payout request** (product term: «Заявка на выплату»; `payoutRequests`):
A senior's request to withdraw validated income. Two statuses: `PENDING` (created) and `PAID`
(txHash provided, auto-transactions created).
_Avoid_: «вывод средств», «реквест», «withdrawal»

**Income validation** (product term: «Валидация дохода»):
An accountant's or admin's confirmation of income declared by a senior/drop: `PENDING → VALIDATED`.
Before validation a payout cannot be created, and a junior's salary for the month stays `LOCKED`.
_Avoid_: «аппрув дохода», «подтверждение платежа», «проверка транзакции»

**Settlement** (product term: «Расчёт»; settle):
Closing an obligation by a payment. It triggers a cascade: a closing transaction, a recomputation
of balances, a snapshot of the amount at the moment of settlement.
_Avoid_: «погашение», «закрытие долга», «выплата» (the latter already has its own meaning — `PAYOUT`)

**Drop share** (product term: «Доля дропа»; `dropShare`, `resolveDropShare`):
The percentage of a project due to the drop. Taken from the project settings, can be overridden
pointwise; the resolver is the only place where this is decided.
_Avoid_: «процент дропа», «комиссия», «ставка»

**Senior share** (product term: «Доля синьора»; `seniorSharePercent`, `resolveSeniorShare`):
The percentage of a project or the personal percentage due to the senior. The resolver checks three
levels in descending priority — project → team → the senior's personal percentage (labeled
«(по умолчанию)» in the interface) — and takes the first one set. The project value in the interface
is «индивидуальная доля по проекту».
A change at the project or personal level (not the team one — that applies immediately) does not take
effect until the senior themselves confirms it: until confirmation the previous value applies, and the
proposed one is visible as «Предложено N%» only to ADMIN and to the senior themselves. ACCOUNTANT and
HR see the effective share (they need it for calculations) but do not learn that a change was proposed at all.
_Avoid_: «процент синьора», «ставка синьора», «комиссия синьора», «переопределение», «override»

**Project payment type** (product term: «Тип оплаты проекта»; `projectPaymentTypeEnum`):
`FOP` | `GIG_CONTRACT` | `USDT`. Determines **who declares income**: on `FOP` and `GIG_CONTRACT` —
the senior or the drop, on `USDT` — only the admin.
_Avoid_: «способ оплаты» (that is `paymentMethodEnum` — the recipient's payment details, a different concept)

**Payout method** (product term: «Способ выплаты»; `paymentMethodEnum`):
`USDT_ERC20` | `BANK_UAH_FOP` — the payment details by which a person receives money. Not to be
confused with the project payment type.
_Avoid_: «платёжный метод», «канал оплаты»

**Company account** (product term: «Счёт компании»; `companyAccount`):
A shared USDT wallet. A deposit (`COMPANY_DEPOSIT`) is declared with a link to a transaction and
verified via Etherscan: it stays `PENDING` until confirmations accumulate **and** the recipient
matches the company wallet. There are no smart contracts — verification is external.
_Avoid_: «общий баланс», «казна», «кошелёк ТОВ»

**Dividend** (product term: «Дивиденд»; `DIVIDEND_TO_ADMIN`):
A distribution from the company account to an admin's balance. Accompanied by `DIVIDEND_TAX` — a
tax that debits only the company account.
_Avoid_: «выплата админу», «доля учредителя»

## Work

**Project** (product term: «Проект»; `projects`):
A unit of work with a client: it has a set of members, a payment type and financial settings.
_Avoid_: «контракт» (that is a document), «заказ», «клиент»

**Project approval status** (product term: «Статус согласования проекта»; `status`):
`DRAFT` — «Ждёт решения», `REJECTED` — «Отклонён», `ACTIVE` — «Активный»; the archive (`archivedAt`)
overrides everything regardless of status — «В архиве». One label per status everywhere it labels a
specific project (a list row, a project page header). The section that collects such projects is
named in the plural — «Ждут решения» (left navigation, `/pending`).
_Avoid_: «Отклонено» (the neuter gender does not agree with «проект»), «На подтверждении», «Черновик» —
for these project states

**Members** (product term: «Состав»; `projectMembers`):
Who participates in a project. A drop's membership is determined by the project's `dropId` field,
**not** by a row in the members list — these are different mechanisms, and confusing them is costly.
_Avoid_: «команда проекта» («команда» has its own entity `teams`), «участники»

**Interview** (product term: «Собеседование»; `interviews`):
A candidate on the kanban with a stage (`interviewStageEnum`). A stage is the candidate's state, not a task.
_Avoid_: «интервью», «кандидат» (a candidate is a person, an interview is a process)

**Vacancy** (product term: «Вакансия»; `vacancies`):
A position published on the landing with a domain, a level and an employment type. An application to
it — `vacancyApplications`.
_Avoid_: «позиция», «джоба»

**Job source** (product term: «Источник вакансий»; `jobSources`):
An external feed from which `jobPostings` arrive; the filtered and scored ones become `jobSuggestions`
— a suggestion to the recruiter.
_Avoid_: «парсер», «скрапер», «интеграция»

## Documents

**Invoice** (product term: «Счёт»; `invoices`, `invoiceSignatures`):
A payment document with two signing parties (`COMPANY` and `COUNTERPARTY`) and a signing method
(automatic from the company or a manual click).
_Avoid_: «инвойс», «акт», «платёжка»

**Contract template** (product term: «Шаблон договора»; `contractTemplates`) and **signed contract** (product term: «подписанный договор»; `signedContracts`):
A template carries placeholders (standard plus custom for a specific template); a signed contract is
the result of substituting values. These are two different entities, not two states of one.
_Avoid_: «договор» in general (clarify — a template or a signed one)

**Employee contract** (product term: «Контракт сотрудника»; `employeeContracts`):
A document between the company and an employee, which the employee signs during onboarding. Statuses:
`DRAFT → READY_TO_SIGN → SIGNED`, plus the terminal `CANCELLED`. A third entity alongside the
«template / signed contract» pair, not their state: it has its own lifecycle and its own addressee.
_Avoid_: «договор с сотрудником», «документ на подпись»

---

## `uk`/`en` forms

Canonical term forms by i18n wave (a — `web-core`, b — `web-people`, c — `web-projects`,
d — `web-finance`, e — `web-docs-notify`), typography (apostrophe, quotation marks, «Could not …») and
the «added in PR …» history — in the journal `docs/i18n/context-glossary-journal.md`. It is not a
dictionary, so it does not live here; a divergence of a catalog from the journal on a term form is a
`copy-reviewer` finding.

---

## Relationships

- A **project** has one **payment type**, and it decides who declares income.
- **Income validation** precedes a **payout request**; a request spawns **transactions**.
- An **obligation** lives separately from a **transaction** and is closed by a **settlement**.
- A **drop** receives a **drop share** and can be the creditor of an **obligation** whose debtor is
  the company.
- A **legend** is bound to a **project**, not to a user.

## Flagged ambiguities

- **«Выплата»** used to mean both `PAYOUT` (a senior pays the company) and «give money to a person».
  Resolved: `PAYOUT` is only the former; the latter is called a **settlement** (settle).
- **«Долг»** meant both the obligation in the table and a historical value from the accounting import.
  Resolved: the entity is an **obligation**; historical import values are not the term.
- **`DROP` / `TOV` in the debtor type** (`pendingObligationDebtorTypeEnum`) — legacy values for rows
  from before the refactor. New obligations are always `COMPANY`. The values are kept for history, not
  as a choice.
