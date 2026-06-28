// Guard для авто-перезагрузки при `vite:preloadError` (см. app/client.tsx).
//
// После редеплоя открытая вкладка с устаревшим shell-ом пытается загрузить
// удалённые lazy-чанки → `vite:preloadError`. Перезагрузка страницы подхватывает
// свежий shell. Чтобы не зациклиться на РЕАЛЬНО битом деплое (чанк отсутствует,
// а не просто stale), решение перезагружаться ограничено двумя осями:
//   • throttle по времени — перезагрузка не чаще раза в THROTTLE_MS;
//   • cap по числу — не более MAX перезагрузок за эпизод.
// Чистая функция вынесена сюда, чтобы покрыть логику unit-тестами; обвязка вокруг
// sessionStorage / window живёт в client.tsx.

export const PRELOAD_RELOAD_TS_KEY = 'vite-preload-reload-ts'
export const PRELOAD_RELOAD_COUNT_KEY = 'vite-preload-reload-count'

/** Перезагрузка не чаще раза в ~10 секунд. */
export const PRELOAD_RELOAD_THROTTLE_MS = 10_000
/** Максимум перезагрузок за эпизод — backstop против реально битого деплоя. */
export const PRELOAD_RELOAD_MAX = 3
/**
 * «Тишина» после успешного маунта, по истечении которой guard гасится (эпизод
 * закрыт, будущий редеплой восстановится заново). Заведомо больше THROTTLE_MS×MAX,
 * чтобы на битом деплое cap успел накопиться и остановить цикл ДО сброса.
 */
export const PRELOAD_RELOAD_RESET_MS = 60_000

export interface PreloadReloadState {
  /** ms-epoch последней перезагрузки (0 — перезагрузок ещё не было). */
  last: number
  /** Число перезагрузок в текущем эпизоде. */
  count: number
}

export interface PreloadReloadDecision {
  /** Нужно ли перезагрузить страницу. */
  shouldReload: boolean
  /** Значение счётчика для сохранения, если перезагружаемся. */
  nextCount: number
}

export interface PreloadReloadOptions {
  throttleMs?: number
  max?: number
}

/**
 * Решает, перезагружаться ли при `vite:preloadError`, по текущему состоянию guard'а.
 * Чистая (детерминированная по `now` + `state`), без сайд-эффектов.
 */
export function decidePreloadReload(
  now: number,
  state: PreloadReloadState,
  options: PreloadReloadOptions = {},
): PreloadReloadDecision {
  const throttleMs = options.throttleMs ?? PRELOAD_RELOAD_THROTTLE_MS
  const max = options.max ?? PRELOAD_RELOAD_MAX

  // throttle: слишком частые перезагрузки гасим (снимает burst из нескольких
  // одновременных preload-ошибок на одной загрузке + не даёт тугой цикл).
  if (now - state.last < throttleMs) {
    return { shouldReload: false, nextCount: state.count }
  }
  // cap: на реально битом деплое после MAX перезагрузок сдаёмся, показываем
  // ошибочное состояние вместо бесконечного цикла.
  if (state.count >= max) {
    return { shouldReload: false, nextCount: state.count }
  }
  return { shouldReload: true, nextCount: state.count + 1 }
}
