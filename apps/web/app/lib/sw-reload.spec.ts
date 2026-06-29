import { describe, expect, it } from 'vitest'
import { shouldReloadOnControllerChange } from './sw-reload'

describe('shouldReloadOnControllerChange', () => {
  it('returns false on first-ever SW install (no controller at load)', () => {
    // Страница открылась без SW — это первая установка, не обновление.
    expect(
      shouldReloadOnControllerChange({ hadControllerAtLoad: false, alreadyReloading: false }),
    ).toBe(false)
  })

  it('returns true when a new SW takes over an already-controlled page', () => {
    // Контроллер был при загрузке + поменялся → редеплой → перезагружаемся.
    expect(
      shouldReloadOnControllerChange({ hadControllerAtLoad: true, alreadyReloading: false }),
    ).toBe(true)
  })

  it('returns false on double-fire to prevent reload loop', () => {
    // controllerchange иногда стреляет дважды — не перезагружаем повторно.
    expect(
      shouldReloadOnControllerChange({ hadControllerAtLoad: true, alreadyReloading: true }),
    ).toBe(false)
  })

  it('returns false when no controller and already reloading (edge case)', () => {
    expect(
      shouldReloadOnControllerChange({ hadControllerAtLoad: false, alreadyReloading: true }),
    ).toBe(false)
  })
})
