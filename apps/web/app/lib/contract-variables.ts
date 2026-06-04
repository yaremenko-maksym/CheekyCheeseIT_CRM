/**
 * Re-export from @crm/shared — single source of truth for contract variable
 * placeholders. Both the backend interpolation (SignedContractsService) and
 * this frontend hint panel now reference the same canonical map.
 *
 * @deprecated Use CONTRACT_VARIABLE_DESCRIPTIONS from '@crm/shared' directly.
 * This re-export exists only for backward compatibility during the transition.
 */
export { CONTRACT_VARIABLE_DESCRIPTIONS as CONTRACT_VARIABLES } from '@crm/shared'
