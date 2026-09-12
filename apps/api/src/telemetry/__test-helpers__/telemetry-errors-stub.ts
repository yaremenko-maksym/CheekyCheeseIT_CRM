/**
 * Молчаливая заглушка `TelemetryErrorsService` для спек, которым канал
 * телеметрии безразличен.
 *
 * Заведена вместе с SR-H-1 (PR #664, круг 1): `NotificationsService` получил
 * второй параметр конструктора, а конструируют его напрямую три десятка спек.
 * Заглушка держится рядом с самим сервисом — по образцу
 * `notifications/__test-helpers__/notifications-stub.ts` и по той же причине:
 * следующая правка поверхности чинится в одном месте, а не в тридцати.
 *
 * Зависимость НЕ сделана опциональной (`@Optional()`) по тому же доводу, что
 * записан в соседней заглушке: забытая проводка модуля давала бы молчаливое
 * «ошибки просто не доезжают до телеметрии», то есть отказ канала
 * наблюдаемости, который никто не заметит. Обязательный параметр ломается
 * громко — в `app.module.container.spec.ts`, поднимающем реальный граф.
 */
import { vi } from 'vitest'
import type { TelemetryErrorsService } from '../telemetry-errors.service'

export function makeTelemetryErrorsStub(): TelemetryErrorsService {
  return {
    recordError: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelemetryErrorsService
}
