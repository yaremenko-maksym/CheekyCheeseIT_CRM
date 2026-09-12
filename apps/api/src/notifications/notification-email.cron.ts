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
import { renderNotificationEmail, type NotificationEmailSource } from './notification-email-copy'
import { MAX_EMAIL_ATTEMPTS, pickEmailAddress, type AddressRow } from './notification-email-outbox'

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
  addressesFor(userId: string): Promise<AddressRow[]>
  markSent(id: string, email: string): Promise<void>
  markFailed(id: string, reason: string): Promise<void>
  scheduleRetry(id: string, reason: string, attempts: number): Promise<void>
}

export const OUTBOX_GATEWAY = Symbol('OUTBOX_GATEWAY')

@Injectable()
export class NotificationEmailCronService {
  private readonly logger = new Logger(NotificationEmailCronService.name)
  private readonly frontendUrl: string
  /** Ключа нет — предупредить ОДИН раз, а не четыре раза в минуту. */
  private warnedUnconfigured = false
  /** Проход не начинается, пока не закончился предыдущий (крон каждые 15 с). */
  private running = false

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
  }

  /**
   * Пятнадцать секунд — компромисс между «письмо пришло, пока человек ещё
   * смотрит в почту» и стоимостью пустого запроса к индексу. Запрос по
   * частичному индексу на пустой очереди — это одна страница индекса.
   */
  @Cron('*/15 * * * * *')
  async handleDue(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.drainOnce()
    } catch (err: unknown) {
      // Необработанный отказ в `@Cron`-обработчике молча убивает планировщик
      // для ВСЕХ кронов процесса — тот же довод, что у
      // `TelemetryRetentionCronService` и `VacanciesRetentionCronService`.
      this.logger.error(
        'Проход отправщика писем упал — повтор на следующем цикле',
        err instanceof Error ? err.stack : String(err),
      )
    } finally {
      this.running = false
    }
  }

  /** Один проход. Отдельно от `handleDue` — чтобы тест не ждал планировщика. */
  async drainOnce(): Promise<void> {
    if (!this.mailer.isConfigured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true
        this.logger.warn(
          'RESEND_API_KEY не задан — письма уведомлений копятся в очереди (notification_emails) и не отправляются. ' +
            'Строки остаются QUEUED с нулём попыток и уйдут, как только ключ появится.',
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
    const addresses = await this.outbox.addressesFor(item.userId)
    const to = pickEmailAddress(addresses)
    if (to === null) {
      // Не отказ провайдера, а отсутствие адресата: повторять нечего, каждая
      // следующая попытка дала бы тот же результат.
      await this.outbox.markFailed(item.id, 'no email address')
      this.logger.error(`Письмо некуда слать: у получателя нет ни одного адреса [id=${item.id}]`)
      return
    }

    const mail = renderNotificationEmail(item.notification, { frontendUrl: this.frontendUrl })

    try {
      await this.mailer.send({
        to: [to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // Отвечать на уведомление некому и незачем — но `Reply-To`,
        // указывающий на живой ящик, лучше, чем отсутствие заголовка:
        // почтовые фильтры считают его признаком настоящего отправителя.
        replyTo: to,
      })
      await this.outbox.markSent(item.id, to)
    } catch (err: unknown) {
      const reason = safeErrorReason(err)
      if (item.attempts >= MAX_EMAIL_ATTEMPTS) {
        await this.outbox.markFailed(item.id, reason)
        this.logger.error(
          `Письмо не доставлено после ${MAX_EMAIL_ATTEMPTS} попыток: ${reason} [id=${item.id}]`,
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
              `Телеметрия не приняла отказ доставки: ${e instanceof Error ? e.message : String(e)}`,
            )
          })
        return
      }
      await this.outbox.scheduleRetry(item.id, reason, item.attempts)
      this.logger.warn(
        `Письмо не ушло (попытка ${item.attempts}/${MAX_EMAIL_ATTEMPTS}): ${reason} [id=${item.id}]`,
      )
    }
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
