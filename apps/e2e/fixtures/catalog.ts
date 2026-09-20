// fix-round 1 (PR #697, SPEC-H-1). `apps/e2e` не видит ни `@crm/shared`, ни
// `@crm/shared-i18n-locales` (оба — Vite-алиасы apps/web, e2e через Vite не
// идёт). Скомпилированный каталог — плоский объект без импортов, читаем его
// напрямую по относительному пути (требует `pnpm i18n:compile` ПЕРЕД
// прогоном — уже в порядке команд каждого Task-Step).
import { join } from 'node:path'

const LOCALES_DIR = join(__dirname, '../../../packages/shared/src/i18n/locales')

/** Скомпилированный каталог `locale`: id сообщения (хеш от исходного текста —
 *  генерируется `lingui extract`, НЕ сам текст, см.
 *  https://lingui.dev/guides/explicit-vs-generated-ids) -> локализованная
 *  строка. Id для НОВОГО ассерта — `pnpm i18n:extract`, затем
 *  `grep -B2 'msgstr "<исходный uk-текст>"' packages/shared/src/i18n/locales/uk/messages.po`. */
export async function loadMessages(locale: 'uk' | 'en'): Promise<Record<string, string>> {
  const mod = (await import(join(LOCALES_DIR, locale, 'messages'))) as {
    messages: Record<string, string>
  }
  return mod.messages
}
