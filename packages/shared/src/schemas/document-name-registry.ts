import type { MessageDescriptor } from '@lingui/core'
import type { ContractNameKind } from './documents'

/**
 * i18n server-text PR2. The catalog of virtual employee-contract document
 * names: the server emits `nameKind` + `contractNumber` (`documents.ts`), the
 * client renders `CONTRACT_NAME_MESSAGES[kind]` through the shared
 * `renderMessage` (`notification-registry.ts` — the one renderer) in the
 * VIEWER's locale.
 *
 * Same shape as `PENDING_TITLE_MESSAGES`: `/* i18n *\/`-marked explicit-id
 * literals as object property values (the only form `lingui extract` sees),
 * `satisfies` (not `as const`) for exhaustiveness against `ContractNameKind`.
 * The contract number is a code, substituted untouched — no case agreement.
 */
export const CONTRACT_NAME_MESSAGES = {
  CONTRACT_SIGNED: /* i18n */ {
    id: 'document.contractName.CONTRACT_SIGNED',
    message: 'Трудовий договір {contractNumber}',
  },
  CONTRACT: /* i18n */ {
    id: 'document.contractName.CONTRACT',
    message: 'Трудовий договір',
  },
  CONTRACT_TO_SIGN: /* i18n */ {
    id: 'document.contractName.CONTRACT_TO_SIGN',
    message: 'Трудовий договір (очікує підпису)',
  },
  CONTRACT_DRAFT: /* i18n */ {
    id: 'document.contractName.CONTRACT_DRAFT',
    message: 'Трудовий договір (чернетка)',
  },
} satisfies Record<ContractNameKind, MessageDescriptor>
