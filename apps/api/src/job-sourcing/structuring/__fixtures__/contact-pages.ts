/**
 * Synthetic job pages with seeded contacts (all invented: `example.*` domains, 555/50 test-range numbers).
 * `contacts` lists every contact seeded into `text`; none may survive `stripContacts`.
 */
export interface ContactPage {
  name: string
  text: string
  contacts: readonly string[]
  /** Phones are also checked digit-wise: no separator variant of these digits may survive. */
  phones: readonly string[]
}

export const CONTACT_PAGES: readonly ContactPage[] = [
  {
    name: 'UA recruiter page (uk)',
    text: `Senior Node.js Developer — Kyiv / remote
Зарплата: 4 000 - 5 500 USD. Досвід 5+ років.
Контакти рекрутера: Олена Петренко, olena.petrenko@example.com.ua, тел. +38 (050) 123-45-67,
Telegram: @olena_hr_ua, Viber: +380671112233.
Також можна написати на hr [at] example [dot] com.ua або подзвонити 044 555 12 34.
Профіль: https://www.linkedin.com/in/olena-petrenko-hr/?locale=uk_UA
Деталі вакансії: https://jobs.example.com/vacancy/12345?utm_source=dou&ref=abc`,
    contacts: [
      'olena.petrenko@example.com.ua',
      '@olena_hr_ua',
      'example [dot] com',
      'linkedin.com/in/olena-petrenko-hr',
    ],
    phones: ['+38 (050) 123-45-67', '+380671112233', '044 555 12 34'],
  },
  {
    name: 'PL board with obfuscation and invisible characters',
    text: `Frontend Engineer (React) — Warszawa, hybrid
Wynagrodzenie 18 000 – 24 000 PLN netto (B2B).
Kontakt: anna​.kowal‍ski@exa⁠mple.pl, tel. +48 512 345 678 lub 600-700-800.
Messenger: https://wa.me/48512345678 · https://t.me/anna_k_rekrut
Skype: live:anna.kowalski.rekrutacja
GitHub: github.com/annakowalski — nasz kod: https://github.com/example-org/widgets`,
    contacts: [
      'kowal',
      'wa.me/48512345678',
      't.me/anna_k_rekrut',
      'anna.kowalski.rekrutacja',
      'github.com/annakowalski',
    ],
    phones: ['+48 512 345 678', '600-700-800'],
  },
  {
    name: 'US page with HTML-ish links and fullwidth characters',
    text: `<p>Staff Data Engineer, Austin TX ($180k–$220k)</p>
<p>Questions? <a href="mailto:talent@example.org?subject=Staff%20DE">email us</a> or
<a href="tel:+14155550132">call</a>. Hiring manager: (415) 555-0199, 415.555.0177.</p>
<p>Ｊｏｈｎ＠ｅｘａｍｐｌｅ．ｏｒｇ · twitter.com/johnhires · https://x.com/johnhires</p>
<p>Apply: https://careers.example.org/jobs/98765?src=board&amp;page=2</p>`,
    contacts: [
      'talent@example.org',
      'john@example.org',
      'twitter.com/johnhires',
      'x.com/johnhires',
    ],
    phones: ['+14155550132', '(415) 555-0199', '415.555.0177'],
  },
  {
    name: 'Mixed page with unicode digits and messenger deep links',
    text: `ML Engineer — remote EU
Contact Maria: maria(at)example(dot)de, WhatsApp +٤٩١٥١٢٣٤٥٦٧٨٩
Signal: https://signal.me/#p/+4915112345678 · tg://resolve?domain=maria_ml_hr
Viber: viber://chat?number=%2B4915112345679 · facebook.com/maria.ml.hr · instagram.com/maria.hr
Old style: 0049 151 1234 5670`,
    contacts: [
      'maria(at)example',
      'signal.me',
      'maria_ml_hr',
      'viber://',
      'facebook.com/maria.ml.hr',
      'instagram.com/maria.hr',
    ],
    phones: ['+٤٩١٥١٢٣٤٥٦٧٨٩', '0049 151 1234 5670'],
  },
]
