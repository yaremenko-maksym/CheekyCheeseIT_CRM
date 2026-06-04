/**
 * Re-export from @crm/shared — single source of truth for contract variable
 * placeholders displayed in the admin hint panel (braced form: `{{key}}`).
 *
 * Use CONTRACT_VARIABLE_DESCRIPTIONS_BRACED (braced keys) for template authoring UI.
 * Use CONTRACT_VARIABLE_DESCRIPTIONS (bare keys) for type derivation / backend logic.
 */
export {
  CONTRACT_VARIABLE_DESCRIPTIONS_BRACED as CONTRACT_VARIABLES,
  CONTRACT_VARIABLE_DESCRIPTIONS,
} from '@crm/shared'
