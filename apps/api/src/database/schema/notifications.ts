/**
 * In-app notifications, approvals, legends and email delivery / preferences.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { users } from './users'

// ---------------------------------------------------------------------------
// Notifications (Invoice Signing Epic — also reusable for future events)
// ---------------------------------------------------------------------------
//
// Server-side persistence of in-app notifications. Drives the header
// колокольчик badge + dropdown. `type` is left as VARCHAR (not enum) so new
// event types can be added without a DB migration — validation lives in the
// shared Zod enum instead. INVOICE_SIGN_REQUIRED + INVOICE_SIGNED are the
// two types emitted by InvoicesService today; future epics can append more.

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body'),
    link: varchar('link', { length: 500 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // ── Позиция 6 плана уведомлений (§7.1) ──────────────────────────────────
    // «В записи — тип события и идентификаторы объектов. Кнопки и подписи
    // выводит клиент по типу.» `link` перестал быть источником правды для
    // действия и остался ради трёх старых типов (их строки просто несут NULL
    // во всех колонках ниже — перенос без потери) и как запасной путь для
    // типа, которого клиент ещё не знает.
    //
    // `subjectType` — плоский varchar, а не pgEnum, по той же причине, что и
    // `approvals.subject_type`: набор видов принадлежит вызывающим модулям, и
    // закрывать его на уровне БД значит требовать миграцию на каждый новый
    // тип уведомления. Закрытый набор живёт в Zod (`notificationSubjectType`),
    // где его видит и клиент.
    subjectType: varchar('subject_type', { length: 50 }),
    // Не FK — та же причина, что у `approvals.subject_id` и
    // `consumedTxHashes.referenceId`: одна колонка адресует строки нескольких
    // таблиц. И §7.4: уведомление живёт ДОЛЬШЕ объекта — FK с каскадом просто
    // удалил бы историю, а честное «объекта больше нет» показать было бы уже
    // некому.
    subjectId: uuid('subject_id'),
    // Второй участник события: новый участник команды, подтвердивший
    // сотрудник. Отдельной колонкой, а не внутри `data`, потому что по нему
    // строится адресация, а не текст.
    secondaryId: uuid('secondary_id'),
    // Факты события (суммы, проценты, снятое на момент события название) —
    // ДАННЫЕ, не текст. Из них клиент строит подробную строку, а письмо
    // (позиция 7) их НЕ берёт: в письмо уходит только нейтральный `title`
    // (§10 — «уведомления о деньгах — это раскрытие»).
    //
    // Имя колонки здесь совпадает с именем свойства, а drizzle при ПУСТОМ
    // имени берёт имя свойства. Проверено исполнением на нашей версии:
    // `jsonb('')` даёт колонку `data`, тогда как `varchar('')` в соседнем
    // `dedupeKey` дало бы `dedupeKey` вместо `dedupe_key` — потому там мутант
    // и погибает от проверки имён, а здесь погибнуть не может ни от какого
    // утверждения: мутация не меняет ничего наблюдаемого.
    // Stryker disable next-line StringLiteral: drizzle подставляет имя свойства вместо пустого — колонка остаётся `data`
    data: jsonb('data'),
    // Идемпотентность там, где событие может повториться: производитель
    // складывает ключ вида `<TYPE>:<subjectId>` и полагается на
    // `ON CONFLICT DO NOTHING` по индексу ниже. NULL = дублей не боимся
    // (повторное предложение доли ОБЯЗАНО спросить заново — см.
    // `approvals.supersededAt`).
    dedupeKey: varchar('dedupe_key', { length: 200 }),
  },
  (t) => [
    // Drives unread-count query + "unread only" filter in /api/notifications.
    index('idx_notifications_user_unread')
      .on(t.userId)
      .where(sql`${t.readAt} IS NULL`),
    // Drives the chronological dropdown listing (10 most recent for the user).
    index('idx_notifications_user_created').on(t.userId, t.createdAt.desc()),
    // Идемпотентность по (type, subjectId, userId): ключ несёт тип и объект,
    // индекс добавляет получателя. Частичный — строки без ключа (три старых
    // типа и всё, что дублей не боится) не ограничены ничем.
    uniqueIndex('uq_notifications_user_dedupe')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
  ],
)

// ---------------------------------------------------------------------------
// Approvals — task 3 of the notifications-and-confirmations plan
// (docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md
// §3/§4.1)
// ---------------------------------------------------------------------------
//
// FOUNDATION ONLY. Nothing in this file wires PROJECT or SHARE subjects — that
// is positions 4/5 of the plan's order-of-work. What this table guarantees is
// the mechanics: "actions touching an employee's money or responsibility do
// not take effect until they agree", built so that partial agreement, "one
// rejection voids the whole proposal", and "re-proposal never rewrites
// history" all fall out of ONE shape (one proposal = one row per approver)
// instead of needing separate machinery each.
//
// `subjectType` + `subjectId`: what is being confirmed. `subjectId` is
// deliberately NOT an FK — same reasoning as `consumedTxHashes.referenceId`:
// this registry is shared across future subject tables and must be able to
// outlive (and predate) any one of them. `subjectType` is a plain varchar,
// not a closed enum, for the same reason `consumedTxHashes.purpose` is a
// varchar — the set of kinds is owned by the calling module, not by this file.
//
// "Одно предложение — несколько строк, по строке на подтверждающего" is what
// makes partial agreement free (one row APPROVED, another still PENDING —
// no extra field) and turns "which rows belong to the same proposal" into a
// query: (subjectType, subjectId, supersededAt IS NULL).
//
// `supersededAt` is the ONE mechanism behind both:
//   (a) re-proposal (ApprovalsService.propose) — the entire previous live
//       generation is superseded before the new rows are inserted, so old
//       rows are never rewritten, only extinguished (history stays queryable
//       by `subjectType`+`subjectId` with no filter);
//   (b) a sibling rejecting (ApprovalsService.reject) — decision #5 "отказ
//       одного гасит предложение целиком": every other still-live row for
//       the same subject (PENDING or already APPROVED) is superseded in the
//       SAME transaction as the reject. The rejected row itself is NOT
//       superseded — it IS the terminal state of that generation.
// Same "void, never delete" discipline as `invoiceSignatures.voidedAt`.
//
// Prod DDL ships in THIS SAME PR, not deferred to whichever position adds
// the first real subject (CR-H-2, code-review PR #624 — an earlier revision
// of this comment said the opposite and was left behind when the plan
// changed). See `drizzle/manual/2026-09-01_approvals.sql`'s own header for
// the reasoning: the table is additive and empty on ship, so shipping the
// migration now costs nothing and removes a hand-off nobody would be forced
// to remember later. `scripts/devops/check-prod-ddl-wiring.py` verifies the
// file is wired into `.github/workflows/deploy.yml`.
// `CANCELLED` — task-648-fix-round-1 (SR-H-1): added via
// `drizzle/manual/2026-09-04_approval_status_cancelled.sql` (`ALTER TYPE …
// ADD VALUE`, a Postgres enum extension — never `DROP`-able, see that
// file's own header). Distinct from `REJECTED` — see the shared Zod schema
// (`packages/shared/src/schemas/approvals.ts`) for the reasoning.
// The array of VALUES is exercised directly —
// `approvals-schema.spec.ts` reads `approvalStatusEnum.enumValues` and
// compares it against the migration files' own CREATE TYPE + ALTER TYPE
// literals — but the enum's SQL TYPE NAME ('approval_status', this first
// argument) is Drizzle-internal plumbing no unit test ever reads back out.
// VERIFIED against real Postgres: `approvals.integration.spec.ts` inserts,
// updates, and reads rows through this exact column via Drizzle — every one
// of those queries would fail with a real Postgres type-mismatch error if
// this name diverged from the migration's `CREATE TYPE approval_status`.
// Stryker disable next-line StringLiteral: DB-level type name, see above.
export const approvalStatusEnum = pgEnum('approval_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
])

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subjectType: varchar('subject_type', { length: 50 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    approverUserId: uuid('approver_user_id')
      .notNull()
      .references(() => users.id),
    status: approvalStatusEnum('status').notNull().default('PENDING'),
    rejectionReason: text('rejection_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    proposedByUserId: uuid('proposed_by_user_id')
      .notNull()
      .references(() => users.id),
    // NULL = still the live decision point for this subject. See the header
    // comment above for the two things that set it.
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Drives "history for this subject" reads (admin re-propose screen, audit).
    index('idx_approvals_subject').on(t.subjectType, t.subjectId),
    // Drives "what's waiting on me" (Экран «что от меня ждут», position 7).
    index('idx_approvals_approver_pending')
      .on(t.approverUserId)
      .where(sql`${t.status} = 'PENDING' AND ${t.supersededAt} IS NULL`),
    // Race guard: at most one LIVE row per (subject, approver) at a time — a
    // concurrent propose() for the same subject cannot leave a duplicate live
    // ask for the same approver. Partial so history (supersededAt IS NOT NULL)
    // is never constrained.
    uniqueIndex('uq_approvals_live_subject_approver')
      .on(t.subjectType, t.subjectId, t.approverUserId)
      .where(sql`${t.supersededAt} IS NULL`),
    // "Отказ возможен и требует причины" (§3.3) — enforced at the DB, not just
    // in the Zod DTO, because this table is a shared registry future callers
    // reach directly.
    check(
      'ck_approvals_rejection_reason_required',
      sql`${t.status} <> 'REJECTED' OR (${t.rejectionReason} IS NOT NULL AND btrim(${t.rejectionReason}) <> '')`,
    ),
    // decidedAt is set exactly when a row leaves PENDING — never before, never
    // left null after.
    check(
      'ck_approvals_decided_at_matches_status',
      sql`(${t.status} = 'PENDING') = (${t.decidedAt} IS NULL)`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Legends — client-facing persona profiles, one per project
//
// 1:1 with a PROJECT (not a user). The legend is the persona the senior
// presents to the client company on that specific project.
// Intentionally separate from users.legalFullName (passport name for contracts).
// ---------------------------------------------------------------------------

export const legends = pgTable('legends', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  /** Client-facing persona full name (Cyrillic). NOT the same as legalFullName. */
  fullName: text('full_name').notNull(),
  dateOfBirth: text('date_of_birth'),
  address: text('address'),
  presentedRole: text('presented_role'),
  presentedStack: text('presented_stack'),
  backstory: text('backstory'),
  hobbies: text('hobbies'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Legend Entries — journal entries that complement the legend persona
// ---------------------------------------------------------------------------

export const legendEntries = pgTable('legend_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  legendId: uuid('legend_id')
    .notNull()
    .references(() => legends.id, { onDelete: 'cascade' }),
  // ON DELETE NO ACTION (Drizzle default) is intentional: we preserve
  // journal history even when a user is later deleted. If hard-delete of
  // users is ever introduced, a manual cleanup of orphaned authorId rows
  // will be required before the FK constraint allows the delete.
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id),
  text: text('text').notNull(),
  /**
   * Optional event date (YYYY-MM-DD text). When set, represents the real-world
   * date of the event described in the entry, allowing backdating. Entries are
   * sorted by COALESCE(event_date, created_at::date) so the journal timeline
   * reflects event order, not insertion order. NULL = use createdAt for display.
   */
  eventDate: text('event_date'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}))

export const legendsRelations = relations(legends, ({ one, many }) => ({
  project: one(projects, { fields: [legends.projectId], references: [projects.id] }),
  entries: many(legendEntries),
}))

export const legendEntriesRelations = relations(legendEntries, ({ one }) => ({
  legend: one(legends, { fields: [legendEntries.legendId], references: [legends.id] }),
  author: one(users, { fields: [legendEntries.authorId], references: [users.id] }),
}))

export type Notification = typeof notifications.$inferSelect

export type NewNotification = typeof notifications.$inferInsert

// ---------------------------------------------------------------------------
// Позиция 7a: доставка уведомлений почтой
// ---------------------------------------------------------------------------

/**
 * Состояние доставки. Промежуточного `SENDING` НЕТ намеренно: захват строки
 * отправщиком выражается не статусом, а АРЕНДОЙ — `next_attempt_at`
 * отодвигается вперёд, и строка перестаёт попадать в выборку. Процесс,
 * упавший посреди HTTP-запроса к Resend, не оставляет после себя строк,
 * навсегда застрявших в `SENDING`: аренда истекает, и строка возвращается в
 * работу сама. Плата за это — возможная повторная отправка одного письма при
 * падении ровно между `send()` и отметкой `SENT`; выбор сознательный, второе
 * письмо «вас ждёт решение» безвредно, потерянное — нет.
 *
 * `SKIPPED` — не сбой, а «не полагалось отправлять»: уволенный получатель,
 * выключенный им канал, тип без письма. Отличать его от `FAILED` требует §1
 * задания, и причина не бухгалтерская: без этого различия вопрос «почему
 * сотруднику не пришло письмо про X» не имеет ответа в данных, а `FAILED` с
 * текстом в `last_error` звал бы чинить то, что работает как задумано
 * (SPEC-H-1 / CR-H-1 / SR-L-2, круг 1).
 */
export const notificationEmailStatusEnum = pgEnum('notification_email_status', [
  'QUEUED',
  'SENT',
  'FAILED',
  'SKIPPED',
])

/**
 * Почему письма не будет. Заполнена ровно у строк со статусом `SKIPPED`.
 *
 * Отдельный тип, а не свободный текст: причина — предмет запросов («сколько
 * писем не ушло из-за выключенного канала»), и опечатка в ней означала бы
 * молча потерянную строку отчёта. Тот же перечень живёт союзом в
 * `notification-email-outbox.ts` (`SKIP_REASONS`), и расхождение двух описаний
 * ловит `notification-email-outbox.spec.ts`, а не прод.
 */
export const notificationEmailSkipReasonEnum = pgEnum('notification_email_skip_reason', [
  'NO_ADDRESS',
  'USER_ARCHIVED',
  'CHANNEL_OFF',
  'LEGACY_TYPE',
  // Бэклог 208: согласование/контракт, о котором письмо, устарело между
  // постановкой в очередь и отправкой. Миграция —
  // 2026-09-19_notification_email_skip_stale.sql (top-level ALTER TYPE, не в
  // DO $$ — Postgres не исполнит ADD VALUE из процедурного блока).
  'STALE',
])

/**
 * Очередь писем (outbox) — спека §7, позиция 7a.
 *
 * **Строка заводится В ТОЙ ЖЕ транзакции, что и само уведомление**
 * (`NotificationsService.createInTx`). Это не стиль, а то же свойство, ради
 * которого производители зовут `createInTx` изнутри транзакции события:
 * откатилось событие — откатились и уведомление, и письмо. Письмо о
 * несостоявшемся событии недопустимо ровно так же, как уведомление о нём.
 *
 * **Текста письма здесь НЕТ.** Ни темы, ни тела: они собираются в момент
 * отправки из типа уведомления и его `data`
 * (`notification-email-copy.ts`). Причина — та же, по которой §7.1 отверг
 * хранение готовых кнопок в строке уведомления: правка формулировки
 * потребовала бы правки ДАННЫХ, старые строки консервировали бы прошлогодний
 * текст, а тексты интерфейса расползлись бы по базе, где их не видит ни один
 * текстовый гейт (`copy-reviewer` читает десять писем в одном файле).
 */
export const notificationEmails = pgTable(
  'notification_emails',
  {
    // Пустое имя колонки drizzle подменяет ИМЕНЕМ СВОЙСТВА, а свойство здесь и
    // называется `id` — то есть колонка остаётся `id`, и наблюдаемой разницы
    // нет ни в одном запросе. Тот же случай и та же причина, что у `data` в
    // `notifications` выше. У `next_attempt_at` / `sent_to_email` и прочих
    // snake_case-колонок мутант ЖИВЫМ не остаётся: там имя свойства
    // отличается от имени колонки, и `notification-email-schema.spec.ts` это
    // ловит.
    // Stryker disable next-line StringLiteral: drizzle подставляет имя свойства вместо пустого — колонка остаётся `id`
    id: uuid('id').defaultRandom().primaryKey(),
    // Единственный источник содержания письма. CASCADE: получатель удалил
    // уведомление — письмо по нему больше не о чем слать, а собрать текст
    // было бы уже не из чего.
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    // Дубль `notifications.user_id` — намеренный. По нему идёт выбор адреса и
    // проверка настроек, и join к уведомлению ради одной колонки, которая
    // никогда не меняется, стоил бы дороже, чем копия.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Stryker disable next-line StringLiteral: имя свойства совпадает с именем колонки (`status`) — drizzle подставит его вместо пустого, наблюдаемой разницы нет
    status: notificationEmailStatusEnum('status')
      // Умолчание НЕ подавлено намеренно: `'QUEUED'` проверяется
      // `notification-email-schema.spec.ts`, и запись его на отдельной строке —
      // единственный способ оставить его под мутациями: `disable next-line`
      // глушит ВСЕ литералы своей строки, а не тот, на который смотрел автор.
      .notNull()
      .default('QUEUED'),
    /** Сколько раз отправщик БРАЛ строку в работу. Пять — потолок. */
    // Stryker disable next-line StringLiteral: то же — свойство и колонка называются `attempts`
    attempts: integer('attempts').notNull().default(0),
    /** Раньше этого момента строку не берут. Он же — срок аренды при захвате. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /**
     * Адрес, на который письмо действительно ушло. Выбирается в момент
     * отправки (PERSONAL → WORK), а не при постановке в очередь: личный адрес
     * могли добавить уже после события. Хранится ради следа «куда ушло» —
     * единственная колонка с персональными данными в этой таблице, и в журнал
     * она НЕ попадает.
     */
    sentToEmail: varchar('sent_to_email', { length: 255 }),
    /**
     * Почему не ушло. Кладётся ТОЛЬКО обеззараженная причина
     * (`safeErrorReason`: `Resend API HTTP 429` / имя класса ошибки; плюс
     * сообщение `decideDelivery:` из ветки «шлюз не передал `subjectState`» —
     * там тоже нет ни адреса, ни темы) — тело ответа Resend цитирует
     * отвергнутый адрес, то есть ровно те данные, которых этот проект не
     * пишет в журналы.
     */
    lastError: varchar('last_error', { length: 200 }),
    /**
     * Почему письма не будет — заполнена у `SKIPPED` и только у него.
     * `NULL` у остальных статусов: «пропущено без причины» — состояние,
     * которого не должно существовать, и отдельный код `NONE` только дал бы
     * ему имя.
     */
    skipReason: notificationEmailSkipReasonEnum('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Выборка отправщика целиком: «QUEUED, срок подошёл, самые старые вперёд».
    // Частичный — отправленные и сдавшиеся строки копятся навсегда, и держать
    // их в индексе значило бы платить за них на каждом проходе крона.
    index('idx_notification_emails_due')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'QUEUED'`),
    // Одно письмо на уведомление. Повторный вызов постановки для той же
    // строки — не второе письмо, а ничего.
    uniqueIndex('uq_notification_emails_notification').on(t.notificationId),
  ],
)

/**
 * Настройки каналов — §3 решение 6 («каналы настраивает сам сотрудник»).
 *
 * Строки ЗДЕСЬ нет = умолчание, а умолчание — «письма идут». Хранится только
 * отличие от умолчания, поэтому таблица остаётся почти пустой, а новый тип
 * уведомления не требует ни миграции, ни бэкфилла.
 *
 * `type` — плоский varchar по той же причине, что `notifications.type`:
 * закрытый набор живёт в Zod (`configurableNotificationTypeSchema`), где его
 * видит и клиент, а не в БД, где каждый новый тип стоил бы миграции. Запись
 * «выключено» для типа, требующего действия, отвергается разбором ДО базы
 * (`updateNotificationPreferencesSchema`) — см. §3, «письма про подтверждения
 * и подписи отключить нельзя».
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    // Stryker disable next-line StringLiteral: свойство и колонка называются `id` — drizzle подставит имя свойства, разницы нет
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Stryker disable next-line StringLiteral: свойство и колонка называются `type` — см. выше
    type: varchar('type', { length: 50 }).notNull(),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('uq_notification_preferences_user_type').on(t.userId, t.type)],
)

export type NotificationEmail = typeof notificationEmails.$inferSelect

export type NewNotificationEmail = typeof notificationEmails.$inferInsert

export type NotificationPreference = typeof notificationPreferences.$inferSelect

export type NewNotificationPreference = typeof notificationPreferences.$inferInsert

export type Legend = typeof legends.$inferSelect

export type NewLegend = typeof legends.$inferInsert
