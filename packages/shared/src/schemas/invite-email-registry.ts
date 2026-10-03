import type { MessageDescriptor } from '@lingui/core'

/**
 * i18n emails, PR2. Every word of the personal-email invite
 * (`apps/api/src/users/personal-email-invite-mailer.service.ts`) as `/* i18n *\/`-marked
 * explicit-id descriptors. The invite is rendered in the INVITEE's locale (`users.locale` of the
 * person the mail is addressed to — never the admin's request locale) through a per-call
 * `createI18n(locale)` and the shared `renderMessage`.
 *
 * Params: `firstName` (the invitee's own first name — the one person this email may name) and
 * `warning` (the footer's emphasised phrase, itself a catalog message, so the mailer can wrap it
 * in `<strong>` after rendering the whole sentence — see `emphasize` in `escape-html.ts`).
 *
 * Case: the `uk` greeting uses the label form `{firstName}: …`, not the vocative («Олексію»), which
 * a nominative-only template cannot produce; `en` has no case and keeps the comma form.
 *
 * Shape: ONE flat `Record` literal — `lingui extract` only sees a `/* i18n *\/` literal as an
 * object PROPERTY value. Source text is `uk`; `en` is a second original in the `.po`. Do not move
 * `message` text into code paths: the compiled catalog wins at render time, so the spec pins
 * `.id` / `.message` directly.
 */
export const EMAIL_INVITE_MESSAGES = {
  subject: /* i18n */ {
    id: 'email.invite.subject',
    message: 'Доступ до CRM CheekyCheeseIT',
  },
  greeting: /* i18n */ {
    id: 'email.invite.greeting',
    message: '{firstName}: цю адресу додали до CRM CheekyCheeseIT як вашу особисту.',
  },
  confirmLine1: /* i18n */ {
    id: 'email.invite.confirm.line1',
    message: 'Підтвердіть її — тоді входити можна буде і з робочої адреси, і з цієї.',
  },
  confirmLine2: /* i18n */ {
    id: 'email.invite.confirm.line2',
    message: 'Доки не підтвердите, вхід працює лише за робочою адресою.',
  },
  button: /* i18n */ {
    id: 'email.invite.button',
    message: 'Підтвердити адресу',
  },
  footer: /* i18n */ {
    id: 'email.invite.footer',
    message: 'Якщо лист прийшов помилково, {warning}.',
  },
  footerWarning: /* i18n */ {
    id: 'email.invite.footer.warning',
    message: 'не переходьте за посиланням',
  },
} satisfies Record<string, MessageDescriptor>
