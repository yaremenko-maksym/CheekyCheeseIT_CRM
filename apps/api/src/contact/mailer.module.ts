/**
 * MailerModule — единственный владелец `ResendMailerService`.
 *
 * Выделен в позиции 7a, и не ради красоты: `NotificationsModule` понадобился
 * тот же самый отправщик, а импортировать ради него `ContactModule` нельзя —
 * получилось бы кольцо
 * `notifications → contact → vacancies → notifications`
 * (`ContactModule` импортирует `VacanciesModule` ради `TurnstileService`, а
 * `VacanciesModule` импортирует `NotificationsModule` ради отклика на
 * вакансию). Кольцо поймал бы `app.module.container.spec.ts` — ровно так же,
 * как оно поймало лишний импорт `AuthModule` в позиции 6.
 *
 * Второй вариант — объявить `ResendMailerService` провайдером ещё и в
 * `NotificationsModule` — дал бы ДВА экземпляра одного HTTP-обёртчика и два
 * предупреждения «RESEND_API_KEY не задан» на старте. Отдельный модуль
 * оставляет один.
 *
 * Зависимостей у модуля нет: `ResendMailerService` нужен только
 * `ConfigService`, а он глобальный.
 */
import { Module } from '@nestjs/common'
import { ResendMailerService } from './resend-mailer.service'

@Module({
  providers: [ResendMailerService],
  exports: [ResendMailerService],
})
export class MailerModule {}
