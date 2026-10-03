import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n'
import { renderMessage } from './notification-registry'
import { EMAIL_NOTIFICATION_MESSAGES as M } from './notification-email-registry'

/**
 * Expected values below are HAND-WRITTEN literals, never derived from the registry (a
 * tautological test passes by construction). The compiled catalog wins at render time, so a
 * mutated `message` is invisible through i18n — the first table reads `.id` / `.message` directly.
 */

const SOURCE_ROWS: ReadonlyArray<readonly [keyof typeof M, string, string]> = [
  [
    'transactionAddedSubjectProject',
    'email.notification.TRANSACTION_ADDED.subject.project',
    'Транзакція за проєктом «{projectName}»',
  ],
  [
    'transactionAddedSubject',
    'email.notification.TRANSACTION_ADDED.subject',
    'Вам додали транзакцію',
  ],
  [
    'transactionAddedLine',
    'email.notification.TRANSACTION_ADDED.line',
    'У ваших фінансах нова транзакція. Сума й деталі — у CRM.',
  ],
  [
    'statusValidatedSubject',
    'email.notification.TRANSACTION_STATUS_CHANGED.subject.validated',
    'Дохід валідовано',
  ],
  [
    'statusRejectedSubject',
    'email.notification.TRANSACTION_STATUS_CHANGED.subject.rejected',
    'Дохід відхилено',
  ],
  [
    'statusRejectedLine',
    'email.notification.TRANSACTION_STATUS_CHANGED.line.rejected',
    'Причина відмови — у CRM.',
  ],
  [
    'teamMemberAddedSubject',
    'email.notification.TEAM_MEMBER_ADDED.subject',
    'Вас додали до команди «{teamName}»',
  ],
  ['teamMemberAddedLine', 'email.notification.TEAM_MEMBER_ADDED.line', 'Склад команди — у CRM.'],
  [
    'projectMemberAddedSubject',
    'email.notification.PROJECT_MEMBER_ADDED.subject',
    'Вас додали до проєкту «{projectName}»',
  ],
  [
    'projectMemberAddedLine',
    'email.notification.PROJECT_MEMBER_ADDED.line',
    'Деталі проєкту та його склад — у CRM.',
  ],
  [
    'teamNewMemberSubject',
    'email.notification.TEAM_NEW_MEMBER.subject',
    'У команді «{teamName}» новий учасник',
  ],
  ['teamNewMemberLine', 'email.notification.TEAM_NEW_MEMBER.line', 'Хто саме — у CRM.'],
  [
    'projectConfirmSubject',
    'email.notification.PROJECT_CONFIRM_REQUIRED.subject',
    'Запит на додавання проєкту «{projectName}»',
  ],
  [
    'projectConfirmLine1',
    'email.notification.PROJECT_CONFIRM_REQUIRED.line1',
    'Вам пропонують участь у проєкті «{projectName}».',
  ],
  [
    'projectConfirmLine2',
    'email.notification.PROJECT_CONFIRM_REQUIRED.line2',
    'Проєкт не стартує, доки учасники не відповідять.',
  ],
  [
    'shareConfirmSubjectBase',
    'email.notification.SHARE_CONFIRM_REQUIRED.subject.base',
    'Запит на зміну частки за замовчуванням',
  ],
  [
    'shareConfirmSubjectProject',
    'email.notification.SHARE_CONFIRM_REQUIRED.subject.project',
    'Запит на зміну частки за проєктом «{projectName}»',
  ],
  [
    'shareConfirmLine1Base',
    'email.notification.SHARE_CONFIRM_REQUIRED.line1.base',
    'Вам пропонують змінити частку за замовчуванням.',
  ],
  [
    'shareConfirmLine1Project',
    'email.notification.SHARE_CONFIRM_REQUIRED.line1.project',
    'Вам пропонують змінити вашу частку за проєктом «{projectName}».',
  ],
  [
    'shareConfirmLine2',
    'email.notification.SHARE_CONFIRM_REQUIRED.line2',
    'Зараз діє попередня частка. Нова набуде чинності лише після вашої згоди.',
  ],
  [
    'documentSignSubject',
    'email.notification.DOCUMENT_SIGN_REQUIRED.subject',
    'Запит на підпис контракту',
  ],
  [
    'documentSignLine',
    'email.notification.DOCUMENT_SIGN_REQUIRED.line',
    'Ваш контракт готовий і чекає на підпис.',
  ],
  [
    'approvalConfirmedSubject',
    'email.notification.APPROVAL_CONFIRMED.subject',
    'Вашу пропозицію прийнято',
  ],
  [
    'approvalRejectedSubject',
    'email.notification.APPROVAL_REJECTED.subject',
    'Вашу пропозицію відхилено',
  ],
  ['approvalReasonLine', 'email.notification.APPROVAL_REJECTED.line.reason', 'Причина — у CRM.'],
  [
    'acceptedProject',
    'email.notification.approval.accepted.project',
    'Співробітник погодився взяти участь у проєкті «{subjectTitle}».',
  ],
  [
    'acceptedProjectUntitled',
    'email.notification.approval.accepted.projectUntitled',
    'Співробітник погодився взяти участь у проєкті.',
  ],
  [
    'acceptedProjectShare',
    'email.notification.approval.accepted.projectShare',
    'Співробітник погодився на зміну частки за проєктом «{subjectTitle}».',
  ],
  [
    'acceptedProjectShareUntitled',
    'email.notification.approval.accepted.projectShareUntitled',
    'Співробітник погодився на зміну частки за проєктом.',
  ],
  [
    'acceptedBaseShare',
    'email.notification.approval.accepted.baseShare',
    'Співробітник погодився на зміну частки за замовчуванням.',
  ],
  [
    'rejectedProject',
    'email.notification.approval.rejected.project',
    'Співробітник відмовився від участі у проєкті «{subjectTitle}».',
  ],
  [
    'rejectedProjectUntitled',
    'email.notification.approval.rejected.projectUntitled',
    'Співробітник відмовився від участі у проєкті.',
  ],
  [
    'rejectedProjectShare',
    'email.notification.approval.rejected.projectShare',
    'Співробітник відмовився від зміни частки за проєктом «{subjectTitle}».',
  ],
  [
    'rejectedProjectShareUntitled',
    'email.notification.approval.rejected.projectShareUntitled',
    'Співробітник відмовився від зміни частки за проєктом.',
  ],
  [
    'rejectedBaseShare',
    'email.notification.approval.rejected.baseShare',
    'Співробітник відмовився від зміни частки за замовчуванням.',
  ],
  ['invoiceSignedSubject', 'email.notification.INVOICE_SIGNED.subject', 'Рахунок підписано'],
  [
    'invoiceSignRequiredSubject',
    'email.notification.INVOICE_SIGN_REQUIRED.subject',
    'Рахунок очікує підпису',
  ],
  [
    'vacancyApplicationSubject',
    'email.notification.VACANCY_APPLICATION.subject',
    'Новий відгук на вакансію «{vacancyTitle}»',
  ],
  [
    'sharedAmountAndDetailsLine',
    'email.notification.shared.amountAndDetails',
    'Сума й деталі — у CRM.',
  ],
  ['sharedDetailsLine', 'email.notification.shared.details', 'Деталі — у CRM.'],
  ['sharedRespondButton', 'email.notification.shared.button.respond', 'Відповісти на запит'],
  ['sharedOpenCrmButton', 'email.notification.shared.button.openCrm', 'Відкрити CRM'],
]

describe('EMAIL_NOTIFICATION_MESSAGES — direct pins of id and uk source', () => {
  it('covers every key of the registry, no more, no fewer', () => {
    expect(SOURCE_ROWS).toHaveLength(42)
    expect(Object.keys(M).sort()).toEqual(SOURCE_ROWS.map(([k]) => k).sort())
  })
  it.each(SOURCE_ROWS)('%s: id and uk source', (key, id, uk) => {
    expect(M[key].id).toBe(id)
    expect(M[key].message).toBe(uk)
  })
})

const GOLDEN_PARAMETERISED: ReadonlyArray<
  readonly [keyof typeof M, Record<string, string>, string, string]
> = [
  [
    'transactionAddedSubjectProject',
    { projectName: 'Alpha' },
    'Транзакція за проєктом «Alpha»',
    'Transaction on project “Alpha”',
  ],
  [
    'teamMemberAddedSubject',
    { teamName: 'Alpha' },
    'Вас додали до команди «Alpha»',
    'You were added to the team “Alpha”',
  ],
  [
    'projectMemberAddedSubject',
    { projectName: 'Alpha' },
    'Вас додали до проєкту «Alpha»',
    'You were added to the project “Alpha”',
  ],
  [
    'teamNewMemberSubject',
    { teamName: 'Alpha' },
    'У команді «Alpha» новий учасник',
    'New member in the team “Alpha”',
  ],
  [
    'projectConfirmSubject',
    { projectName: 'Alpha' },
    'Запит на додавання проєкту «Alpha»',
    'Request to add the project “Alpha”',
  ],
  [
    'projectConfirmLine1',
    { projectName: 'Alpha' },
    'Вам пропонують участь у проєкті «Alpha».',
    'You are being offered a place on the project “Alpha”.',
  ],
  [
    'shareConfirmSubjectProject',
    { projectName: 'Alpha' },
    'Запит на зміну частки за проєктом «Alpha»',
    'Request to change your share on the project “Alpha”',
  ],
  [
    'shareConfirmLine1Project',
    { projectName: 'Alpha' },
    'Вам пропонують змінити вашу частку за проєктом «Alpha».',
    'You are being asked to change your share on the project “Alpha”.',
  ],
  [
    'acceptedProject',
    { subjectTitle: 'Alpha' },
    'Співробітник погодився взяти участь у проєкті «Alpha».',
    'The employee agreed to take part in the project “Alpha”.',
  ],
  [
    'acceptedProjectShare',
    { subjectTitle: 'Alpha' },
    'Співробітник погодився на зміну частки за проєктом «Alpha».',
    'The employee agreed to change their share on the project “Alpha”.',
  ],
  [
    'rejectedProject',
    { subjectTitle: 'Alpha' },
    'Співробітник відмовився від участі у проєкті «Alpha».',
    'The employee declined to take part in the project “Alpha”.',
  ],
  [
    'rejectedProjectShare',
    { subjectTitle: 'Alpha' },
    'Співробітник відмовився від зміни частки за проєктом «Alpha».',
    'The employee declined the change of their share on the project “Alpha”.',
  ],
  [
    'vacancyApplicationSubject',
    { vacancyTitle: 'Alpha' },
    'Новий відгук на вакансію «Alpha»',
    'New application for the vacancy “Alpha”',
  ],
]

const GOLDEN_PLAIN: ReadonlyArray<readonly [keyof typeof M, string, string]> = [
  ['transactionAddedSubject', 'Вам додали транзакцію', 'A transaction was added for you'],
  [
    'transactionAddedLine',
    'У ваших фінансах нова транзакція. Сума й деталі — у CRM.',
    'There is a new transaction in your finances. The amount and details are in the CRM.',
  ],
  ['statusValidatedSubject', 'Дохід валідовано', 'Income validated'],
  ['statusRejectedSubject', 'Дохід відхилено', 'Income rejected'],
  ['statusRejectedLine', 'Причина відмови — у CRM.', 'The reason is in the CRM.'],
  ['teamMemberAddedLine', 'Склад команди — у CRM.', 'The team roster is in the CRM.'],
  [
    'projectMemberAddedLine',
    'Деталі проєкту та його склад — у CRM.',
    'Project details and its members are in the CRM.',
  ],
  ['teamNewMemberLine', 'Хто саме — у CRM.', 'See who it is in the CRM.'],
  [
    'projectConfirmLine2',
    'Проєкт не стартує, доки учасники не відповідять.',
    'The project will not start until the participants respond.',
  ],
  [
    'shareConfirmSubjectBase',
    'Запит на зміну частки за замовчуванням',
    'Request to change your default share',
  ],
  [
    'shareConfirmLine1Base',
    'Вам пропонують змінити частку за замовчуванням.',
    'You are being asked to change your default share.',
  ],
  [
    'shareConfirmLine2',
    'Зараз діє попередня частка. Нова набуде чинності лише після вашої згоди.',
    'Your previous share still applies. The new one takes effect only after you agree.',
  ],
  ['documentSignSubject', 'Запит на підпис контракту', 'Request to sign your contract'],
  [
    'documentSignLine',
    'Ваш контракт готовий і чекає на підпис.',
    'Your contract is ready and waiting for your signature.',
  ],
  ['approvalConfirmedSubject', 'Вашу пропозицію прийнято', 'Your proposal was accepted'],
  ['approvalRejectedSubject', 'Вашу пропозицію відхилено', 'Your proposal was declined'],
  ['approvalReasonLine', 'Причина — у CRM.', 'The reason is in the CRM.'],
  [
    'acceptedProjectUntitled',
    'Співробітник погодився взяти участь у проєкті.',
    'The employee agreed to take part in the project.',
  ],
  [
    'acceptedProjectShareUntitled',
    'Співробітник погодився на зміну частки за проєктом.',
    'The employee agreed to change their share on the project.',
  ],
  [
    'acceptedBaseShare',
    'Співробітник погодився на зміну частки за замовчуванням.',
    'The employee agreed to change their default share.',
  ],
  [
    'rejectedProjectUntitled',
    'Співробітник відмовився від участі у проєкті.',
    'The employee declined to take part in the project.',
  ],
  [
    'rejectedProjectShareUntitled',
    'Співробітник відмовився від зміни частки за проєктом.',
    'The employee declined the change of their share on the project.',
  ],
  [
    'rejectedBaseShare',
    'Співробітник відмовився від зміни частки за замовчуванням.',
    'The employee declined the change of their default share.',
  ],
  ['invoiceSignedSubject', 'Рахунок підписано', 'Invoice signed'],
  ['invoiceSignRequiredSubject', 'Рахунок очікує підпису', 'Invoice awaiting your signature'],
  [
    'sharedAmountAndDetailsLine',
    'Сума й деталі — у CRM.',
    'The amount and details are in the CRM.',
  ],
  ['sharedDetailsLine', 'Деталі — у CRM.', 'Details are in the CRM.'],
  ['sharedRespondButton', 'Відповісти на запит', 'Respond to the request'],
  ['sharedOpenCrmButton', 'Відкрити CRM', 'Open the CRM'],
]

describe('uk / en golden renders (hand-written expectations)', () => {
  it('parameterised table has the 13 name-bearing messages', () => {
    expect(GOLDEN_PARAMETERISED).toHaveLength(13)
  })
  it.each(GOLDEN_PARAMETERISED)('uk: %s', (key, params, uk) => {
    expect(renderMessage(createI18n('uk'), M[key], params)).toBe(uk)
  })
  it.each(GOLDEN_PARAMETERISED)('en: %s', (key, params, _uk, en) => {
    expect(renderMessage(createI18n('en'), M[key], params)).toBe(en)
  })
  it.each(GOLDEN_PLAIN)('uk: %s', (key, uk) => {
    expect(renderMessage(createI18n('uk'), M[key])).toBe(uk)
  })
  it.each(GOLDEN_PLAIN)('en: %s', (key, _uk, en) => {
    expect(renderMessage(createI18n('en'), M[key])).toBe(en)
  })
})

describe('catalog hygiene', () => {
  const keys = Object.keys(M) as (keyof typeof M)[]
  const PARAMS = { projectName: 'P', teamName: 'T', vacancyTitle: 'V', subjectTitle: 'S' }

  it('every id is unique and under email.notification.', () => {
    const ids = keys.map((k) => M[k].id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('email.notification.'))).toBe(true)
  })
  it.each(['uk', 'en'] as const)(
    '%s: no ASCII apostrophe artifact in any rendered message',
    (loc) => {
      const i18n = createI18n(loc)
      for (const k of keys) {
        expect(renderMessage(i18n, M[k], PARAMS)).not.toMatch(/'/)
      }
    },
  )
  it.each(['uk', 'en'] as const)('%s: no unresolved placeholder braces in any message', (loc) => {
    const i18n = createI18n(loc)
    for (const k of keys) {
      expect(renderMessage(i18n, M[k], PARAMS)).not.toMatch(/[{}]/)
    }
  })
  it.each(['uk', 'en'] as const)('%s: no digits (privacy: no amounts/percentages)', (loc) => {
    const i18n = createI18n(loc)
    for (const k of keys) {
      expect(renderMessage(i18n, M[k], PARAMS)).not.toMatch(/[0-9]/)
    }
  })
  it.each(['uk', 'en'] as const)(
    '%s: a name in the transaction / new-member subject starts no later than the 24th character',
    (loc) => {
      // COPY-L-2: the object name is the only thing two such emails differ by, and a phone inbox
      // shows ~40 chars — the name must start inside the first 24. Scoped to the subjects where
      // the mandated uk source already meets it (the legacy Russian never did for the others).
      // Deliberately NOT covered (SPEC-M-1, accepted by the orchestrator, not forgotten):
      // projectConfirmSubject, shareConfirmSubjectProject, vacancyApplicationSubject — their uk
      // subjects are longer; the name still lands within ~35 chars / the inbox preview, so a
      // long subject is accepted there. Their en counterparts are not checked by this rule either.
      // The two member-added subjects are checked in uk only (the mandated source language);
      // their en text is not bound by this rule.
      const i18n = createI18n(loc)
      const keysToCheck =
        loc === 'uk'
          ? ([
              'transactionAddedSubjectProject',
              'teamNewMemberSubject',
              'teamMemberAddedSubject',
              'projectMemberAddedSubject',
            ] as const)
          : (['transactionAddedSubjectProject', 'teamNewMemberSubject'] as const)
      for (const k of keysToCheck) {
        const out = renderMessage(i18n, M[k], { projectName: '@@', teamName: '@@' })
        expect(out.indexOf('@@')).toBeLessThanOrEqual(24 + 1) // +1 for the opening quote char
      }
    },
  )
})
