/**
 * Role-scope gate (spec `2026-11-19-role-ai-spend-design.md` §2): decides whether a vacancy the rule
 * left unclassified is worth a role-AI call for the current roster. `PENDING` = send to the AI;
 * `OUT_OF_SCOPE` = terminal, hidden like PENDING, never fetched or classified. Inputs are title +
 * `stack_keywords` + the layer-1 verdict + the roster only, never the description (owner decision).
 *
 * Versioning: OUT_OF_SCOPE rows are re-gated only by the SENIOR roster fan-out or a classifier bump,
 * so ANY change to the signal lists here or the classifier lists this reads (`TECH_HINTS`,
 * `EQ_BOARD_CATEGORIES`, `GENERIC_KEYWORDS`) must bump `ROLE_CLASSIFIER_VERSION`.
 */
import { widenRoles, type SeniorSelectableRole, type TechnicalRole } from '@crm/shared'
import { EQ_BOARD_CATEGORIES, GENERIC_KEYWORDS, TECH_HINTS } from './role-classifier'

export type ScopeGateInput = {
  title: string
  tags: readonly string[]
  layer1Rejected: boolean
  reachable: ReadonlySet<TechnicalRole>
}

const L = String.raw`[\p{L}\p{N}_]`

/**
 * A title naming a non-software engineering field, or an IT specialty other than general software
 * engineering (data, security, devops, qa, …: a rule role a generic SOFTWARE_ENGINEER senior does not
 * cover), closes the generic branch; a tech hint or a board tag still passes. English terms are
 * bounded on both sides (`rf` must not fire inside "performance"); German stems are unbounded, since
 * German glues them into compounds (`elektrotechnik`, `instandhaltungsingenieur`).
 */
const NON_SOFTWARE_ENGINEERING = new RegExp(
  String.raw`(?<!${L})(mechanic(al)?|electric(al)?|civil|chemical|process|structural|hvac|field|customer|gtm|go[\s-]to[\s-]market|technician|estimat\p{L}*|photonics?|layout|controls?|propulsion|manufacturing|production|quality|construction|power|rf|hardware|sales|solutions?|support|maintenance|service|medical|assurance|cell culture|airspace|timber|immobilier|real estate|design engineer|applications engineering|program manager|graduates?|network|security|data|ml|machine learning|ai|devops|cloud|site reliability|test|qa|automation)(?!${L})|elektro|maschinen|instandhaltung|wartung|hardware`,
  'u',
)

/** Every role a vacancy may carry and still reach a senior: one hop of widening, per senior. */
export function reachableRoles(
  profiles: readonly { roles: readonly SeniorSelectableRole[] }[],
): ReadonlySet<TechnicalRole> {
  return new Set(profiles.flatMap((p) => [...widenRoles(p.roles)]))
}

export function roleScopeGate(input: ScopeGateInput): 'PENDING' | 'OUT_OF_SCOPE' {
  const { reachable } = input
  if (input.layer1Rejected || reachable.size === 0) return 'OUT_OF_SCOPE'
  const t = input.title.toLowerCase()
  const hints = TECH_HINTS.filter(({ pattern }) => pattern.test(t))
  const hintOrTagHit =
    hints.some(({ role }) => role !== null && reachable.has(role)) ||
    input.tags.some((tag) => {
      const role = EQ_BOARD_CATEGORIES.get(tag.trim().toLowerCase())
      return role !== undefined && reachable.has(role)
    })
  const genericHit =
    reachable.has('SOFTWARE_ENGINEER') &&
    (GENERIC_KEYWORDS.some((p) => p.test(t)) || hints.some(({ role }) => role === null)) &&
    !NON_SOFTWARE_ENGINEERING.test(t)
  return hintOrTagHit || genericHit ? 'PENDING' : 'OUT_OF_SCOPE'
}
