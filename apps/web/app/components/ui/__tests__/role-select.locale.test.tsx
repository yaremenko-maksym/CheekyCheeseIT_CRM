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
import { describe, expect, it, vi } from 'vitest'
import { render, renderHook, screen } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { useRoleLabel, RoleSelect } from '../role-select'

describe('useRoleLabel', () => {
  it('translates ADMIN per active locale', async () => {
    await loadCatalog('uk')
    const { result: uk } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
    expect(uk.current).toBe('Адміністратор')
    await loadCatalog('en')
    const { result: en } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: I18nTestProvider })
    expect(en.current).toBe('Admin')
  })

  // MUT-1 (fix-round 2): only ADMIN was ever exercised — JUNIOR and
  // ACCOUNTANT's own `msg\`...\`` entries in `ROLE_LABEL_MESSAGES` could be
  // mutated to empty with no test noticing.
  it('translates JUNIOR and ACCOUNTANT per active locale', async () => {
    await loadCatalog('uk')
    const { result: junior } = renderHook(() => useRoleLabel('JUNIOR'), {
      wrapper: I18nTestProvider,
    })
    expect(junior.current).toBe('Джуніор')
    const { result: accountant } = renderHook(() => useRoleLabel('ACCOUNTANT'), {
      wrapper: I18nTestProvider,
    })
    expect(accountant.current).toBe('Бухгалтер')
  })

  it('leaves the legacy ROLE_LABELS export untouched (type: string) for not-yet-migrated consumers', async () => {
    const { ROLE_LABELS } = await import('../role-select')
    expect(typeof ROLE_LABELS.ADMIN).toBe('string')
  })
})

// MUT-1 (fix-round 2): `RoleSelect`/`RoleLabel` themselves had ZERO render
// tests before this round — only the standalone `useRoleLabel` hook was
// exercised.
describe('RoleSelect', () => {
  it('defaults the trigger aria-label to "Роль" when no ariaLabel prop is given', async () => {
    await loadCatalog('uk')
    render(<RoleSelect value="SENIOR" onChange={vi.fn()} />, { wrapper: I18nTestProvider })
    expect(screen.getByRole('combobox', { name: 'Роль' })).toBeInTheDocument()
  })

  it('uses a caller-supplied ariaLabel instead of the default', async () => {
    await loadCatalog('uk')
    render(<RoleSelect value="SENIOR" onChange={vi.fn()} ariaLabel="Роль співробітника" />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByRole('combobox', { name: 'Роль співробітника' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Роль' })).not.toBeInTheDocument()
  })

  it('renders the current value’s translated label inside the trigger badge (RoleLabel)', async () => {
    await loadCatalog('uk')
    render(<RoleSelect value="JUNIOR" onChange={vi.fn()} />, { wrapper: I18nTestProvider })
    expect(screen.getByText('Джуніор')).toBeInTheDocument()
  })
})
