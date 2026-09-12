/**
 * Отправщик писем по очереди `notification_emails` — позиция 7a, AC2.
 *
 * Каждые пятнадцать секунд: взять пачку созревших строк, собрать письмо из
 * уведомления, отправить через `ResendMailerService`, отметить исход.
 *
 * **Шов — `OutboxGateway`, а не drizzle.** Всё, что отправщик делает с базой,
 * названо четырьмя операциями (`claimDue` / `addressesFor` / `markSent` /
 * `markFailed` / `scheduleRetry`). Это позволяет юнит-тесту проверять
 * ПОВЕДЕНИЕ («после пятой попытки строка хоронится»), а не форму SQL: мок
 * цепочки drizzle краснел бы на любом переписывании того же запроса, то есть
 * пиннинговал бы реализацию. Настоящий SQL — `FOR UPDATE SKIP LOCKED` и
 * предикат частичного индекса — проверяется на живой Postgres в
 * `notification-email-delivery.integration.spec.ts`, потому что ни того, ни
 * другого мок доказать не может по построению.
 *
 * **Захват — аренда, а не статус.** `claimDue` одним оператором двигает
 * `next_attempt_at` вперёд и увеличивает `attempts`, оставляя статус QUEUED.
 * Упавший посреди HTTP-запроса процесс не оставляет строк, застрявших в
 * промежуточном состоянии: аренда истекает, и строка возвращается в очередь
 * сама, без отдельного сборщика мусора.
 *
 * **HTTP — вне транзакции.** Держать транзакцию открытой на время запроса к
 * стороннему API значит держать коннекцию пула столько, сколько отвечает
 * чужой сервер. Захват коммитится, отправка идёт после него.
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { Env } from '../config/env'
import { ResendMailerService } from '../contact/resend-mailer.service'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import { stripCrlf } from '../common/strip-crlf'
import { renderNotificationEmail, type NotificationEmailSource } from './notification-email-copy'
import {
  decideDelivery,
  MAX_EMAIL_ATTEMPTS,
  type DeliveryContext,
  type SkipReason,
} from './notification-email-outbox'

/** Сколько строк берётся за один проход. */
export const CLAIM_BATCH_SIZE = 20

/** Строка очереди вместе с уведомлением, из которого собирается письмо. */
export interface ClaimedEmail {
  id: string
  userId: string
  /** Уже увеличенное захватом число попыток: 1 на первом проходе. */
  attempts: number
  notification: NotificationEmailSource
}

/** Всё, что отправщику нужно от базы. Реализация — `OutboxRepository`. */
export interface OutboxGateway {
  claimDue(limit: number): Promise<ClaimedEmail[]>
  deliveryContextFor(userId: string, type: string): Promise<DeliveryContext>
  markSent(id: string, email: string): Promise<void>
  markSkipped(id: string, reason: SkipReason): Promise<void>
  markFailed(id: string, reason: string): Promise<void>
  scheduleRetry(id: string, reason: string, attempts: number): Promise<void>
}

/**
 * Проход, идущий дольше этого, считается зависшим, и следующий тик начинает
 * работу, не дожидаясь его.
 *
 * Пять минут — с запасом больше самого долгого возможного прохода: двадцать
 * строк по десять секунд таймаута к провайдеру дают чуть больше трёх минут в
 * худшем случае. Без этого срока флаг «идёт» становится вечным от одного
 * зависшего `await` (SR-L-4): `finally` его снимет, а если не снимет —
 * отправщик умолкает навсегда и молча, что для канала, доносящего «вас ждёт
 * решение», хуже двух одновременных проходов.
 */
export const SWEEP_STUCK_AFTER_MS = 5 * 60_000

export const OUTBOX_GATEWAY = Symbol('OUTBOX_GATEWAY')

@Injectable()
export class NotificationEmailCronService {
  private readonly logger = new Logger(NotificationEmailCronService.name)
  private readonly frontendUrl: string
  /**
   * Куда приходит ответ на письмо. Публичный ящик, а не адрес получателя
   * (SR-M-3): «ответ на наши письма приходит в публичный ящик» — та же
   * конвенция, что у приглашения (`personal-email-invite-mailer.service.ts`).
   * Круг 1 ставил сюда личный адрес самого читателя, и ответ уходил ему же.
   */
  private readonly replyTo: string
  /** Ключа нет — предупредить ОДИН раз, а не четыре раза в минуту. */
  private warnedUnconfigured = false
  /**
   * Когда начался текущий проход, либо `null` — прохода нет.
   *
   * Метка времени, а не флаг: флаг отвечает только на «идёт ли», и зависший
   * проход делает ответ вечным (SR-L-4). Метка отвечает ещё и на «давно ли», а
   * снимается она СВОИМ проходом — см. `handleDue`.
   */
  private runningSince: number | null = null

  constructor(
    @Inject(OUTBOX_GATEWAY) private readonly outbox: OutboxGateway,
    private readonly mailer: ResendMailerService,
    private readonly telemetry: TelemetryErrorsService,
    config: ConfigService<Env, true>,
  ) {
    // `{ infer: true }` — подсказка ТИПАМ (`ConfigService<Env, true>` выводит
    // тип значения по ключу). На исполнение она не влияет никак: `get()`
    // вернёт то же значение и с `{}`, и с `{ infer: false }`, и без второго
    // аргумента вовсе. Проверить это тестом нечем — наблюдаемой разницы не
    // существует; само ИМЯ ключа при этом под тестом (заглушка настроек в
    // спеке отвечает только на `FRONTEND_URL`).
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: `infer` — подсказка компилятору, у неё нет наблюдаемого поведения во время исполнения
    this.frontendUrl = config.get('FRONTEND_URL', { infer: true })
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: то же — `infer` не меняет исполнение
    this.replyTo = config.get('CONTACT_PUBLIC_EMAIL', { infer: true })
  }

  /**
   * Пятнадцать секунд — компромисс между «письмо пришло, пока человек ещё
   * смотрит в почту» и стоимостью пустого запроса к индексу. Запрос по
   * частичному индексу на пустой очереди — это одна страница индекса.
   */
  @Cron('*/15 * * * * *')
  async handleDue(): Promise<void> {
    const startedAt = Date.now()
    if (this.runningSince !== null) {
      if (startedAt - this.runningSince < SWEEP_STUCK_AFTER_MS) return
      // Пять минут — не «наверное, ещё идёт», а «что-то не отпустило».
      // Громко, потому что молчащий отправщик выглядит точно так же, как
      // пустая очередь.
      this.logger.warn(
        `Previous notification email sweep has not finished in ${SWEEP_STUCK_AFTER_MS / 60_000} minutes — starting a new one`,
      )
    }
    this.runningSince = startedAt
    try {
      await this.drainOnce()
    } catch (err: unknown) {
      // Необработанный отказ в `@Cron`-обработчике молча убивает планировщик
      // для ВСЕХ кронов процесса — тот же довод, что у
      // `TelemetryRetentionCronService` и `VacanciesRetentionCronService`.
      this.logger.error(
        'Notification email sweep failed — retrying on the next tick',
        err instanceof Error ? err.stack : String(err),
      )
    } finally {
      // Снимает ТОЛЬКО свою метку. Иначе зависший проход, доехав до `finally`
      // после того как его сменили, открыл бы дорогу третьему одновременному —
      // то есть лечение зависания плодило бы проходы.
      if (this.runningSince === startedAt) this.runningSince = null
    }
  }

  /** Один проход. Отдельно от `handleDue` — чтобы тест не ждал планировщика. */
  async drainOnce(): Promise<void> {
    if (!this.mailer.isConfigured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true
        this.logger.warn(
          'RESEND_API_KEY is not set — notification emails are piling up in notification_emails and are not being sent. ' +
            'Rows stay QUEUED with zero attempts and will go out as soon as the key appears.',
        )
      }
      // Ни одной попытки: строку НЕ берём, `attempts` не растёт, и потолок в
      // пять попыток не тратится на отсутствие ключа.
      return
    }

    const batch = await this.outbox.claimDue(CLAIM_BATCH_SIZE)
    for (const item of batch) {
      await this.deliver(item)
    }
  }

  private async deliver(item: ClaimedEmail): Promise<void> {
    // Состояние получателя и его настройка читаются ЗДЕСЬ, в момент отправки,
    // а не при постановке в очередь (§5 задания). Между событием и этой
    // строкой прошло до пятнадцати секунд, а при ретраях — часы: человека
    // успели уволить, а канал — включить или выключить.
    const context = await this.outbox.deliveryContextFor(item.userId, item.notification.type)
    const decision = decideDelivery(item.notification.type, context)
    if (!decision.send) {
      await this.outbox.markSkipped(item.id, decision.skipReason)
      this.logSkip(item.id, decision.skipReason)
      return
    }
    // `stripCrlf` на адресе получателя тоже (SR-L-7, security-review PR #673
    // круг 2) — не только на `subject`/`reply_to`. Адрес приходит из
    // `user_emails.email` (`varchar`, без CHECK-констрейнта); форму
    // гарантирует только разбор запроса, а в базу можно попасть и мимо него
    // (тот же довод, которым в `decideDelivery` оставлен последний рубеж для
    // `emailEnabled`). Значение переиспользуется и для отправки, и для
    // `markSent` — журнал доставки хранит ровно то, что реально ушло.
    const to = stripCrlf(decision.to)

    const mail = renderNotificationEmail(item.notification, { frontendUrl: this.frontendUrl })

    try {
      await this.mailer.send({
        to: [to],
        // `stripCrlf` на всё, что уезжает в ЗАГОЛОВОК письма — тот же контроль
        // и та же причина, что в `contact.service.ts` (SR-M-1): имя проекта
        // приходит из пользовательского ввода, где перевод строки разрешён
        // валидацией, а заголовок, собранный из двух строк, — приглашение
        // подсунуть лишний. Тело письма этого не требует: там перевод строки
        // законен и безвреден.
        subject: stripCrlf(mail.subject),
        text: mail.text,
        html: mail.html,
        // Ответ на письмо приходит в ПУБЛИЧНЫЙ ящик, как у приглашения
        // (SR-M-3). Ставить сюда адрес самого читателя значило бы, что его
        // ответ уйдёт ему же, а личный адрес вдобавок поедет в заголовке
        // исходящего письма.
        replyTo: stripCrlf(this.replyTo),
      })
      await this.outbox.markSent(item.id, to)
    } catch (err: unknown) {
      const reason = safeErrorReason(err)
      if (item.attempts >= MAX_EMAIL_ATTEMPTS) {
        await this.outbox.markFailed(item.id, reason)
        this.logger.error(
          `Email undelivered after ${MAX_EMAIL_ATTEMPTS} attempts: ${reason} [id=${item.id}]`,
        )
        // Сдались — это событие для дайджеста: человек не узнал о том, о чём
        // должен был. Ни адрес, ни текст туда не едут.
        void this.telemetry
          .recordError({
            source: 'API',
            message: 'Notification email gave up after retries',
            route: '/api/notifications',
            meta: { reason, type: item.notification.type },
          })
          .catch((e: unknown) => {
            this.logger.error(
              `Telemetry rejected a delivery failure: ${e instanceof Error ? e.message : String(e)}`,
            )
          })
        return
      }
      await this.outbox.scheduleRetry(item.id, reason, item.attempts)
      this.logger.warn(
        `Email not sent (attempt ${item.attempts}/${MAX_EMAIL_ATTEMPTS}): ${reason} [id=${item.id}]`,
      )
    }
  }

  /**
   * След пропуска в журнале — одной строкой и одним уровнем на все четыре
   * причины.
   *
   * `warn`, а не `error`: три причины из четырёх — штатный исход (уволен, сам
   * выключил, тип без письма), и разводить уровни по причине значило бы
   * заводить второе правило рядом с `skip_reason`, которое разошлось бы с ним
   * при первой новой причине. Кому нужен разбор — читает колонку, а не уровень
   * журнальной строки. Адреса в строке нет: только идентификатор строки
   * очереди, как и во всех остальных строках этого файла.
   */
  private logSkip(id: string, reason: SkipReason): void {
    this.logger.warn(`Email skipped (${reason}) [id=${id}]`)
  }
}

/**
 * Причина отказа БЕЗ тела ответа провайдера.
 *
 * `ResendMailerService.send` бросает `Error` с текстом `Resend API HTTP
 * <статус>: <кусок тела>`, и этот кусок для отвергнутого адреса цитирует сам
 * адрес — то есть ровно те данные, которых этот проект не пишет ни в журнал,
 * ни в базу. Оставляем статус (по нему видно «битый запрос» против «провайдер
 * лежит»), в остальных случаях — имя класса ошибки.
 *
 * Тот же приём и та же причина, что в
 * `personal-email-invite-mailer.service.ts` (LOW-3, security-review PR #623).
 * Скопирован, а не вынесен: там он приватная деталь одного сервиса, и общий
 * хелпер на два вызывающих связал бы почту приглашений с почтой уведомлений
 * ради восьми строк. Появится третий — вынести.
 */
function safeErrorReason(err: unknown): string {
  if (err instanceof Error) {
    const statusMatch = /^Resend API HTTP (\d+)/.exec(err.message)
    if (statusMatch) return `Resend API HTTP ${statusMatch[1]}`
    return err.constructor.name
  }
  return 'unknown'
}
