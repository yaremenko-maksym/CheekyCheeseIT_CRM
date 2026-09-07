/**
 * Молчаливая заглушка NotificationsService для спек, которым производитель
 * уведомлений безразличен.
 *
 * task-notification-types-producers (позиция 6) добавила зависимость от
 * `NotificationsService` в пять модулей-производителей. Спек, конструирующих
 * эти сервисы напрямую, — десятки, и почти все проверяют совсем другое.
 * Заглушка держится ЗДЕСЬ, рядом с самим сервисом, чтобы следующее изменение
 * его поверхности правилось в одном месте, а не в двадцати спеках.
 *
 * Зависимость НЕ сделана опциональной (`@Optional()`) намеренно: тогда
 * забытая проводка в модуле давала бы молчаливое «уведомления просто не
 * приходят» — ровно тот fail-open-by-omission, о котором предупреждает
 * комментарий MED-2 в `teams.service.ts`. Обязательный параметр ломает
 * компиляцию сразу и громко.
 */
import { vi } from 'vitest'
import type { NotificationsService } from '../notifications.service'

export function makeNotificationsStub(): NotificationsService {
  return {
    create: vi.fn().mockResolvedValue(null),
    createInTx: vi.fn().mockResolvedValue(null),
    createManyInTx: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService
}
