import type { MessageDescriptor } from '@lingui/core'
import type { FinanceInvoicesErrorCode } from './codes'

export const FINANCE_INVOICES_ERROR_MESSAGES: Record<FinanceInvoicesErrorCode, MessageDescriptor> =
  {
    FINANCE_TRANSACTION_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_NOT_FOUND',
      message: 'Транзакцію не знайдено',
    },
    FINANCE_TRANSACTION_DELETED_RESTORE_FIRST: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_DELETED_RESTORE_FIRST',
      message: 'Транзакцію видалено — відновіть її перед цією дією',
    },
    FINANCE_TRANSACTION_ALREADY_DELETED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_ALREADY_DELETED',
      message: 'Транзакцію вже видалено',
    },
    FINANCE_TRANSACTION_NOT_DELETED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_NOT_DELETED',
      message: 'Транзакція не видалена — відновлювати нічого',
    },
    FINANCE_TRANSACTION_NOT_PENDING: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_NOT_PENDING',
      message: 'Транзакція не в статусі очікування',
    },
    FINANCE_TRANSACTION_DELETE_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_DELETE_REASON_REQUIRED',
      message: 'Вкажіть причину видалення транзакції — вона потрапить до журналу',
    },
    FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED',
      message: 'Вкажіть причину відновлення транзакції — вона потрапить до журналу',
    },
    FINANCE_REJECTION_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_REJECTION_REASON_REQUIRED',
      message: 'Вкажіть причину відхилення',
    },
    FINANCE_ROW_AMOUNT_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_ROW_AMOUNT_MISMATCH',
      message:
        'Сума однієї з часток не збігається з уже виплаченим — правку заблоковано до ручної звірки',
    },
    FINANCE_ROW_STATE_CHANGED_WHILE_EDITING: /* i18n */ {
      id: 'api-error.FINANCE_ROW_STATE_CHANGED_WHILE_EDITING',
      message: 'Запис змінився, поки ви з ним працювали — оновіть сторінку та спробуйте ще раз',
    },
    FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW: /* i18n */ {
      id: 'api-error.FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW',
      message:
        'Зміна суми оплаченої транзакції перераховує частки й зобов’язання — спершу відкрийте попередній перегляд',
    },
    // task-paid-salary-amount-edit — the `PAYMENT_FACT_RECORDED` refusal
    // (`classifyEditedRowLedgerFact`). A paid salary no longer lands here; what
    // does is a converted drop payout — a row genuinely pinned by its payment
    // fact. The old Russian text sent people to a «документ об оплате» the
    // system does not have — this one names the carrier and a remedy that exists.
    FINANCE_PAYMENT_FACT_AMOUNT_LOCKED: /* i18n */ {
      id: 'api-error.FINANCE_PAYMENT_FACT_AMOUNT_LOCKED',
      message:
        'Суму цього платежу зафіксовано разом із курсом переказу — тут її не змінити, виправте сторнувальною транзакцією',
    },
    // CR-M-1 / COPY-M-5 — the `SALARY_OBLIGATION_OUT_OF_RANGE` refusal. The
    // salary IS editable, just not to this figure: the remedy is a different
    // amount, never a reversing transaction.
    FINANCE_SALARY_OBLIGATION_OUT_OF_RANGE: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_OBLIGATION_OUT_OF_RANGE',
      message:
        'За записаним курсом переказу ця сума дає зобов’язання поза допустимими межами — перевірте суму',
    },
    // The five «this amount/field is pinned» refusals that used to be Russian
    // `@crm/shared` constants (`PAID_ROW_LOCKED_FIELD_MESSAGES`,
    // `CASCADE_LEDGER_FACT_MESSAGES`). Each names the CARRIER of the lock, then
    // the remedy; one sentence, no closing period.
    FINANCE_PAID_ROW_CURRENCY_LOCKED: /* i18n */ {
      id: 'api-error.FINANCE_PAID_ROW_CURRENCY_LOCKED',
      message:
        'Валюту оплаченого рядка не можна змінити — платіж уже пройшов у цій валюті, виправляйте сторнувальною транзакцією',
    },
    FINANCE_PAID_ROW_SALARY_MONTH_LOCKED: /* i18n */ {
      id: 'api-error.FINANCE_PAID_ROW_SALARY_MONTH_LOCKED',
      message:
        'Місяць зарплати в оплаченому рядку не можна змінити — за ним уже пораховано місячні підсумки, виправляйте сторнувальною транзакцією',
    },
    FINANCE_SETTLED_AMOUNT_LOCKED: /* i18n */ {
      id: 'api-error.FINANCE_SETTLED_AMOUNT_LOCKED',
      message:
        'За цим рядком уже були виплати — його суму підтверджено фактично переказаним, виправляйте сторнувальною транзакцією',
    },
    FINANCE_CLOSING_ROW_AMOUNT_LOCKED: /* i18n */ {
      id: 'api-error.FINANCE_CLOSING_ROW_AMOUNT_LOCKED',
      message:
        'Цим рядком закрито зобов’язання — його суму зафіксовано в розрахунку, виправляйте сторнувальною транзакцією',
    },
    FINANCE_ONCHAIN_DEPOSIT_AMOUNT_LOCKED: /* i18n */ {
      id: 'api-error.FINANCE_ONCHAIN_DEPOSIT_AMOUNT_LOCKED',
      message:
        'Суму депозиту звірено з блокчейном — її не можна змінити, розбіжність оформлюйте окремою транзакцією',
    },
    FINANCE_CASCADE_PREVIEW_STALE: /* i18n */ {
      id: 'api-error.FINANCE_CASCADE_PREVIEW_STALE',
      message: 'Дані змінилися після попереднього перегляду — оновіть його і збережіть ще раз',
    },
    FINANCE_SHARE_LEFT_PENDING_DURING_SAVE: /* i18n */ {
      id: 'api-error.FINANCE_SHARE_LEFT_PENDING_DURING_SAVE',
      message:
        'Під час збереження одна з часток змінила статус — нічого не збережено, оновіть сторінку й повторіть',
    },
    FINANCE_TX_HASH_INVALID: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_INVALID',
      message:
        'Некоректний хеш транзакції — потрібне посилання на Etherscan або 0x і 64 шістнадцяткові символи',
    },
    FINANCE_TX_HASH_ALREADY_CONSUMED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_ALREADY_CONSUMED',
      message: 'Цей хеш уже використано для виплати або поповнення рахунку компанії',
    },
    FINANCE_TX_HASH_RELEASE_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_RELEASE_REASON_REQUIRED',
      message: 'Вкажіть причину звільнення хешу — вона потрапить до журналу',
    },
    FINANCE_TX_HASH_NOT_CONSUMED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_NOT_CONSUMED',
      message: 'Цей хеш не позначений як використаний',
    },
    FINANCE_TX_HASH_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_REQUIRED',
      message: 'Вкажіть хеш транзакції',
    },
    FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT',
      message: 'Цей хеш транзакції вже використано для іншої виплати',
    },
    FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET: /* i18n */ {
      id: 'api-error.FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET',
      message: 'Отримувач транзакції не збігається з гаманцем компанії',
    },
    FINANCE_TX_NOT_CONFIRMED_ONCHAIN: /* i18n */ {
      id: 'api-error.FINANCE_TX_NOT_CONFIRMED_ONCHAIN',
      message: 'Транзакцію ще не підтверджено в мережі — спробуйте пізніше',
    },
    FINANCE_ONCHAIN_AMOUNT_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_ONCHAIN_AMOUNT_MISMATCH',
      message: 'Сума транзакції в мережі має точно збігатися із сумою виплати',
    },
    FINANCE_CRYPTO_TX_HASH_TOO_SHORT: /* i18n */ {
      id: 'api-error.FINANCE_CRYPTO_TX_HASH_TOO_SHORT',
      message: 'Для виплати криптовалютою вкажіть хеш транзакції — щонайменше 10 символів',
    },
    FINANCE_SIMULATION_TX_NOT_CONFIRMED: /* i18n */ {
      id: 'api-error.FINANCE_SIMULATION_TX_NOT_CONFIRMED',
      message: 'Симуляція: транзакцію не підтверджено',
    },
    FINANCE_TX_HASH_PARAM_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TX_HASH_PARAM_REQUIRED',
      message: 'Вкажіть одне посилання на Etherscan або один хеш транзакції',
    },
    FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED: /* i18n */ {
      id: 'api-error.FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED',
      message: 'Валюту {currency} не можна конвертувати в USDT',
    },
    FINANCE_SHARES_SUM_EXCEEDS_100: /* i18n */ {
      id: 'api-error.FINANCE_SHARES_SUM_EXCEEDS_100',
      message: 'Сума часток сеньйора і дропа перевищує 100%',
    },
    FINANCE_INCOME_OWN_PROJECTS_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_OWN_PROJECTS_ONLY',
      message: 'Заявити дохід можна лише за власним проєктом',
    },
    FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED',
      message: 'Дохід адміністратора можна заявити лише за проєктом адміністратора',
    },
    FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT',
      message: 'Бухгалтер не обирає, хто отримує дохід адміністратора',
    },
    FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN',
      message: 'Отримувач має бути активним адміністратором',
    },
    FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE: /* i18n */ {
      id: 'api-error.FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE',
      message:
        'Дохід USDT-проєкту заявляється як USDT-дохід — тоді одразу враховуються частки сеньйора й дропа',
    },
    FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH',
      message: 'USDT-дохід можна заявити лише за USDT-проєктом',
    },
    FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY',
      message: 'Дохід USDT-проєкту заявляє лише адміністратор',
    },
    FINANCE_INCOME_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — заявити дохід не можна',
    },
    FINANCE_NOT_YOUR_DROP_PROJECT: /* i18n */ {
      id: 'api-error.FINANCE_NOT_YOUR_DROP_PROJECT',
      message: 'Ви не дроп цього проєкту',
    },
    FINANCE_EDIT_SENIOR_INCOME_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_SENIOR_INCOME_ONLY',
      message: 'Редагувати можна лише дохід сеньйора',
    },
    FINANCE_EDIT_REJECTED_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_REJECTED_ONLY',
      message: 'Редагувати можна лише відхилені транзакції',
    },
    FINANCE_EDIT_DROP_INCOME_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_DROP_INCOME_ONLY',
      message: 'Редагувати можна лише дохід дропа',
    },
    FINANCE_VALIDATE_WRONG_TYPE: /* i18n */ {
      id: 'api-error.FINANCE_VALIDATE_WRONG_TYPE',
      message: 'Валідувати можна лише дохід сеньйора або дропа',
    },
    FINANCE_ADMIN_NO_SALARY: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_NO_SALARY',
      message: 'Адміністратор не отримує зарплату — його дохід іде через частки',
    },
    FINANCE_RECEIPT_ATTACH_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_ATTACH_FORBIDDEN',
      message: 'Немає прав прикріпити чек до цієї транзакції',
    },
    FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN',
      message: 'Замінити чек після оплати можуть лише адміністратор або бухгалтер',
    },
    FINANCE_RECEIPT_DOCUMENT_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_DOCUMENT_NOT_FOUND',
      message: 'Документ чека не знайдено',
    },
    FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_DOCUMENT_WRONG_CATEGORY',
      message: 'Прикріпити до транзакції можна лише документ категорії «Чек»',
    },
    FINANCE_RECEIPT_DOCUMENT_NOT_OWNED: /* i18n */ {
      id: 'api-error.FINANCE_RECEIPT_DOCUMENT_NOT_OWNED',
      message: 'Немає прав прикріпити цей документ чека',
    },
    FINANCE_EDIT_PAYOUT_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_PAYOUT_FORBIDDEN',
      message: 'Виплату редагувати не можна',
    },
    FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN',
      message: 'Редагувати транзакцію, пов’язану із заявкою на виплату, не можна',
    },
    FINANCE_DELETE_PAYOUT_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DELETE_PAYOUT_FORBIDDEN',
      message: 'Виплату видалити не можна',
    },
    FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN',
      message: 'Видаляти транзакцію, пов’язану із заявкою на виплату, не можна',
    },
    FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN',
      message: 'Видаляти транзакцію, яка є джерелом зобов’язання компанії, не можна',
    },
    FINANCE_PAY_SALARY_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_PAY_SALARY_ONLY',
      message: 'Оплатити можна лише зарплату',
    },
    FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_NO_SHARE_SNAPSHOT',
      message: 'В однієї з часток не збережено відсоток — перерахувати її можна лише вручну',
    },
    FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_OBLIGATION_CURRENCY_MISMATCH',
      message:
        'Зобов’язання за однією з часток записане в іншій валюті — перерахувати його не можна',
    },
    FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_SETTLED_AMOUNT_UNKNOWN',
      message: 'Не записано, скільки вже виплачено за однією з часток — потрібна ручна звірка',
    },
    FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_CURRENCY_PAIR_UNRESOLVABLE',
      message:
        'За однією з часток уже виплачено в {settledCurrency}, а нова сума в {currency} — потрібна ручна звірка',
    },
    FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN: /* i18n */ {
      id: 'api-error.FINANCE_DERIVATIVE_ROW_TYPE_MISMATCH_FOR_REOPEN',
      message:
        'Одну з часток закрила транзакція нетипового виду — повернути її до очікування виплати не можна',
    },
    FINANCE_SALARY_ROLE_NOT_ELIGIBLE: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_ROLE_NOT_ELIGIBLE',
      message: 'Зарплату можна створити лише для джуніора, HR, бухгалтера, сеньйора або дропа',
    },
    FINANCE_SALARY_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — створити зарплату не можна',
    },
    FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_ALREADY_CREATED_FOR_MONTH',
      message: 'Зарплату для цього співробітника за вибраний місяць уже створено',
    },
    FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — виплатити зарплату не можна',
    },
    FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN',
      message: 'Особистий рахунок, з якого йде оплата, має належати адміністратору',
    },
    FINANCE_TRANSFER_SENDER_ID_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_SENDER_ID_REQUIRED',
      message: 'Вкажіть відправника — переказ можливий лише між двома адміністраторами',
    },
    FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN',
      message: 'Відправник має бути адміністратором',
    },
    FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN',
      message: 'Переказати можна лише іншому адміністратору',
    },
    FINANCE_TRANSFER_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_TRANSFER_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — переказати кошти не можна',
    },
    FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE',
      message: 'Частину транзакцій уже включено до виплати або вони недоступні — оновіть список',
    },
    FINANCE_PAYOUT_DATE_BEFORE_INCOME: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_DATE_BEFORE_INCOME',
      message: 'Дата виплати не може бути раніше дати вибраного доходу',
    },
    FINANCE_TX_DATE_INVALID: /* i18n */ {
      id: 'api-error.FINANCE_TX_DATE_INVALID',
      message: 'Вкажіть коректну дату транзакції — такої дати не існує',
    },
    FINANCE_TX_DATE_IN_FUTURE: /* i18n */ {
      id: 'api-error.FINANCE_TX_DATE_IN_FUTURE',
      message: 'Для виконаної операції дата не може бути в майбутньому',
    },
    FINANCE_TX_DATE_TOO_OLD: /* i18n */ {
      id: 'api-error.FINANCE_TX_DATE_TOO_OLD',
      message: 'Дата транзакції надто давня — таку операцію може внести лише адміністратор',
    },
    FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED: /* i18n */ {
      id: 'api-error.FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED',
      message:
        'Дата надто далеко в минулому, і для неї потрібна причина — з цього екрана таку дату внести не можна',
    },
    FINANCE_PAYOUT_SINGLE_PROJECT_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_SINGLE_PROJECT_ONLY',
      message: 'Виплата має охоплювати лише один проєкт',
    },
    FINANCE_COMPANY_WALLET_NOT_CONFIGURED: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_WALLET_NOT_CONFIGURED',
      message: 'Гаманець компанії не налаштовано',
    },
    FINANCE_NBU_RATE_UNAVAILABLE: /* i18n */ {
      id: 'api-error.FINANCE_NBU_RATE_UNAVAILABLE',
      message: 'Курс НБУ недоступний — спробуйте пізніше',
    },
    FINANCE_PAYOUT_REQUEST_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_REQUEST_NOT_FOUND',
      message: 'Заявку на виплату не знайдено',
    },
    FINANCE_PAYOUT_REQUEST_ALREADY_PAID: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_REQUEST_ALREADY_PAID',
      message: 'Заявку на виплату вже оплачено',
    },
    FINANCE_RECIPIENT_ADMIN_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_RECIPIENT_ADMIN_NOT_FOUND',
      message: 'Адміністратора-отримувача не знайдено',
    },
    FINANCE_RECIPIENT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_RECIPIENT_MUST_BE_ADMIN',
      message: 'Отримувач має бути адміністратором',
    },
    FINANCE_RECIPIENT_ADMIN_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_RECIPIENT_ADMIN_ARCHIVED',
      message: 'Адміністратора-отримувача заархівовано — виберіть іншого',
    },
    FINANCE_PAYOUT_NOT_PENDING_PAYMENT: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_NOT_PENDING_PAYMENT',
      message: 'Виплата не очікує оплати — можливо, її вже підтверджено',
    },
    FINANCE_CONFIRM_PAYOUT_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_CONFIRM_PAYOUT_ONLY',
      message: 'Підтвердити можна лише виплату',
    },
    FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST',
      message: 'Транзакцію виплати за цією заявкою не знайдено',
    },
    FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT: /* i18n */ {
      id: 'api-error.FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT',
      message: 'У цьому проєкті не знайдено сеньйора',
    },
    FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS',
      message: 'Недостатньо коштів на рахунку компанії',
    },
    FINANCE_DROP_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DROP_SUMMARY_FORBIDDEN',
      message: 'Зведення дропа бачить лише дроп',
    },
    FINANCE_DROP_INCOMES_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DROP_INCOMES_FORBIDDEN',
      message: 'Доходи дропа бачить лише дроп',
    },
    FINANCE_DROP_PAYMENTS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DROP_PAYMENTS_FORBIDDEN',
      message: 'Виплати дропа бачить лише дроп',
    },
    FINANCE_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SUMMARY_FORBIDDEN',
      message: 'Фінансове зведення бачать лише адміністратор і бухгалтер',
    },
    FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN',
      message: 'Зведення бухгалтера бачать лише адміністратор і бухгалтер',
    },
    FINANCE_SENIOR_SUMMARY_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SENIOR_SUMMARY_FORBIDDEN',
      message: 'Зведення сеньйора бачать лише адміністратор і сеньйор',
    },
    FINANCE_INCOME_COMPLIANCE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_INCOME_COMPLIANCE_FORBIDDEN',
      message: 'Огляд відповідності доходів бачать лише адміністратор і бухгалтер',
    },
    FINANCE_SALARY_MONTH_GAP_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_MONTH_GAP_FORBIDDEN',
      message: 'Звіт про пропущені місяці зарплати бачать лише адміністратор і бухгалтер',
    },
    FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN',
      message: 'Заповнити пропущені місяці зарплати може лише адміністратор',
    },
    FINANCE_ADMIN_BALANCE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_ADMIN_BALANCE_FORBIDDEN',
      message: 'Баланс адміністратора бачать лише він сам і бухгалтер',
    },
    FINANCE_SENIOR_BALANCE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_SENIOR_BALANCE_FORBIDDEN',
      message: 'Баланс сеньйора бачать лише адміністратор, бухгалтер і сам сеньйор',
    },
    FINANCE_TOTAL_EARNED_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_TOTAL_EARNED_FORBIDDEN',
      message: 'Показник «всього зароблено» бачать лише адміністратор і бухгалтер',
    },
    FINANCE_PENDING_OBLIGATIONS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_PENDING_OBLIGATIONS_FORBIDDEN',
      message: 'Зобов’язання, що очікують виплати, бачать лише адміністратор, бухгалтер і сеньйор',
    },
    FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_ACCOUNT_ACCESS_FORBIDDEN',
      message: 'Рахунок компанії бачать лише адміністратор і бухгалтер',
    },
    FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_WALLET_CHANGE_ADMIN_ONLY',
      message: 'Змінити гаманець компанії може лише адміністратор',
    },
    FINANCE_WALLET_ADDRESS_INVALID: /* i18n */ {
      id: 'api-error.FINANCE_WALLET_ADDRESS_INVALID',
      message: 'Некоректна адреса гаманця — потрібні 0x і 40 шістнадцяткових символів',
    },
    FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_REQUISITES_CHANGE_ADMIN_ONLY',
      message: 'Змінити реквізити компанії може лише адміністратор',
    },
    FINANCE_COMPANY_REQUISITES_TOO_LONG: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_REQUISITES_TOO_LONG',
      message: 'Реквізити не довші за {maxChars, number} символів',
    },
    FINANCE_COMPANY_DEPOSIT_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_DEPOSIT_FORBIDDEN',
      message: 'Поповнювати рахунок компанії можуть лише сеньйор або дроп',
    },
    FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_DEPOSIT_STATUS_ACCESS_FORBIDDEN',
      message: 'Статус поповнення бачать лише його автор, адміністратор і бухгалтер',
    },
    FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_WITHDRAW_ADMIN_ONLY',
      message: 'Виводити дивіденди може лише адміністратор',
    },
    FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_AMOUNT_MUST_BE_POSITIVE',
      message: 'Сума дивідендів має бути більшою за нуль',
    },
    FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_RECIPIENT_MUST_BE_ADMIN',
      message: 'Дивіденди можна вивести лише на рахунок адміністратора',
    },
    FINANCE_DIVIDEND_RECEIVER_ARCHIVED: /* i18n */ {
      id: 'api-error.FINANCE_DIVIDEND_RECEIVER_ARCHIVED',
      message: 'Отримувача заархівовано — виплатити дивіденди не можна',
    },
    FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED: /* i18n */ {
      id: 'api-error.FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED',
      message: 'USDT-зобов’язання не можна закрити в {currency} — виберіть USD або USDT',
    },
    FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN',
      message: 'Зобов’язання, що очікують виплати, бачать лише адміністратор, бухгалтер і сеньйор',
    },
    FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN',
      message: 'Зобов’язання компанії бачать лише адміністратор і бухгалтер',
    },
    FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN: /* i18n */ {
      id: 'api-error.FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN',
      message: 'Закривати зобов’язання компанії можуть лише адміністратор або бухгалтер',
    },
    FINANCE_OBLIGATION_NOT_COMPANY_TYPE: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_NOT_COMPANY_TYPE',
      message: 'Це не зобов’язання компанії',
    },
    FINANCE_OBLIGATION_ALREADY_CLOSED: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_ALREADY_CLOSED',
      message: 'Зобов’язання вже закрито або скасовано',
    },
    FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT: /* i18n */ {
      id: 'api-error.FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT',
      message:
        'Частка дропа з цієї виплати не проходила через рахунок компанії — виберіть особистий рахунок адміністратора',
    },
    FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY: /* i18n */ {
      id: 'api-error.FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY',
      message:
        'Зобов’язання дропа записане не в USDT — закрити його з конверсією не можна, потрібна ручна звірка',
    },
    FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY: /* i18n */ {
      id: 'api-error.FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY',
      message:
        'Доплатити за цим зобов’язанням можна лише в {obligationCurrency} — курс зафіксувала попередня виплата',
    },
    FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION: /* i18n */ {
      id: 'api-error.FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION',
      message: 'Дата виплати не може бути раніше дати виникнення зобов’язання',
    },
    FINANCE_SALARY_IDEMPOTENCY_CONFLICT: /* i18n */ {
      id: 'api-error.FINANCE_SALARY_IDEMPOTENCY_CONFLICT',
      message:
        'Зарплату не збережено: для цього співробітника й місяця вже є запис з іншими даними. Наявний запис в обліку залишається без змін.',
    },
    FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO: /* i18n */ {
      id: 'api-error.FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO',
      message:
        'Після округлення сума виплати стала нульовою, хоча зобов’язання не нульове — виберіть іншу валюту виплати',
    },
    FINANCE_OBLIGATION_OVERPAID: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_OVERPAID',
      message:
        'За цим зобов’язанням виплачено більше, ніж належало — переплату треба розібрати вручну',
    },
    FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY: /* i18n */ {
      id: 'api-error.FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY',
      message:
        'Доплатити за цим зобов’язанням можна лише в {sourceSettledCurrency} — у цій валюті пройшла попередня виплата',
    },
    FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH: /* i18n */ {
      id: 'api-error.FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH',
      message: 'Доплатіть з того самого джерела, що й попередню виплату за цим зобов’язанням',
    },
    FINANCE_OBLIGATION_AMOUNT_CHANGED: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_AMOUNT_CHANGED',
      message:
        'Сума зобов’язання змінилася після завантаження — оновіть сторінку і повторіть закриття',
    },
    FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING',
      message: 'Транзакція, з якої виникло зобов’язання, вже не очікує виплати — оновіть сторінку',
    },
    FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION: /* i18n */ {
      id: 'api-error.FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION',
      message: 'Відкрите зобов’язання для цієї транзакції не знайдено',
    },
    FINANCE_OBLIGATION_NOT_FOUND: /* i18n */ {
      id: 'api-error.FINANCE_OBLIGATION_NOT_FOUND',
      message: 'Зобов’язання не знайдено',
    },
    FINANCE_SETTLED_AMOUNT_NOT_NUMBER: /* i18n */ {
      id: 'api-error.FINANCE_SETTLED_AMOUNT_NOT_NUMBER',
      message: 'Сума виплати має бути числом',
    },
    FINANCE_SETTLED_AMOUNT_NEGATIVE: /* i18n */ {
      id: 'api-error.FINANCE_SETTLED_AMOUNT_NEGATIVE',
      message: 'Сума виплати не може бути від’ємною',
    },
    FINANCE_SETTLED_AMOUNT_OVER_LIMIT: /* i18n */ {
      id: 'api-error.FINANCE_SETTLED_AMOUNT_OVER_LIMIT',
      message: 'Сума не може перевищувати {maxAmount, number}',
    },
    INVOICE_NOT_APPLICABLE_FOR_TX_TYPE: /* i18n */ {
      id: 'api-error.INVOICE_NOT_APPLICABLE_FOR_TX_TYPE',
      message: 'Рахунок не передбачений для цього типу транзакції',
    },
    INVOICE_NOT_GENERATED_YET: /* i18n */ {
      id: 'api-error.INVOICE_NOT_GENERATED_YET',
      message: 'Рахунок ще не згенеровано — спробуйте пізніше',
    },
    INVOICE_NOT_COUNTERPARTY: /* i18n */ {
      id: 'api-error.INVOICE_NOT_COUNTERPARTY',
      message: 'Ви не контрагент цієї транзакції',
    },
    INVOICE_ALREADY_SIGNED: /* i18n */ {
      id: 'api-error.INVOICE_ALREADY_SIGNED',
      message: 'Рахунок уже підписано',
    },
    INVOICE_COMPANY_SIGNATURE_MISSING: /* i18n */ {
      id: 'api-error.INVOICE_COMPANY_SIGNATURE_MISSING',
      message: 'Компанія ще не підписала рахунок — зверніться до адміністратора',
    },
    INVOICE_DOCUMENT_NOT_FOUND: /* i18n */ {
      id: 'api-error.INVOICE_DOCUMENT_NOT_FOUND',
      message: 'Документ рахунку не знайдено',
    },
    INVOICE_PDF_MODIFIED_AFTER_SIGNATURE: /* i18n */ {
      id: 'api-error.INVOICE_PDF_MODIFIED_AFTER_SIGNATURE',
      message: 'PDF змінено після першого підпису — зверніться до адміністратора',
    },
    INVOICE_USER_DATA_FETCH_FAILED: /* i18n */ {
      id: 'api-error.INVOICE_USER_DATA_FETCH_FAILED',
      message: 'Не вдалося отримати дані користувачів — спробуйте ще раз',
    },
    INVOICE_AMOUNT_VERIFICATION_FAILED: /* i18n */ {
      id: 'api-error.INVOICE_AMOUNT_VERIFICATION_FAILED',
      message: 'Не вдалося підтвердити суму цього рахунку — зверніться до адміністратора',
    },
    INVOICE_VOIDED: /* i18n */ {
      id: 'api-error.INVOICE_VOIDED',
      message: 'Рахунок анульовано — оновіть сторінку',
    },
    INVOICE_NOT_FOUND: /* i18n */ {
      id: 'api-error.INVOICE_NOT_FOUND',
      message: 'Рахунок не знайдено',
    },
    INVOICE_ACCESS_DENIED: /* i18n */ {
      id: 'api-error.INVOICE_ACCESS_DENIED',
      message: 'Немає доступу до цього рахунку',
    },
    FINANCE_DATE_FORMAT_INVALID: /* i18n */ {
      id: 'api-error.FINANCE_DATE_FORMAT_INVALID',
      message: 'Дата має бути у форматі YYYYMMDD',
    },
  }
