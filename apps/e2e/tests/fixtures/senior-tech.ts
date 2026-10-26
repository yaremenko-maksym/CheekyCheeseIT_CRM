import type { Locator, Page } from '@playwright/test'
import { assertInCatalog, loadMessages } from '../../fixtures/catalog'

/**
 * A SENIOR needs at least 3 distinct technologies (`SENIOR_MIN_TECHNOLOGIES` in
 * @crm/shared); the create forms block submit below that. Three technologies
 * from different families, so no alias collapses two of them into one.
 */
export const SENIOR_TECH_STACK = ['Rust', 'Elixir', 'Haskell'] as const

/** The chip input of a user form (UserDialog, HR create-senior dialog, self-edit). */
export async function techStackInput(scope: Page | Locator): Promise<Locator> {
  const uk = await loadMessages('uk')
  return scope.getByPlaceholder(assertInCatalog(uk, 'Почніть вводити: React, Node.js…'))
}

/** Adds technologies as chips (Enter commits the highlighted suggestion or the typed text). */
export async function addTechnologies(
  scope: Page | Locator,
  techs: readonly string[] = SENIOR_TECH_STACK,
): Promise<void> {
  const input = await techStackInput(scope)
  for (const tech of techs) {
    await input.fill(tech)
    await input.press('Enter')
  }
}
