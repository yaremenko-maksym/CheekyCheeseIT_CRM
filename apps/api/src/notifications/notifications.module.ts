/**
 * NotificationsModule — in-app notifications API.
 *
 * Exports `NotificationsService` so every emitter can inject it directly
 * without re-importing DatabaseModule. С позиции 6 таких эмиттеров пять:
 * finance/transactions, teams, projects, users, approvals и contracts.
 *
 * AuthModule ЗДЕСЬ НЕ ИМПОРТИРУЕТСЯ — и это правка позиции 6, а не упущение.
 * Он стоял тут «ради JwtAuthGuard», но guard глобальный (`APP_GUARD` в
 * `AppModule`), а контроллер не объявляет ни одного `@UseGuards`: из
 * AuthModule ему нужен только декоратор `@CurrentUser`, а декоратор — не
 * провайдер и импорта модуля не требует. Ровно так же устроен, например,
 * `LegendsModule` — тоже JWT-защищённый контроллер без импорта AuthModule.
 *
 * Пока модуль был листом графа, лишний импорт ничего не стоил. Как только
 * пять модулей стали импортировать НАС, он замкнул кольцо
 * users → notifications → auth → users, и `app.module.container.spec.ts`
 * поймал это немедленно («The module at index [1] of the UsersModule
 * "imports" array is undefined»). Снять ненужное ребро честнее, чем
 * обвешивать пять импортов `forwardRef`, скрывая цикл вместо его удаления.
 */
import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
