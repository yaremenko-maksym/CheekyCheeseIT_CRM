# Coder progress — task-onboarding-6a-data-backend

## State

- current_milestone: 0/10
- last_commit: (none yet)
- last_push: (none yet)
- files_done: []
- files_pending:
  - apps/api/drizzle/migrations/0027_onboarding.sql
  - apps/api/src/database/schema.ts
  - packages/shared/src/schemas/contracts.ts
  - packages/shared/src/schemas/tos.ts
  - packages/shared/src/schemas/onboarding.ts
  - packages/shared/src/schemas/index.ts
  - apps/api/src/contracts/contracts.module.ts
  - apps/api/src/contracts/contract-templates.controller.ts
  - apps/api/src/contracts/contract-templates.service.ts
  - apps/api/src/contracts/contract-templates.service.spec.ts
  - apps/api/src/contracts/signed-contracts.controller.ts
  - apps/api/src/contracts/signed-contracts.service.ts
  - apps/api/src/contracts/signed-contracts.service.spec.ts
  - apps/api/src/tos/tos.module.ts
  - apps/api/src/tos/tos.controller.ts
  - apps/api/src/tos/tos.service.ts
  - apps/api/src/tos/tos.service.spec.ts
  - apps/api/src/onboarding/onboarding.module.ts
  - apps/api/src/onboarding/onboarding.controller.ts
  - apps/api/src/onboarding/onboarding.service.ts
  - apps/api/src/onboarding/onboarding.service.spec.ts
  - apps/api/src/auth/onboarding.guard.ts
  - apps/api/src/auth/onboarding.guard.spec.ts
  - apps/api/src/app.module.ts
  - apps/api/src/database/seed.ts

## Payment-requisites column inventory (resolved via mcp**postgres**query)

- USDT: `wallet_usdt_erc20` (text, nullable), `wallet_usdt_label` (text, nullable)
- ФОП (UAH bank): `bank_uah_recipient`, `bank_uah_iban`, `bank_uah_rnokpp`, `bank_uah_bank_name` (все text nullable)
- Preferred method: `payment_method` enum (`USDT_ERC20` | `BANK_UAH_FOP` | NULL)

Mapping in `interpolateVariables`:

- `{{walletUsdt}}` ← `users.wallet_usdt_erc20` || `'не указано'`
- `{{bankUahFop}}` ← склейка `bank_uah_recipient`, `bank_uah_iban`, `bank_uah_rnokpp`, `bank_uah_bank_name` через ", " (если все null → `'не указано'`)
- `{{preferredMethod}}` ← `payment_method` (русский label: `'USDT (ERC-20)'` / `'ФОП (UAH)'` / `'не указано'`)

## Intent log

(populated by coder-intent.sh markers)
