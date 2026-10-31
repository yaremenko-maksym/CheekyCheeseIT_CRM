/**
 * Логика отложенной перезагрузки страницы при смене Service Worker (controllerchange).
 *
 * После редеплоя VitePWA (autoUpdate + skipWaiting + clientsClaim) активирует
 * новый SW в фоне, но открытая вкладка продолжает работать на старом бандле в
 * памяти. Этот модуль задаёт чистую функцию принятия решения о перезагрузке и
 * экспортирует её для unit-тестирования отдельно от DOM-обвязки в client.tsx.
 *
 * Перезагрузка откладывается, пока вкладка видима: ~6 деплоев в день + устаревший
 * precache-shell давали reload через 2-3 с после открытия и посреди работы на телефонах.
 * Reload выполняется, когда вкладка уходит в фон (visibilityState === 'hidden').
 */

export interface SWReloadOptions {
  /** true если на момент загрузки страницы уже был активный контроллер. */
  hadControllerAtLoad: boolean
  /** true если перезагрузка уже инициирована (защита от двойного fire). */
  alreadyReloading: boolean
  /** true если вкладка сейчас видима — перезагрузка не должна прерывать работу. */
  pageVisible: boolean
}

/**
 * Решает, можно ли перезагружать страницу сейчас (после `controllerchange`).
 *
 * Правила:
 *   - Если контроллер отсутствовал при старте страницы → это первая установка
 *     SW (not an update), перезагрузка не нужна.
 *   - Если перезагрузка уже инициирована → не дублировать.
 *   - Если страница видима → не перезагружать (отложить до скрытия вкладки).
 *   - Иначе → перезагружаться.
 *
 * Чистая (детерминированная) функция без сайд-эффектов — DOM / window живут в client.tsx.
 */
export function shouldReloadOnControllerChange({
  hadControllerAtLoad,
  alreadyReloading,
  pageVisible,
}: SWReloadOptions): boolean {
  if (!hadControllerAtLoad) return false
  if (alreadyReloading) return false
  if (pageVisible) return false
  return true
}
