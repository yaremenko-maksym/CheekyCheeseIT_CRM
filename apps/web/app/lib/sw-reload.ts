/**
 * Логика форс-перезагрузки страницы при смене Service Worker (controllerchange).
 *
 * После редеплоя VitePWA (autoUpdate + skipWaiting + clientsClaim) активирует
 * новый SW в фоне, но открытая вкладка продолжает работать на старом бандле в
 * памяти. Этот модуль задаёт чистую функцию принятия решения о перезагрузке и
 * экспортирует её для unit-тестирования отдельно от DOM-обвязки в client.tsx.
 *
 * Решение форс-reload'а принято владельцем осознанно:
 *   «больших / длинных форм нет — перезагрузка при редеплое не потеряет работу».
 */

export interface SWReloadOptions {
  /** true если на момент загрузки страницы уже был активный контроллер. */
  hadControllerAtLoad: boolean
  /** true если перезагрузка уже инициирована (защита от двойного fire). */
  alreadyReloading: boolean
}

/**
 * Решает, нужно ли перезагружать страницу при событии `controllerchange`.
 *
 * Правила:
 *   - Если контроллер отсутствовал при старте страницы → это первая установка
 *     SW (not an update), перезагрузка не нужна.
 *   - Если перезагрузка уже инициирована → не дублировать.
 *   - Иначе → перезагружаться.
 *
 * Чистая (детерминированная) функция без сайд-эффектов — DOM / window живут в client.tsx.
 */
export function shouldReloadOnControllerChange({
  hadControllerAtLoad,
  alreadyReloading,
}: SWReloadOptions): boolean {
  if (!hadControllerAtLoad) return false
  if (alreadyReloading) return false
  return true
}
