// HR contract template (bilingual). Source of truth for the seeded role template.

export interface CustomVariable {
  key: string
  label: string
  defaultValue: string
}

export const HR_CONTRACT: {
  bodyMarkdown: string
  customVariables: CustomVariable[]
} = {
  customVariables: [
    {
      key: 'acceptanceDays',
      label: 'Кількість днів на підписання акта (п. 4.2)',
      defaultValue: '5',
    },
    { key: 'paymentDays', label: 'Кількість днів на оплату інвойсу (п. 5.3)', defaultValue: '10' },
    {
      key: 'suspendAfterDays',
      label: 'Днів прострочення для зупинення послуг (п. 2.1.4)',
      defaultValue: '10',
    },
    {
      key: 'forceMajeureDays',
      label: 'Кількість днів на повідомлення про форс-мажор (п. 6.3)',
      defaultValue: '5',
    },
    {
      key: 'liabilityPeriodMonths',
      label: 'Місяців для ліміту відповідальності (п. 6.4)',
      defaultValue: '6',
    },
    { key: 'salaryCurrency', label: 'Валюта винагороди (п. 5.2)', defaultValue: 'USD' },
    {
      key: 'languagePriority',
      label: 'Мовний пріоритет договору (п. 11.3)',
      defaultValue: 'українська',
    },
    { key: 'governingLaw', label: 'Застосовне право (п. 12.1)', defaultValue: 'право України' },
    {
      key: 'disputeForum',
      label: 'Форум вирішення спорів (п. 12.2)',
      defaultValue: 'суд за місцезнаходженням Виконавця',
    },
    {
      key: 'onboardingCriterion',
      label: 'Критерій успішного онбордингу для бонусу (п. 5.1.2)',
      defaultValue: 'фактичний вихід спеціаліста на проєкт',
    },
  ],

  bodyMarkdown: `# ДОГОВІР ПРО НАДАННЯ ПОСЛУГ (РЕКРУТИНГ / HR)<br>SERVICES AGREEMENT (RECRUITING / HR)

**Дата / Date:** {{onboardingDate}}

| Українська | English |
| --- | --- |
| Цей Договір про надання послуг (надалі — «Договір») укладено між: | This Services Agreement (the "Agreement") is made between: |
| **{{companyLegalName}}**, юридичною особою, що створена та діє відповідно до законодавства {{companyCountry}}, реєстраційний номер {{companyRegNumber}}, місцезнаходження: {{companyAddress}}, що діє на підставі {{companyAuthorityBasis}}, надалі — «**Замовник**», з однієї сторони, | **{{companyLegalName}}**, a legal entity incorporated and existing under the laws of {{companyCountry}}, registration number {{companyRegNumber}}, registered office: {{companyAddress}}, acting on the basis of {{companyAuthorityBasis}}, hereinafter the "**Customer**", of the one part, |
| та **Фізична особа — підприємець {{employeeName}}**, реєстраційний номер облікової картки платника податків (РНОКПП) {{rnokpp}}, що зареєстрований в Єдиному державному реєстрі від {{usrRecord}} та є платником єдиного податку 3-ї групи згідно із законодавством України, надалі — «**Виконавець**», з іншої сторони, | and **{{employeeName}}, a private entrepreneur (FOP)**, taxpayer registration number (RNOKPP) {{rnokpp}}, registered in the Unified State Register on {{usrRecord}}, being a single-tax payer of the 3rd group under the laws of Ukraine, hereinafter the "**Contractor**", of the other part, |
| надалі разом — «Сторони», а кожна окремо — «Сторона», уклали цей Договір про таке: | hereinafter jointly the "Parties" and each separately a "Party", have entered into this Agreement as follows: |

| Українська | English |
| --- | --- |
| **1. ПРЕДМЕТ ДОГОВОРУ** | **1. SUBJECT OF THE AGREEMENT** |
| 1.1. Виконавець зобов'язується за завданням Замовника надавати послуги з рекрутингу та управління персоналом (надалі — «Послуги»), а Замовник зобов'язується приймати та оплачувати такі Послуги на умовах цього Договору. | 1.1. The Contractor undertakes, upon the Customer's assignment, to provide recruiting and human-resources services (the "Services"), and the Customer undertakes to accept and pay for such Services under the terms of this Agreement. |
| 1.2. Послуги включають повний цикл рекрутингу та HR-підтримки, зокрема: | 1.2. The Services cover the full recruiting and HR-support cycle, in particular: |
| 1.2.1. пошук, скринінг та первинну оцінку кандидатів відповідно до вимог Замовника; | 1.2.1. sourcing, screening and initial assessment of candidates per the Customer's requirements; |
| 1.2.2. організацію та координацію співбесід (HR-, технічних та фінальних інтерв'ю), комунікацію з кандидатами та рекрутерами; | 1.2.2. organising and coordinating interviews (HR, technical and final), and communication with candidates and recruiters; |
| 1.2.3. підтримку процесу онбордингу успішно найнятих спеціалістів; | 1.2.3. supporting the onboarding of successfully hired specialists; |
| 1.2.4. внутрішню комунікацію та координацію в межах команд Замовника; | 1.2.4. internal communication and coordination within the Customer's teams; |
| 1.2.5. відстеження статусу виплат та допоміжну адміністративну підтримку, пов'язану з персоналом. | 1.2.5. tracking payment status and providing related personnel-administrative support. |
| 1.3. Виконавець надає Послуги особисто, на власний ризик, із самостійним визначенням робочого часу, місця та засобів їх надання; цей Договір не є трудовим договором і не створює трудових відносин між Сторонами. | 1.3. The Contractor provides the Services personally, at its own risk, independently determining the working time, place and means of performance; this Agreement is not an employment contract and does not create an employment relationship between the Parties. |

| Українська | English |
| --- | --- |
| **2. ПРАВА ТА ОБОВ'ЯЗКИ ВИКОНАВЦЯ** | **2. RIGHTS AND OBLIGATIONS OF THE CONTRACTOR** |
| 2.1. Виконавець має право: | 2.1. The Contractor has the right to: |
| 2.1.1. використовувати будь-які законні способи та засоби для надання Послуг; | 2.1.1. use any lawful methods and means to provide the Services; |
| 2.1.2. запитувати у Замовника інформацію та матеріали, необхідні для надання Послуг; | 2.1.2. request from the Customer the information and materials necessary to provide the Services; |
| 2.1.3. вимагати оплати фактично наданих Послуг відповідно до Розділу 5; | 2.1.3. demand payment for the Services actually rendered under Section 5; |
| 2.1.4. зупинити надання Послуг у разі прострочення оплати Замовником понад {{suspendAfterDays}} днів. | 2.1.4. suspend the Services if the Customer delays payment for more than {{suspendAfterDays}} days. |
| 2.2. Виконавець зобов'язується: | 2.2. The Contractor undertakes to: |
| 2.2.1. надавати Послуги своєчасно та на професійному рівні; | 2.2.1. provide the Services in a timely and professional manner; |
| 2.2.2. на запит Замовника інформувати про стан надання Послуг; | 2.2.2. inform the Customer of the status of the Services upon request; |
| 2.2.3. негайно повідомляти Замовника про обставини, що перешкоджають належному наданню Послуг; | 2.2.3. promptly notify the Customer of any circumstances impeding proper performance; |
| 2.2.4. дотримуватися вимог конфіденційності (Розділ 7) та захисту даних (Розділ 9); | 2.2.4. comply with the confidentiality (Section 7) and data-protection (Section 9) requirements; |
| 2.2.5. самостійно нести відповідальність за сплату всіх податків і зборів, пов'язаних із його підприємницькою діяльністю в Україні. | 2.2.5. be solely responsible for paying all taxes and duties related to its entrepreneurial activity in Ukraine. |

| Українська | English |
| --- | --- |
| **3. ПРАВА ТА ОБОВ'ЯЗКИ ЗАМОВНИКА** | **3. RIGHTS AND OBLIGATIONS OF THE CUSTOMER** |
| 3.1. Замовник має право: | 3.1. The Customer has the right to: |
| 3.1.1. надавати Виконавцю завдання та пріоритети щодо вакансій і кандидатів; | 3.1.1. give the Contractor assignments and priorities regarding vacancies and candidates; |
| 3.1.2. контролювати результат надання Послуг та надавати письмові зауваження щодо їх якості; | 3.1.2. review the result of the Services and provide written comments on their quality; |
| 3.1.3. одержувати від Виконавця інформацію про надані Послуги. | 3.1.3. obtain information about the Services rendered. |
| 3.2. Замовник зобов'язується: | 3.2. The Customer undertakes to: |
| 3.2.1. своєчасно надавати Виконавцю інформацію та матеріали, потрібні для надання Послуг; | 3.2.1. timely provide the Contractor with the information and materials needed for the Services; |
| 3.2.2. приймати належно надані Послуги в порядку Розділу 4; | 3.2.2. accept duly rendered Services under Section 4; |
| 3.2.3. сплачувати Виконавцю винагороду в розмірі, строки та спосіб, визначені Розділом 5; | 3.2.3. pay the Contractor the remuneration in the amount, within the time and by the method set out in Section 5; |
| 3.2.4. не давати Виконавцю вказівок, що за змістом створюють ознаки трудових відносин (фіксований робочий графік, підпорядкування правилам внутрішнього трудового розпорядку тощо). | 3.2.4. refrain from giving the Contractor instructions that in substance create features of an employment relationship (fixed working schedule, subordination to internal labour rules, etc.). |

| Українська | English |
| --- | --- |
| **4. ПОРЯДОК ПРИЙМАННЯ ПОСЛУГ** | **4. ACCEPTANCE OF SERVICES** |
| 4.1. Приймання Послуг здійснюється на підставі рахунків (інвойсів) та/або актів наданих послуг, які Виконавець періодично виставляє Замовнику. | 4.1. Acceptance of the Services is made on the basis of invoices and/or service-acceptance acts periodically issued by the Contractor to the Customer. |
| 4.2. Замовник підписує і повертає акт (або надсилає вмотивовану відмову) протягом {{acceptanceDays}} днів з моменту отримання. Якщо у цей строк Виконавець не отримує підписаний акт або вмотивовану відмову, Послуги вважаються прийнятими належно. | 4.2. The Customer signs and returns the act (or sends a reasoned rejection) within {{acceptanceDays}} days of receipt. If, within this period, the Contractor receives neither a signed act nor a reasoned rejection, the Services are deemed duly accepted. |
| 4.3. У разі вмотивованої відмови Сторони погоджують перелік недоліків і строки їх усунення, після чого процедура приймання повторюється. | 4.3. In case of a reasoned rejection, the Parties agree the list of defects and the time to remedy them, after which the acceptance procedure is repeated. |
| 4.4. Сторони визнають юридичну силу рахунків та актів, надісланих у формі електронного документа (PDF тощо) електронною поштою на адреси, зазначені в Розділі 13, або через узгоджені месенджери. | 4.4. The Parties recognise the legal force of invoices and acts sent as an electronic document (PDF, etc.) by email to the addresses in Section 13 or via agreed messengers. |

| Українська | English |
| --- | --- |
| **5. ЦІНА ТА ПОРЯДОК ОПЛАТИ** | **5. PRICE AND PAYMENT** |
| 5.1. За належно надані Послуги Замовник сплачує Виконавцю винагороду, що складається з: | 5.1. For duly rendered Services, the Customer pays the Contractor remuneration consisting of: |
| 5.1.1. **базової винагороди — {{salary}} на місяць** (підставляється автоматично з картки співробітника); та | 5.1.1. **a base fee of {{salary}} per month** (auto-filled from the employee record); and |
| 5.1.2. **бонусу — 350 (триста п'ятдесят) доларів США (USD) за кожного спеціаліста, успішно онбордженого за сприяння Виконавця.** Спеціаліст вважається «успішно онбордженим» за умови {{onboardingCriterion}}. | 5.1.2. **a bonus of USD 350 (three hundred fifty US dollars) for each specialist successfully onboarded with the Contractor's assistance.** A specialist is deemed "successfully onboarded" provided {{onboardingCriterion}}. |
| 5.2. Винагорода визначена в {{salaryCurrency}} як грошовий еквівалент; спосіб і валюта фактичної оплати визначаються згідно з п. 5.5 та з урахуванням валютного законодавства України. За потреби перерахунку в гривню застосовується офіційний курс НБУ на дату фактичної оплати. | 5.2. The remuneration is denominated in {{salaryCurrency}} as a monetary equivalent; the method and currency of actual payment are determined under cl. 5.5 and Ukrainian currency law. Where conversion into hryvnia is required, the official NBU rate on the actual payment date applies. |
| 5.3. Оплата здійснюється на підставі рахунку (інвойсу) Виконавця протягом {{paymentDays}} календарних днів з дати його отримання. | 5.3. Payment is made on the basis of the Contractor's invoice within {{paymentDays}} calendar days of its receipt. |
| 5.4. Усі банківські та інші комісії, пов'язані з переказом коштів, сплачує Замовник. | 5.4. All bank and other fees related to the transfer of funds are borne by the Customer. |
| 5.5. Реквізити для оплати: переважний метод — {{preferredMethod}}; реквізити Виконавця наведені у {{requisites}} (Розділ 13). | 5.5. Payment details: preferred method — {{preferredMethod}}; the Contractor's details are set out in {{requisites}} (Section 13). |

| Українська | English |
| --- | --- |
| **6. ВІДПОВІДАЛЬНІСТЬ СТОРІН. ФОРС-МАЖОР** | **6. LIABILITY. FORCE MAJEURE** |
| 6.1. За порушення зобов'язань Сторони несуть відповідальність згідно з цим Договором та застосовним правом (Розділ 12). | 6.1. For breach of obligations the Parties bear liability under this Agreement and the applicable law (Section 12). |
| 6.2. Сторони не відповідають за невиконання зобов'язань, якщо воно спричинене обставинами непереборної сили (форс-мажор): стихійні явища, війна, воєнні дії, мобілізація, блокади, ембарго, рішення органів влади, епідемії, перебої електро- та інтернет-зв'язку тощо. | 6.2. The Parties are not liable for non-performance caused by force-majeure circumstances: natural disasters, war, hostilities, mobilisation, blockades, embargoes, acts of authorities, epidemics, power and internet outages, etc. |
| 6.3. Сторона, для якої настали форс-мажорні обставини, повідомляє іншу Сторону протягом {{forceMajeureDays}} днів; на період їх дії строк виконання зобов'язань відкладається. | 6.3. The affected Party notifies the other within {{forceMajeureDays}} days; for the period of such circumstances, the performance deadline is postponed. |
| 6.4. Сукупна відповідальність кожної Сторони обмежується сумою винагороди, фактично сплаченої за {{liabilityPeriodMonths}} місяців, що передують події. | 6.4. Each Party's aggregate liability is limited to the remuneration actually paid for the {{liabilityPeriodMonths}} months preceding the event. |

| Українська | English |
| --- | --- |
| **7. КОНФІДЕНЦІЙНІСТЬ** | **7. CONFIDENTIALITY** |
| 7.1. Протягом дії Договору та **3 (трьох) років** після його припинення жодна Сторона не розголошує Конфіденційну інформацію іншої Сторони без її письмової згоди. | 7.1. During the term of the Agreement and for **3 (three) years** after its termination, neither Party discloses the other Party's Confidential Information without its written consent. |
| 7.2. Конфіденційною є будь-яка непублічна інформація, що передається між Сторонами у зв'язку з Договором, зокрема: база кандидатів, описи вакансій, скрипти співбесід, дані про винагороди, бізнес-плани, листування з контрагентами, доступи до систем. | 7.2. Confidential Information means any non-public information exchanged between the Parties in connection with the Agreement, including the candidate database, vacancy descriptions, interview scripts, remuneration data, business plans, correspondence with counterparties, and system access credentials. |
| 7.3. Не є порушенням розкриття інформації на вимогу закону, суду чи компетентного органу за умови попереднього письмового повідомлення іншої Сторони (де це дозволено законом). | 7.3. It is not a breach to disclose information as required by law, court or competent authority, provided the other Party is notified in advance in writing (where permitted by law). |

| Українська | English |
| --- | --- |
| **8. ІНТЕЛЕКТУАЛЬНА ВЛАСНІСТЬ** | **8. INTELLECTUAL PROPERTY** |
| 8.1. Усі результати, створені Виконавцем під час надання Послуг, зокрема **база кандидатів, описи вакансій, скрипти та матеріали співбесід**, а також виключні майнові права інтелектуальної власності на них переходять до Замовника з моменту їх створення (або з моменту оплати відповідного періоду). | 8.1. All deliverables created by the Contractor while providing the Services, in particular the **candidate database, vacancy descriptions, interview scripts and materials**, together with the exclusive economic intellectual-property rights therein, transfer to the Customer upon their creation (or upon payment for the relevant period). |
| 8.2. Виконавець гарантує, що такі результати не порушують прав третіх осіб, та що він має право передати зазначені права Замовнику. | 8.2. The Contractor warrants that such deliverables do not infringe third-party rights and that it has the right to transfer said rights to the Customer. |
| 8.3. Персональні дані кандидатів обробляються відповідно до Розділу 9 і застосовного законодавства про захист персональних даних. | 8.3. Candidates' personal data are processed under Section 9 and the applicable data-protection law. |

| Українська | English |
| --- | --- |
| **9. ЗАХИСТ ДАНИХ** | **9. DATA PROTECTION** |
| 9.1. Якщо надання Послуг передбачає обробку персональних даних (зокрема кандидатів), Сторони дотримуються Закону України «Про захист персональних даних» № 2297-VI та, де застосовно, Загального регламенту ЄС про захист даних (GDPR, Regulation (EU) 2016/679). | 9.1. Where the Services involve processing of personal data (including candidates'), the Parties comply with the Law of Ukraine "On Personal Data Protection" No. 2297-VI and, where applicable, the EU General Data Protection Regulation (GDPR, Regulation (EU) 2016/679). |
| 9.2. Виконавець обробляє персональні дані лише з метою надання Послуг та вживає розумних організаційних і технічних заходів захисту. | 9.2. The Contractor processes personal data solely for the purpose of providing the Services and applies reasonable organisational and technical safeguards. |
| 9.3. Сторони можуть укласти окрему угоду про обробку персональних даних (Data Processing Agreement, DPA), що матиме перевагу в частині обробки даних. | 9.3. The Parties may conclude a separate Data Processing Agreement (DPA), which prevails as to data processing. |

| Українська | English |
| --- | --- |
| **10. СТРОК ДІЇ ТА РОЗІРВАННЯ** | **10. TERM AND TERMINATION** |
| 10.1. Договір набирає чинності з {{onboardingDate}} і діє **12 (дванадцять) місяців**. | 10.1. The Agreement enters into force on {{onboardingDate}} and is valid for **12 (twelve) months**. |
| 10.2. Договір автоматично продовжується на наступні 12-місячні періоди, якщо жодна Сторона не повідомить іншу про непродовження **не пізніше ніж за 30 (тридцять) днів** до закінчення поточного строку. | 10.2. The Agreement is automatically renewed for successive 12-month periods unless either Party notifies the other of non-renewal **at least 30 (thirty) days** before the end of the current term. |
| 10.3. Будь-яка Сторона може достроково розірвати Договір, письмово повідомивши іншу Сторону **за 5 (п'ять) днів** до дати розірвання. | 10.3. Either Party may terminate the Agreement early by giving the other **5 (five) days'** prior written notice. |
| 10.4. **Нарахування бонусів (п. 5.1.2) припиняється з моменту надсилання повідомлення про непродовження або розірвання.** Водночас за спеціалістами, процес онбордингу яких уже триває на дату повідомлення, бонус добонусовується після їх успішного онбордингу. | 10.4. **Accrual of bonuses (cl. 5.1.2) ceases upon sending the notice of non-renewal or termination.** However, for specialists whose onboarding is already in progress as of the notice date, the bonus is still paid upon their successful onboarding. |
| 10.5. Розірвання Договору не звільняє Сторони від виконання зобов'язань, що виникли до дати розірвання (зокрема оплати фактично наданих Послуг та нарахованих бонусів за п. 10.4). | 10.5. Termination does not release the Parties from obligations arisen before the termination date (in particular payment for Services actually rendered and bonuses accrued under cl. 10.4). |

| Українська | English |
| --- | --- |
| **11. ІНШІ УМОВИ** | **11. MISCELLANEOUS** |
| 11.1. Усі зміни та доповнення до Договору вчиняються письмово та підписуються Сторонами. | 11.1. All amendments and supplements are made in writing and signed by the Parties. |
| 11.2. Договір може бути підписаний у двох примірниках або шляхом обміну сканованими/електронними копіями та/або з використанням кваліфікованого електронного підпису. | 11.2. The Agreement may be signed in two counterparts or by exchanging scanned/electronic copies and/or using a qualified electronic signature. |
| 11.3. У разі розбіжностей між українською та англійською версіями переважну силу має {{languagePriority}} версія. | 11.3. In case of discrepancies between the Ukrainian and English versions, the {{languagePriority}} version prevails. |

| Українська | English |
| --- | --- |
| **12. ЗАСТОСОВНЕ ПРАВО ТА ВИРІШЕННЯ СПОРІВ** | **12. GOVERNING LAW AND DISPUTE RESOLUTION** |
| 12.1. До Договору застосовується {{governingLaw}}. | 12.1. The Agreement is governed by {{governingLaw}}. |
| 12.2. Спори вирішуються шляхом переговорів; у разі недосягнення згоди протягом 30 днів — {{disputeForum}}. | 12.2. Disputes are resolved through negotiations; failing agreement within 30 days — {{disputeForum}}. |
| 12.3. Повідомлення, рахунки та обґрунтовані зауваження, надіслані електронною поштою на адреси Розділу 13 (а для оперативної комунікації — через узгоджені месенджери), вважаються належними. | 12.3. Notices, invoices and reasoned comments sent by email to the addresses in Section 13 (and, for operational communication, via agreed messengers) are deemed valid. |

| Українська | English |
| --- | --- |
| **13. РЕКВІЗИТИ ТА ПІДПИСИ СТОРІН** | **13. DETAILS AND SIGNATURES OF THE PARTIES** |
| **ЗАМОВНИК:** | **CUSTOMER:** |
| {{companyLegalName}} | {{companyLegalName}} |
| Юрисдикція / країна реєстрації: {{companyCountry}} | Jurisdiction / country of incorporation: {{companyCountry}} |
| Адреса: {{companyAddress}} | Address: {{companyAddress}} |
| Реєстраційний номер: {{companyRegNumber}} | Registration number: {{companyRegNumber}} |
| Податковий / VAT номер: {{companyVat}} | Tax / VAT number: {{companyVat}} |
| Банківські реквізити (IBAN / SWIFT): {{companyBank}} | Bank details (IBAN / SWIFT): {{companyBank}} |
| Підпис: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | Signature: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| **ВИКОНАВЕЦЬ:** | **CONTRACTOR:** |
| Фізична особа — підприємець {{employeeName}} | Private entrepreneur {{employeeName}} |
| Роль / Role: {{role}} | Role: {{role}} |
| E-mail: {{employeeEmail}} | E-mail: {{employeeEmail}} |
| РНОКПП: {{rnokpp}} | RNOKPP (tax number): {{rnokpp}} |
| Адреса реєстрації: {{registrationAddress}} | Registered address: {{registrationAddress}} |
| Телефон: {{phone}} | Phone: {{phone}} |
| Реквізити для оплати: {{requisites}} | Payment details: {{requisites}} |
| Банк (UAH, ФОП): {{bankUahFop}} | Bank account (UAH, FOP): {{bankUahFop}} |
| Гаманець USDT (за потреби): {{walletUsdt}} | USDT wallet (if applicable): {{walletUsdt}} |
| Переважний метод оплати: {{preferredMethod}} | Preferred payment method: {{preferredMethod}} |
| Підпис: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ | Signature: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |

---`,
}
