/**
 * role-select.locale.test.tsx — task-i18n-stage3a (Task 1), Step 1.
 *
 * `useRoleLabel(role)` is the new canon for JSX role labels — it resolves
 * `ROLE_LABEL_MESSAGES[role]` against the ACTIVE catalog, so switching
 * locale changes what it returns without a remount. The legacy
 * `ROLE_LABELS: Record<Role, string>` export stays untouched (still a plain
 * string map) for the eight consumers outside this wave's perimeter — see
 * "Опасность: ROLE_LABELS" in the plan.
 *
 * Catalog access is through `loadCatalog`/`I18nTestProvider` (SPEC-H-1) —
 * the ONLY working path; `@crm/shared/i18n/locales/...` does not resolve.
 */
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { useRoleLabel } from '../role-select'

describe('useRoleLabel', () => {
  it('translates ADMIN per active locale', async () => {
    await loadCatalog('uk')
    const { result: uk } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
    expect(uk.current).toBe('Адміністратор')
    await loadCatalog('en')
    const { result: en } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
    expect(en.current).toBe('Admin')
  })

  it('leaves the legacy ROLE_LABELS export untouched (type: string) for not-yet-migrated consumers', async () => {
    const { ROLE_LABELS } = await import('../role-select')
    expect(typeof ROLE_LABELS.ADMIN).toBe('string')
  })
})
