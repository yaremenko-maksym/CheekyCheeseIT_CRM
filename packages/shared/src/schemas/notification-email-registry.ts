import type { MessageDescriptor } from '@lingui/core'

/**
 * i18n emails, PR1. Every word of the notification emails
 * (`apps/api/src/notifications/notification-email-copy.ts`) as `/* i18n *\/`-marked
 * explicit-id descriptors. An email is rendered in the RECIPIENT's locale
 * (`users.locale`, default `uk`) through a per-call `createI18n(locale)` and the shared
 * `renderMessage` — the same one renderer as notifications, pending titles and the invoice PDF.
 *
 * Privacy rule (spec §10/§11), unchanged: an email names the OBJECT (project, team, contract,
 * vacancy) and never a person, an amount or a percentage. The only params are `projectName`,
 * `teamName`, `vacancyTitle`, `subjectTitle` — all nominative object names.
 *
 * Shape: ONE flat `Record` literal, because `lingui extract` only sees a `/* i18n *\/` literal as
 * an object PROPERTY value (see `MISC_MESSAGES` in `notification-registry.ts`). Data-dependent
 * variants (with / without a project name, base / project share) are separate WHOLE messages
 * chosen by the caller — never ICU `select` over fragments, never string concatenation.
 *
 * Source text is `uk`; `en` is a second original in the `.po`, not a calque. Do not move
 * `message` text into code paths: the compiled catalog wins at render time, so the spec pins
 * `.id` / `.message` directly.
 */
export const EMAIL_NOTIFICATION_MESSAGES = {
  transactionAddedSubjectProject: /* i18n */ {
    id: 'email.notification.TRANSACTION_ADDED.subject.project',
    message: 'Транзакція за проєктом «{projectName}»',
  },
  transactionAddedSubject: /* i18n */ {
    id: 'email.notification.TRANSACTION_ADDED.subject',
    message: 'Вам додали транзакцію',
  },
  transactionAddedLine: /* i18n */ {
    id: 'email.notification.TRANSACTION_ADDED.line',
    message: 'У ваших фінансах нова транзакція. Сума й деталі — у CRM.',
  },
  statusValidatedSubject: /* i18n */ {
    id: 'email.notification.TRANSACTION_STATUS_CHANGED.subject.validated',
    message: 'Дохід валідовано',
  },
  statusRejectedSubject: /* i18n */ {
    id: 'email.notification.TRANSACTION_STATUS_CHANGED.subject.rejected',
    message: 'Дохід відхилено',
  },
  statusRejectedLine: /* i18n */ {
    id: 'email.notification.TRANSACTION_STATUS_CHANGED.line.rejected',
    message: 'Причина відмови — у CRM.',
  },
  teamMemberAddedSubject: /* i18n */ {
    id: 'email.notification.TEAM_MEMBER_ADDED.subject',
    message: 'Вас додали до команди «{teamName}»',
  },
  teamMemberAddedLine: /* i18n */ {
    id: 'email.notification.TEAM_MEMBER_ADDED.line',
    message: 'Склад команди — у CRM.',
  },
  projectMemberAddedSubject: /* i18n */ {
    id: 'email.notification.PROJECT_MEMBER_ADDED.subject',
    message: 'Вас додали до проєкту «{projectName}»',
  },
  projectMemberAddedLine: /* i18n */ {
    id: 'email.notification.PROJECT_MEMBER_ADDED.line',
    message: 'Деталі проєкту та його склад — у CRM.',
  },
  teamNewMemberSubject: /* i18n */ {
    id: 'email.notification.TEAM_NEW_MEMBER.subject',
    message: 'У команді «{teamName}» новий учасник',
  },
  teamNewMemberLine: /* i18n */ {
    id: 'email.notification.TEAM_NEW_MEMBER.line',
    message: 'Хто саме — у CRM.',
  },
  projectConfirmSubject: /* i18n */ {
    id: 'email.notification.PROJECT_CONFIRM_REQUIRED.subject',
    message: 'Запит на додавання проєкту «{projectName}»',
  },
  projectConfirmLine1: /* i18n */ {
    id: 'email.notification.PROJECT_CONFIRM_REQUIRED.line1',
    message: 'Вам пропонують участь у проєкті «{projectName}».',
  },
  projectConfirmLine2: /* i18n */ {
    id: 'email.notification.PROJECT_CONFIRM_REQUIRED.line2',
    message: 'Проєкт не стартує, доки учасники не відповідять.',
  },
  shareConfirmSubjectBase: /* i18n */ {
    id: 'email.notification.SHARE_CONFIRM_REQUIRED.subject.base',
    message: 'Запит на зміну частки за замовчуванням',
  },
  shareConfirmSubjectProject: /* i18n */ {
    id: 'email.notification.SHARE_CONFIRM_REQUIRED.subject.project',
    message: 'Запит на зміну частки за проєктом «{projectName}»',
  },
  shareConfirmLine1Base: /* i18n */ {
    id: 'email.notification.SHARE_CONFIRM_REQUIRED.line1.base',
    message: 'Вам пропонують змінити частку за замовчуванням.',
  },
  shareConfirmLine1Project: /* i18n */ {
    id: 'email.notification.SHARE_CONFIRM_REQUIRED.line1.project',
    message: 'Вам пропонують змінити вашу частку за проєктом «{projectName}».',
  },
  shareConfirmLine2: /* i18n */ {
    id: 'email.notification.SHARE_CONFIRM_REQUIRED.line2',
    message: 'Зараз діє попередня частка. Нова набуде чинності лише після вашої згоди.',
  },
  documentSignSubject: /* i18n */ {
    id: 'email.notification.DOCUMENT_SIGN_REQUIRED.subject',
    message: 'Запит на підпис контракту',
  },
  documentSignLine: /* i18n */ {
    id: 'email.notification.DOCUMENT_SIGN_REQUIRED.line',
    message: 'Ваш контракт готовий і чекає на підпис.',
  },
  approvalConfirmedSubject: /* i18n */ {
    id: 'email.notification.APPROVAL_CONFIRMED.subject',
    message: 'Вашу пропозицію прийнято',
  },
  approvalRejectedSubject: /* i18n */ {
    id: 'email.notification.APPROVAL_REJECTED.subject',
    message: 'Вашу пропозицію відхилено',
  },
  approvalReasonLine: /* i18n */ {
    id: 'email.notification.APPROVAL_REJECTED.line.reason',
    message: 'Причина — у CRM.',
  },
  acceptedProject: /* i18n */ {
    id: 'email.notification.approval.accepted.project',
    message: 'Співробітник погодився взяти участь у проєкті «{subjectTitle}».',
  },
  acceptedProjectUntitled: /* i18n */ {
    id: 'email.notification.approval.accepted.projectUntitled',
    message: 'Співробітник погодився взяти участь у проєкті.',
  },
  acceptedProjectShare: /* i18n */ {
    id: 'email.notification.approval.accepted.projectShare',
    message: 'Співробітник погодився на зміну частки за проєктом «{subjectTitle}».',
  },
  acceptedProjectShareUntitled: /* i18n */ {
    id: 'email.notification.approval.accepted.projectShareUntitled',
    message: 'Співробітник погодився на зміну частки за проєктом.',
  },
  acceptedBaseShare: /* i18n */ {
    id: 'email.notification.approval.accepted.baseShare',
    message: 'Співробітник погодився на зміну частки за замовчуванням.',
  },
  rejectedProject: /* i18n */ {
    id: 'email.notification.approval.rejected.project',
    message: 'Співробітник відмовився від участі у проєкті «{subjectTitle}».',
  },
  rejectedProjectUntitled: /* i18n */ {
    id: 'email.notification.approval.rejected.projectUntitled',
    message: 'Співробітник відмовився від участі у проєкті.',
  },
  rejectedProjectShare: /* i18n */ {
    id: 'email.notification.approval.rejected.projectShare',
    message: 'Співробітник відмовився від зміни частки за проєктом «{subjectTitle}».',
  },
  rejectedProjectShareUntitled: /* i18n */ {
    id: 'email.notification.approval.rejected.projectShareUntitled',
    message: 'Співробітник відмовився від зміни частки за проєктом.',
  },
  rejectedBaseShare: /* i18n */ {
    id: 'email.notification.approval.rejected.baseShare',
    message: 'Співробітник відмовився від зміни частки за замовчуванням.',
  },
  invoiceSignedSubject: /* i18n */ {
    id: 'email.notification.INVOICE_SIGNED.subject',
    message: 'Рахунок підписано',
  },
  invoiceSignRequiredSubject: /* i18n */ {
    id: 'email.notification.INVOICE_SIGN_REQUIRED.subject',
    message: 'Рахунок очікує підпису',
  },
  vacancyApplicationSubject: /* i18n */ {
    id: 'email.notification.VACANCY_APPLICATION.subject',
    message: 'Новий відгук на вакансію «{vacancyTitle}»',
  },
  sharedAmountAndDetailsLine: /* i18n */ {
    id: 'email.notification.shared.amountAndDetails',
    message: 'Сума й деталі — у CRM.',
  },
  sharedDetailsLine: /* i18n */ {
    id: 'email.notification.shared.details',
    message: 'Деталі — у CRM.',
  },
  sharedRespondButton: /* i18n */ {
    id: 'email.notification.shared.button.respond',
    message: 'Відповісти на запит',
  },
  sharedOpenCrmButton: /* i18n */ {
    id: 'email.notification.shared.button.openCrm',
    message: 'Відкрити CRM',
  },
} satisfies Record<string, MessageDescriptor>
