import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'

import { Pool } from 'pg'
import * as schema from './schema'

// ---------------------------------------------------------------------------
// Canonical UUIDs — must stay stable across reseeds (e2e fixtures + dev-login)
// ---------------------------------------------------------------------------
export const MAKSYM_ID = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
export const KOSTYA_ID = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'

// Pre-assigned stable UUIDs for canonical users so finance FKs are predictable
const OLEKSIY_ID = 'c1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f55'
const DMYTRO_ID = 'd2f3e4b5-c6d7-4e8f-9a0b-1c2d3e4f5a66'
const IVAN_ID = 'e3a4f5c6-d7e8-4f9a-0b1c-2d3e4f5a6b77'
const SOFIA_ID = 'f4b5a6d7-e8f9-4a0b-1c2d-3e4f5a6b7c88'
const ANNA_ID = 'a5c6b7e8-f9a0-4b1c-2d3e-4f5a6b7c8d99'
const KATERYNA_ID = 'b6d7c8f9-a0b1-4c2d-3e4f-5a6b7c8d9eaa'
const MYKOLA_ID = 'c7e8d9a0-b1c2-4d3e-4f5a-6b7c8d9e0fbb'
// Additional users
const ARTEM_ID = 'd8f9e0b1-c2d3-4e4f-5a6b-7c8d9e0f1acc'
const NAZAR_ID = 'e9a0f1c2-d3e4-4f5a-6b7c-8d9e0f1a2bdd'
const OKSANA_ID = 'f0b1a2d3-e4f5-4a6b-7c8d-9e0f1a2b3cee'
const YURIY_ID = 'a1c2b3e4-f5a6-4b7c-8d9e-0f1a2b3c4dff'
const LENA_ID = 'b2d3c4f5-a6b7-4c8d-9e0f-1a2b3c4d5e00'
const HR3_ID = 'c3e4d5a6-b7c8-4d9e-0f1a-2b3c4d5e6f11'
// DROP users
const DROP1_ID = 'd4f5e6b7-c8d9-4e0f-1a2b-3c4d5e6f7a22'
const DROP2_ID = 'e5a6f7c8-d9e0-4f1a-2b3c-4d5e6f7a8b33'
const DROP3_ID = 'f6b7a8d9-e0f1-4a2b-3c4d-5e6f7a8b9c44'
const DROP4_ID = 'a7c8b9e0-f1a2-4b3c-4d5e-6f7a8b9c0d55'
const DROP5_ID = 'b8d9c0f1-a2b3-4c4d-5e6f-7a8b9c0d1e66'
const DROP6_ID = 'c9e0d1a2-b3c4-4d5e-6f7a-8b9c0d1e2f77'

// ---------------------------------------------------------------------------
// Date helpers — 12-month window: 2025-06-05 → 2026-06-04
// ---------------------------------------------------------------------------
function d(year: number, month: number, day: number, hour = 10): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0))
}

// ---------------------------------------------------------------------------
// User definitions
// ---------------------------------------------------------------------------
const SEED_USERS: schema.NewUser[] = [
  // ---- ADMINs (2) ----
  {
    id: MAKSYM_ID,
    email: 'yaremenkomaksym99@gmail.com',
    displayName: 'Maksym Yaremenko',
    legalFullName: 'Яременко Максим Олександрович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=maksym',
    role: 'ADMIN',
    telegram: '@maksym_yaremenko',
    phone: '+380671000001',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x742d35Cc6634C0532925a3b8D40b34A9F0c0BC54',
    techStack: ['React', 'TypeScript', 'Node.js', 'NestJS', 'PostgreSQL'],
    createdAt: d(2025, 6, 5),
    updatedAt: d(2025, 6, 5),
  },
  {
    id: KOSTYA_ID,
    email: 'kostya@cheekycheeseit.com',
    displayName: 'Kostya',
    legalFullName: 'Костенко Костянтин Вікторович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=kostya',
    role: 'ADMIN',
    telegram: '@kostya_partner',
    phone: '+380671000002',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199',
    techStack: ['Vue.js', 'Python', 'Django', 'AWS'],
    createdAt: d(2025, 6, 5),
    updatedAt: d(2025, 6, 5),
  },

  // ---- SENIORs (4) ----
  {
    id: OLEKSIY_ID,
    email: 'oleksiy.kovalenko@cheekycheese.dev',
    displayName: 'Oleksiy Kovalenko',
    legalFullName: 'Коваленко Олексій Сергійович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=oleksiy',
    role: 'SENIOR',
    telegram: '@oleksiy_koval',
    phone: '+380671000003',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
    techStack: ['React', 'TypeScript', 'Node.js', 'Python', 'AWS'],
    createdAt: d(2025, 6, 5),
    updatedAt: d(2025, 6, 5),
  },
  {
    id: DMYTRO_ID,
    email: 'dmytro.marchenko@cheekycheese.dev',
    displayName: 'Dmytro Marchenko',
    legalFullName: 'Марченко Дмитро Олексійович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=dmytro',
    role: 'SENIOR',
    telegram: '@dmytro_march',
    phone: '+380671000004',
    seniorSharePercent: 26,
    // UN-ONBOARDED: no paymentMethod, no wallet — used for wizard testing (PR A)
    techStack: ['Vue.js', 'TypeScript', 'Python', 'PostgreSQL'],
    createdAt: d(2025, 7, 1),
    updatedAt: d(2025, 7, 1),
  },
  {
    id: ARTEM_ID,
    email: 'artem.kravchenko@cheekycheese.dev',
    displayName: 'Artem Kravchenko',
    legalFullName: 'Кравченко Артем Миколайович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=artem',
    role: 'SENIOR',
    telegram: '@artem_krav',
    phone: '+380671000011',
    seniorSharePercent: 26,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
    techStack: ['React', 'Next.js', 'TypeScript', 'Go', 'Docker'],
    createdAt: d(2025, 8, 15),
    updatedAt: d(2025, 8, 15),
  },
  {
    id: NAZAR_ID,
    email: 'nazar.ponomarenko@cheekycheese.dev',
    displayName: 'Nazar Ponomarenko',
    legalFullName: 'Пономаренко Назар Іванович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=nazar',
    role: 'SENIOR',
    telegram: '@nazar_pono',
    phone: '+380671000012',
    seniorSharePercent: 30,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB',
    techStack: ['Node.js', 'NestJS', 'TypeScript', 'Redis', 'Kubernetes'],
    createdAt: d(2025, 10, 1),
    updatedAt: d(2025, 10, 1),
  },

  // ---- JUNIORs (5) ----
  {
    id: SOFIA_ID,
    email: 'sofia.bondarenko@cheekycheese.dev',
    displayName: 'Sofia Bondarenko',
    legalFullName: 'Бондаренко Софія Олегівна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=sofia',
    role: 'JUNIOR',
    telegram: '@sofia_bond',
    phone: '+380671000005',
    monthlySalary: '500.00',
    salaryCurrency: 'USD',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Бондаренко Софія Олегівна',
    bankUahIban: 'UA213223130000026007233566001',
    bankUahRnokpp: '3456789012',
    bankUahBankName: 'ПриватБанк',
    techStack: ['React', 'Tailwind', 'TypeScript'],
    createdAt: d(2025, 6, 5),
    updatedAt: d(2025, 6, 5),
  },
  {
    id: IVAN_ID,
    email: 'ivan.petrenko@cheekycheese.dev',
    displayName: 'Ivan Petrenko',
    legalFullName: 'Петренко Іван Васильович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=ivan',
    role: 'JUNIOR',
    telegram: '@ivan_pet',
    phone: '+380671000006',
    monthlySalary: '600.00',
    salaryCurrency: 'USD',
    // Ivan is un-onboarded — no payment method set (test wizard JUNIOR)
    techStack: ['React', 'JavaScript', 'CSS'],
    createdAt: d(2025, 7, 10),
    updatedAt: d(2025, 7, 10),
  },
  {
    id: OKSANA_ID,
    email: 'oksana.melnyk@cheekycheese.dev',
    displayName: 'Oksana Melnyk',
    legalFullName: 'Мельник Оксана Павлівна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=oksana',
    role: 'JUNIOR',
    telegram: '@oksana_meln',
    phone: '+380671000013',
    monthlySalary: '550.00',
    salaryCurrency: 'USD',
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x617F2E2fD72FD9D5503197092AC168961b98769F',
    techStack: ['Vue.js', 'JavaScript', 'SCSS'],
    createdAt: d(2025, 8, 20),
    updatedAt: d(2025, 8, 20),
  },
  {
    id: YURIY_ID,
    email: 'yuriy.tkachenko@cheekycheese.dev',
    displayName: 'Yuriy Tkachenko',
    legalFullName: 'Ткаченко Юрій Анатолійович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=yuriy',
    role: 'JUNIOR',
    telegram: '@yuriy_tkach',
    phone: '+380671000014',
    monthlySalary: '500.00',
    salaryCurrency: 'USD',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Ткаченко Юрій Анатолійович',
    bankUahIban: 'UA443052990000026206555020567',
    bankUahRnokpp: '7890123456',
    bankUahBankName: 'monobank',
    techStack: ['React', 'TypeScript', 'REST API'],
    createdAt: d(2025, 10, 5),
    updatedAt: d(2025, 10, 5),
  },
  {
    id: LENA_ID,
    email: 'lena.hrytsenko@cheekycheese.dev',
    displayName: 'Lena Hrytsenko',
    legalFullName: 'Гриценко Олена Михайлівна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=lena',
    role: 'JUNIOR',
    telegram: '@lena_hrytsen',
    phone: '+380671000015',
    monthlySalary: '500.00',
    salaryCurrency: 'USD',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Гриценко Олена Михайлівна',
    bankUahIban: 'UA233220010000026201300038581',
    bankUahRnokpp: '8901234567',
    bankUahBankName: 'ПУМБ',
    techStack: ['Angular', 'TypeScript', 'Figma'],
    createdAt: d(2025, 12, 10),
    updatedAt: d(2025, 12, 10),
  },

  // ---- HRs (3) ----
  {
    id: ANNA_ID,
    email: 'anna.lysenko@cheekycheese.dev',
    displayName: 'Anna Lysenko',
    legalFullName: 'Лисенко Анна Вікторівна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=anna',
    role: 'HR',
    telegram: '@anna_lysenko',
    phone: '+380671000007',
    monthlySalary: '800.00',
    salaryCurrency: 'USD',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Лисенко Анна Вікторівна',
    bankUahIban: 'UA213223130000026007233566002',
    bankUahRnokpp: '2345678901',
    bankUahBankName: 'ПриватБанк',
    createdAt: d(2025, 6, 5),
    updatedAt: d(2025, 6, 5),
  },
  {
    id: KATERYNA_ID,
    email: 'kateryna.shevchenko@cheekycheese.dev',
    displayName: 'Kateryna Shevchenko',
    legalFullName: 'Шевченко Катерина Олексіївна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=kateryna',
    role: 'HR',
    telegram: '@kate_shevch',
    phone: '+380671000008',
    monthlySalary: '800.00',
    salaryCurrency: 'USD',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Шевченко Катерина Олексіївна',
    bankUahIban: 'UA213223130000026007233566003',
    bankUahRnokpp: '5678901234',
    bankUahBankName: 'monobank',
    createdAt: d(2025, 6, 5),
    updatedAt: d(2025, 6, 5),
  },
  {
    id: HR3_ID,
    email: 'daryna.kovalchuk@cheekycheese.dev',
    displayName: 'Daryna Kovalchuk',
    legalFullName: 'Ковальчук Дарина Сергіївна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=daryna',
    role: 'HR',
    telegram: '@daryna_koval',
    phone: '+380671000016',
    monthlySalary: '750.00',
    salaryCurrency: 'USD',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Ковальчук Дарина Сергіївна',
    bankUahIban: 'UA093052990000026204444020123',
    bankUahRnokpp: '9012345678',
    bankUahBankName: 'Ощадбанк',
    createdAt: d(2025, 9, 1),
    updatedAt: d(2025, 9, 1),
  },

  // ---- ACCOUNTANT (1) ----
  {
    id: MYKOLA_ID,
    email: 'mykola.savchenko@cheekycheese.dev',
    displayName: 'Mykola Savchenko',
    legalFullName: 'Савченко Микола Григорович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=mykola',
    role: 'ACCOUNTANT',
    telegram: '@mykola_savc',
    phone: '+380671000009',
    monthlySalary: '900.00',
    salaryCurrency: 'USD',
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Савченко Микола Григорович',
    bankUahIban: 'UA213223130000026007233566004',
    bankUahRnokpp: '6789012345',
    bankUahBankName: 'ПриватБанк',
    createdAt: d(2025, 6, 5),
    updatedAt: d(2025, 6, 5),
  },

  // ---- DROPs (6) ----
  {
    id: DROP1_ID,
    email: 'viktor.drop@cheekycheese.dev',
    displayName: 'Viktor Drozhzhyn',
    legalFullName: 'Дрожжин Віктор Олегович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=viktor',
    role: 'DROP',
    telegram: '@viktor_drop',
    phone: '+380671000020',
    dropSharePercent: 5,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec',
    techStack: ['Python', 'Data Science', 'ML'],
    createdAt: d(2025, 7, 1),
    updatedAt: d(2025, 7, 1),
  },
  {
    id: DROP2_ID,
    email: 'olena.drop@cheekycheese.dev',
    displayName: 'Olena Drozdova',
    legalFullName: 'Дроздова Олена Борисівна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=olena_drop',
    role: 'DROP',
    telegram: '@olena_droz',
    phone: '+380671000021',
    dropSharePercent: 5,
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Дроздова Олена Борисівна',
    bankUahIban: 'UA153052990000026201111020999',
    bankUahRnokpp: '1122334455',
    bankUahBankName: 'ПриватБанк',
    techStack: ['Java', 'Spring Boot', 'AWS'],
    createdAt: d(2025, 7, 15),
    updatedAt: d(2025, 7, 15),
  },
  {
    id: DROP3_ID,
    email: 'roman.drop@cheekycheese.dev',
    displayName: 'Roman Drobotenko',
    legalFullName: 'Дроботенко Роман Петрович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=roman_drop',
    role: 'DROP',
    telegram: '@roman_drob',
    phone: '+380671000022',
    dropSharePercent: 7,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0xdD870fA1b7C4700F2BD7f44238821C26f7392148',
    techStack: ['PHP', 'Laravel', 'MySQL'],
    createdAt: d(2025, 8, 1),
    updatedAt: d(2025, 8, 1),
  },
  {
    id: DROP4_ID,
    email: 'marta.drop@cheekycheese.dev',
    displayName: 'Marta Drozd',
    legalFullName: 'Дрозд Марта Іванівна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=marta_drop',
    role: 'DROP',
    telegram: '@marta_drozd',
    phone: '+380671000023',
    dropSharePercent: 5,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x583031D1113aD414F02576BD6afaBfb302140225',
    techStack: ['iOS', 'Swift', 'Objective-C'],
    createdAt: d(2025, 9, 15),
    updatedAt: d(2025, 9, 15),
  },
  {
    id: DROP5_ID,
    email: 'serhiy.drop@cheekycheese.dev',
    displayName: 'Serhiy Drofa',
    legalFullName: 'Дрофа Сергій Васильович',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=serhiy_drop',
    role: 'DROP',
    telegram: '@serhiy_drofa',
    phone: '+380671000024',
    dropSharePercent: 6,
    paymentMethod: 'BANK_UAH_FOP',
    bankUahRecipient: 'Дрофа Сергій Васильович',
    bankUahIban: 'UA253052990000026208888020456',
    bankUahRnokpp: '5566778899',
    bankUahBankName: 'monobank',
    techStack: ['Android', 'Kotlin', 'Java'],
    createdAt: d(2025, 10, 20),
    updatedAt: d(2025, 10, 20),
  },
  {
    id: DROP6_ID,
    email: 'tamara.drop@cheekycheese.dev',
    displayName: 'Tamara Drobysh',
    legalFullName: 'Дробиш Тамара Григорівна',
    avatarUrl: 'https://api.dicebear.com/9.x/avataaars/svg?seed=tamara_drop',
    role: 'DROP',
    telegram: '@tamara_drob',
    phone: '+380671000025',
    dropSharePercent: 5,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x4B0897b0513fdC7C541B6d9D7E929C4e5364D2dB',
    techStack: ['Ruby', 'Rails', 'PostgreSQL'],
    createdAt: d(2025, 11, 1),
    updatedAt: d(2025, 11, 1),
  },
]

// ---------------------------------------------------------------------------
// Contract template bodies (placeholders matching OnboardingService)
// ---------------------------------------------------------------------------
const CONTRACT_BODY: Record<string, string> = {
  SENIOR: `# Договір з Cheeky Cheese IT — Senior розробник

Версія 1 — 2025-06-05

**Сторони:**
- Компанія: Cheeky Cheese IT (надалі — Компанія)
- Виконавець: {{employeeName}} (надалі — Старший розробник)

## 1. Предмет договору

Старший розробник зобов'язується надавати послуги з розробки програмного забезпечення відповідно до завдань, визначених Компанією.

## 2. Умови оплати

- Форма оплати: {{preferredMethod}}
- Реквізити: {{walletUsdt}}{{bankUahFop}}
- Частка доходу: 26% від суми проекту

## 3. Термін дії

Договір набуває чинності з {{onboardingDate}} і діє безстроково до розірвання.

## 4. Конфіденційність

Виконавець зобов'язується не розголошувати дані клієнтів Компанії.

---

Підписано: {{employeeName}}
Дата підписання: {{onboardingDate}}`,

  JUNIOR: `# Договір з Cheeky Cheese IT — Junior розробник

Версія 1 — 2025-06-05

**Сторони:**
- Компанія: Cheeky Cheese IT
- Виконавець: {{employeeName}}

## 1. Предмет договору

Молодший розробник надає послуги відповідно до завдань проекту під керівництвом Senior розробника.

## 2. Умови оплати

- Форма оплати: {{preferredMethod}}
- Реквізити: {{walletUsdt}}{{bankUahFop}}
- Фіксована щомісячна ставка погоджується індивідуально

## 3. Термін дії

З {{onboardingDate}} безстроково.

---

Підписано: {{employeeName}}
Дата: {{onboardingDate}}`,

  HR: `# Договір з Cheeky Cheese IT — HR менеджер

Версія 1 — 2025-06-05

**Сторони:**
- Компанія: Cheeky Cheese IT
- Виконавець: {{employeeName}}

## 1. Предмет договору

HR менеджер забезпечує рекрутинг та комунікацію з клієнтами від імені розробників.

## 2. Умови оплати

- Форма оплати: {{preferredMethod}}
- Реквізити: {{bankUahFop}}
- Фіксована щомісячна ставка

## 3. Термін дії

З {{onboardingDate}} безстроково.

---

Підписано: {{employeeName}}
Дата: {{onboardingDate}}`,

  ACCOUNTANT: `# Договір з Cheeky Cheese IT — Бухгалтер

Версія 1 — 2025-06-05

**Сторони:**
- Компанія: Cheeky Cheese IT
- Виконавець: {{employeeName}}

## 1. Предмет договору

Бухгалтер здійснює фінансовий контроль, валідацію транзакцій та підготовку звітності.

## 2. Умови оплати

- Форма оплати: {{preferredMethod}}
- Реквізити: {{bankUahFop}}
- Фіксована щомісячна ставка

## 3. Термін дії

З {{onboardingDate}} безстроково.

---

Підписано: {{employeeName}}
Дата: {{onboardingDate}}`,

  DROP: `# Договір з Cheeky Cheese IT — Дроп партнер

Версія 1 — 2025-06-05

**Сторони:**
- Компанія: Cheeky Cheese IT
- Виконавець: {{employeeName}}

## 1. Предмет договору

Дроп партнер забезпечує канал залучення клієнтів або проектів для Компанії.

## 2. Умови оплати

- Форма оплати: {{preferredMethod}}
- Реквізити: {{walletUsdt}}{{bankUahFop}}
- Частка від доходу проекту: визначається індивідуально

## 3. Термін дії

З {{onboardingDate}} безстроково.

---

Підписано: {{employeeName}}
Дата: {{onboardingDate}}`,
}

// ---------------------------------------------------------------------------
// ToS body
// ---------------------------------------------------------------------------
const TOS_BODY = `# Умови використання (Terms of Service) — Cheeky Cheese IT

Версія 1 — 2025-06-05

## 1. Загальні положення

Використовуючи CRM-систему Cheeky Cheese IT, ви погоджуєтесь з цими умовами.

## 2. Обов'язки користувача

- Зберігати конфіденційність даних клієнтів
- Не передавати доступ третім особам
- Своєчасно оновлювати реквізити для виплат
- Повідомляти про технічні проблеми через систему

## 3. Обробка персональних даних

Компанія обробляє персональні дані відповідно до законодавства України.

## 4. Відповідальність

Користувач несе відповідальність за коректність введених фінансових реквізитів.

## 5. Зміни умов

Нові версії публікуються через CRM з повідомленням. Продовження роботи = прийняття нових умов.

---

Cheeky Cheese IT, 2025`

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------
async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')

  const pool = new Pool({ connectionString: databaseUrl })
  const db = drizzle(pool, { schema })

  console.log('=== Seeding 12-month realistic dataset ===')

  // ---- 1. Truncate all data (order matters for FK constraints) ----
  console.log('\n[1/8] Truncating existing data...')
  await db.execute(
    'TRUNCATE TABLE tos_acceptances, employee_contracts, signed_contracts, tos_versions, contract_templates, notifications, user_audit_log, team_audit_log, project_audit_log, invoice_signatures, pending_obligations, transactions, payout_requests, project_finance_settings, project_members, projects, interviews, team_members, teams, documents, users RESTART IDENTITY CASCADE' as unknown as Parameters<
      typeof db.execute
    >[0],
  )
  console.log('  ✓ Tables truncated')

  // ---- 2. Users ----
  console.log('\n[2/8] Inserting users...')
  await db.insert(schema.users).values(SEED_USERS)
  console.log(`  ✓ ${SEED_USERS.length} users inserted`)

  // ---- 3. Teams ----
  console.log('\n[3/8] Inserting teams...')

  // Team 1: Oleksiy's team (Anna HR)
  const team1Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Kovalenko',
      type: 'SENIOR',
      telegram: '@team_kovalenko',
      notes: 'AI/ML та EdTech проекти',
      createdAt: d(2025, 6, 5),
      updatedAt: d(2025, 6, 5),
    })
    .returning()
  const team1 = team1Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team1.id, userId: ANNA_ID, joinedAt: d(2025, 6, 5) },
    { teamId: team1.id, userId: OLEKSIY_ID, joinedAt: d(2025, 6, 5) },
    { teamId: team1.id, userId: MYKOLA_ID, joinedAt: d(2025, 6, 5) },
  ])

  // Team 2: Dmytro's team (Kateryna HR) — Dmytro is un-onboarded but team exists
  const team2Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Marchenko',
      type: 'SENIOR',
      telegram: '@team_marchenko',
      notes: 'Фінтех та SaaS',
      createdAt: d(2025, 7, 1),
      updatedAt: d(2025, 7, 1),
    })
    .returning()
  const team2 = team2Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team2.id, userId: KATERYNA_ID, joinedAt: d(2025, 7, 1) },
    { teamId: team2.id, userId: DMYTRO_ID, joinedAt: d(2025, 7, 1) },
    { teamId: team2.id, userId: MYKOLA_ID, joinedAt: d(2025, 7, 1) },
  ])

  // Team 3: Artem's team (Daryna HR)
  const team3Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Kravchenko',
      type: 'SENIOR',
      telegram: '@team_kravchenko',
      notes: 'E-Commerce та мобайл',
      createdAt: d(2025, 8, 15),
      updatedAt: d(2025, 8, 15),
    })
    .returning()
  const team3 = team3Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team3.id, userId: HR3_ID, joinedAt: d(2025, 8, 15) },
    { teamId: team3.id, userId: ARTEM_ID, joinedAt: d(2025, 8, 15) },
    { teamId: team3.id, userId: MYKOLA_ID, joinedAt: d(2025, 8, 15) },
  ])

  // Team 4: Nazar's team (Anna HR also manages)
  const team4Rows = await db
    .insert(schema.teams)
    .values({
      name: 'Team Ponomarenko',
      type: 'SENIOR',
      telegram: '@team_ponomarenko',
      notes: 'DevOps та Cloud-проекти',
      createdAt: d(2025, 10, 1),
      updatedAt: d(2025, 10, 1),
    })
    .returning()
  const team4 = team4Rows[0]!
  await db.insert(schema.teamMembers).values([
    { teamId: team4.id, userId: ANNA_ID, joinedAt: d(2025, 10, 1) },
    { teamId: team4.id, userId: NAZAR_ID, joinedAt: d(2025, 10, 1) },
    { teamId: team4.id, userId: MYKOLA_ID, joinedAt: d(2025, 10, 1) },
  ])
  console.log('  ✓ 4 teams + members inserted')

  // ---- 4. Projects (~8) ----
  console.log('\n[4/8] Inserting projects...')

  // Project 1: TechCorp AI — Oleksiy, Sofia (CLOSED Jul 2025 – Nov 2025)
  const proj1Rows = await db
    .insert(schema.projects)
    .values({
      name: 'AI Platform v2',
      companyName: 'TechCorp AI',
      domain: 'ai-techcorp.io',
      startDate: d(2025, 6, 10),
      seniorId: OLEKSIY_ID,
      rate: 5000,
      currency: 'USDT',
      techStack: 'Python, TensorFlow, FastAPI, PostgreSQL',
      archivedAt: d(2025, 11, 30),
      createdAt: d(2025, 6, 10),
      updatedAt: d(2025, 11, 30),
    })
    .returning()
  const proj1 = proj1Rows[0]!
  // Sofia was active member, left when project closed
  await db.insert(schema.projectMembers).values({
    projectId: proj1.id,
    userId: SOFIA_ID,
    joinedAt: d(2025, 6, 10),
    leftAt: d(2025, 11, 30),
  })

  // Project 2: LearnSpace LMS — Oleksiy (ACTIVE, Jan 2026–)
  const proj2Rows = await db
    .insert(schema.projects)
    .values({
      name: 'LearnSpace LMS',
      companyName: 'LearnSpace Inc',
      domain: 'learnspace.io',
      startDate: d(2026, 1, 5),
      seniorId: OLEKSIY_ID,
      rate: 4500,
      currency: 'USD',
      techStack: 'React, Node.js, PostgreSQL, Redis',
      createdAt: d(2026, 1, 5),
      updatedAt: d(2026, 1, 5),
    })
    .returning()
  const proj2 = proj2Rows[0]!
  // Sofia is active junior on proj2
  await db.insert(schema.projectMembers).values({
    projectId: proj2.id,
    userId: SOFIA_ID,
    joinedAt: d(2026, 1, 5),
  })

  // Project 3: Ferm E-Commerce — Dmytro (ACTIVE, Jul 2025–)
  const proj3Rows = await db
    .insert(schema.projects)
    .values({
      name: 'Ferm E-Commerce',
      companyName: 'Ferm',
      domain: 'ferm.ua',
      startDate: d(2025, 7, 15),
      seniorId: DMYTRO_ID,
      rate: 3500,
      currency: 'USD',
      techStack: 'Vue.js, Python, Django, PostgreSQL',
      createdAt: d(2025, 7, 15),
      updatedAt: d(2025, 7, 15),
    })
    .returning()
  const proj3 = proj3Rows[0]!
  // Oksana is active junior on proj3
  await db.insert(schema.projectMembers).values({
    projectId: proj3.id,
    userId: OKSANA_ID,
    joinedAt: d(2025, 8, 20),
  })

  // Project 4: OnePunch SaaS — Artem (ACTIVE, Sep 2025–)
  const proj4Rows = await db
    .insert(schema.projects)
    .values({
      name: 'OnePunch Dashboard',
      companyName: 'One Punch',
      domain: 'onepunch.app',
      startDate: d(2025, 9, 1),
      seniorId: ARTEM_ID,
      rate: 4000,
      currency: 'USD',
      techStack: 'React, Next.js, TypeScript, Go',
      createdAt: d(2025, 9, 1),
      updatedAt: d(2025, 9, 1),
    })
    .returning()
  const proj4 = proj4Rows[0]!
  // Yuriy is active junior on proj4
  await db.insert(schema.projectMembers).values({
    projectId: proj4.id,
    userId: YURIY_ID,
    joinedAt: d(2025, 10, 5),
  })

  // Project 5: Artkai Design System — Artem (CLOSED, Aug–Dec 2025)
  const proj5Rows = await db
    .insert(schema.projects)
    .values({
      name: 'Artkai Design System',
      companyName: 'Artkai',
      domain: 'artkai.io',
      startDate: d(2025, 8, 15),
      seniorId: ARTEM_ID,
      rate: 4200,
      currency: 'USD',
      techStack: 'React, Storybook, Figma API',
      archivedAt: d(2025, 12, 31),
      createdAt: d(2025, 8, 15),
      updatedAt: d(2025, 12, 31),
    })
    .returning()
  const proj5 = proj5Rows[0]!
  // Lena was junior, left when project closed
  await db.insert(schema.projectMembers).values({
    projectId: proj5.id,
    userId: LENA_ID,
    joinedAt: d(2025, 12, 10),
    leftAt: d(2025, 12, 31),
  })

  // Project 6: CloudOps Platform — Nazar (ACTIVE, Oct 2025–)
  const proj6Rows = await db
    .insert(schema.projects)
    .values({
      name: 'CloudOps Platform',
      companyName: 'CloudOps UA',
      domain: 'cloudops.ua',
      startDate: d(2025, 10, 15),
      seniorId: NAZAR_ID,
      rate: 5500,
      currency: 'USDT',
      techStack: 'NestJS, Kubernetes, Terraform, AWS',
      createdAt: d(2025, 10, 15),
      updatedAt: d(2025, 10, 15),
    })
    .returning()
  const proj6 = proj6Rows[0]!
  // Lena is active junior on proj6 (she joined Jan 2026)
  await db.insert(schema.projectMembers).values({
    projectId: proj6.id,
    userId: LENA_ID,
    joinedAt: d(2026, 1, 15),
  })

  // Project 7: FinTrack Mobile — Nazar (ACTIVE, Feb 2026–)
  const proj7Rows = await db
    .insert(schema.projects)
    .values({
      name: 'FinTrack Mobile',
      companyName: 'FinTrack Ltd',
      domain: 'fintrack.app',
      startDate: d(2026, 2, 1),
      seniorId: NAZAR_ID,
      rate: 5000,
      currency: 'USDT',
      techStack: 'NestJS, React Native, PostgreSQL',
      createdAt: d(2026, 2, 1),
      updatedAt: d(2026, 2, 1),
    })
    .returning()
  const proj7 = proj7Rows[0]!

  // Project 8: Oleksiy solo (ADMIN-owned context not applicable for Oleksiy)
  // Keeping 8 projects total
  const proj8Rows = await db
    .insert(schema.projects)
    .values({
      name: 'RetailPOS Integration',
      companyName: 'RetailTech UA',
      domain: 'retailtech.ua',
      startDate: d(2025, 11, 1),
      seniorId: OLEKSIY_ID,
      rate: 3800,
      currency: 'USD',
      techStack: 'Node.js, React, REST API',
      createdAt: d(2025, 11, 1),
      updatedAt: d(2025, 11, 1),
    })
    .returning()
  const proj8 = proj8Rows[0]!
  // Ivan is active junior on proj8 (Ivan is un-onboarded but can be member)
  await db.insert(schema.projectMembers).values({
    projectId: proj8.id,
    userId: IVAN_ID,
    joinedAt: d(2025, 11, 1),
  })

  console.log('  ✓ 8 projects + members inserted')

  // ---- 5. Interviews (~12) ----
  console.log('\n[5/8] Inserting interviews...')
  await db.insert(schema.interviews).values([
    // Oleksiy's interviews
    {
      seniorId: OLEKSIY_ID,
      hrId: ANNA_ID,
      companyName: 'DataLens Corp',
      vacancyUrl: 'https://datalens.io/jobs/senior-react',
      stage: 'HIRED',
      notesDomain: 'Data Visualization',
      notesTechStack: 'React, D3.js, TypeScript',
      notesPaymentType: 'USDT',
      position: 0,
      createdAt: d(2025, 6, 15),
      updatedAt: d(2025, 7, 20),
    },
    {
      seniorId: OLEKSIY_ID,
      hrId: ANNA_ID,
      companyName: 'TechCorp AI',
      vacancyUrl: 'https://techcorp-ai.io/jobs/lead-dev',
      stage: 'HIRED',
      notesDomain: 'AI / ML',
      notesTechStack: 'Python, TensorFlow, FastAPI',
      notesPaymentType: 'USDT',
      position: 0,
      createdAt: d(2025, 6, 8),
      updatedAt: d(2025, 6, 20),
    },
    {
      seniorId: OLEKSIY_ID,
      hrId: ANNA_ID,
      companyName: 'LearnSpace Inc',
      vacancyUrl: 'https://learnspace.io/jobs/fullstack',
      stage: 'HIRED',
      notesDomain: 'EdTech / LMS',
      notesTechStack: 'React, Node.js, PostgreSQL',
      notesPaymentType: 'USD',
      position: 0,
      createdAt: d(2025, 12, 10),
      updatedAt: d(2026, 1, 5),
    },
    {
      seniorId: OLEKSIY_ID,
      hrId: ANNA_ID,
      companyName: 'BlockHealth',
      vacancyUrl: 'https://blockhealth.io/jobs/web3-dev',
      stage: 'REJECTED',
      notesDomain: 'Web3 / Healthcare',
      notesTechStack: 'Solidity, React, Node.js',
      notesGeneral: 'Не вийшла за бенефітами',
      position: 0,
      createdAt: d(2025, 9, 5),
      updatedAt: d(2025, 9, 25),
    },
    // Dmytro's interviews (un-onboarded)
    {
      seniorId: DMYTRO_ID,
      hrId: KATERYNA_ID,
      companyName: 'Ferm',
      vacancyUrl: 'https://ferm.ua/careers/fullstack',
      stage: 'HIRED',
      notesDomain: 'E-Commerce',
      notesTechStack: 'Vue.js, Python, Django',
      notesPaymentType: 'USD',
      position: 0,
      createdAt: d(2025, 7, 1),
      updatedAt: d(2025, 7, 15),
    },
    {
      seniorId: DMYTRO_ID,
      hrId: KATERYNA_ID,
      companyName: 'Finex Global',
      vacancyUrl: 'https://finex.com/jobs/backend',
      stage: 'ARCHIVED',
      notesDomain: 'FinTech',
      notesGeneral: 'Зникли після tech interview',
      position: 0,
      createdAt: d(2025, 11, 1),
      updatedAt: d(2025, 11, 20),
    },
    {
      seniorId: DMYTRO_ID,
      hrId: KATERYNA_ID,
      companyName: 'CryptoHub',
      vacancyUrl: 'https://cryptohub.io/jobs/senior',
      stage: 'TECH_INTERVIEW',
      notesDomain: 'Crypto / DeFi',
      notesTechStack: 'TypeScript, Node.js, Solidity',
      position: 0,
      createdAt: d(2026, 3, 1),
      updatedAt: d(2026, 4, 10),
    },
    // Artem's interviews
    {
      seniorId: ARTEM_ID,
      hrId: HR3_ID,
      companyName: 'One Punch',
      vacancyUrl: 'https://onepunch.app/jobs/frontend',
      stage: 'HIRED',
      notesDomain: 'SaaS / Dashboard',
      notesTechStack: 'React, Next.js, TypeScript, Go',
      notesPaymentType: 'USD',
      position: 0,
      createdAt: d(2025, 8, 20),
      updatedAt: d(2025, 9, 1),
    },
    {
      seniorId: ARTEM_ID,
      hrId: HR3_ID,
      companyName: 'Artkai',
      vacancyUrl: 'https://artkai.io/careers/lead',
      stage: 'HIRED',
      notesDomain: 'Design Systems',
      notesTechStack: 'React, Storybook, Figma',
      notesPaymentType: 'USD',
      position: 0,
      createdAt: d(2025, 8, 10),
      updatedAt: d(2025, 8, 15),
    },
    {
      seniorId: ARTEM_ID,
      hrId: HR3_ID,
      companyName: 'RetailTech UA',
      vacancyUrl: 'https://retailtech.ua/jobs/senior',
      stage: 'OFFER_RECEIVED',
      notesDomain: 'Retail / POS',
      notesTechStack: 'Node.js, React, REST API',
      notesPaymentType: 'USD',
      position: 0,
      createdAt: d(2025, 10, 15),
      updatedAt: d(2025, 10, 30),
    },
    // Nazar's interviews
    {
      seniorId: NAZAR_ID,
      hrId: ANNA_ID,
      companyName: 'CloudOps UA',
      vacancyUrl: 'https://cloudops.ua/careers/devops',
      stage: 'HIRED',
      notesDomain: 'DevOps / Cloud',
      notesTechStack: 'Kubernetes, Terraform, AWS',
      notesPaymentType: 'USDT',
      position: 0,
      createdAt: d(2025, 9, 20),
      updatedAt: d(2025, 10, 15),
    },
    {
      seniorId: NAZAR_ID,
      hrId: ANNA_ID,
      companyName: 'FinTrack Ltd',
      vacancyUrl: 'https://fintrack.app/jobs/backend',
      stage: 'HIRED',
      notesDomain: 'FinTech / Mobile',
      notesTechStack: 'NestJS, React Native, PostgreSQL',
      notesPaymentType: 'USDT',
      position: 0,
      createdAt: d(2026, 1, 10),
      updatedAt: d(2026, 2, 1),
    },
  ])
  console.log('  ✓ 12 interviews inserted')

  // ---- 6. Finance — transactions, exchange_rate ----
  console.log('\n[6/8] Inserting finance data...')

  // NBU exchange rates — monthly for 12 months
  interface ExchangeRateRow {
    currency: 'USD' | 'EUR'
    rateToUah: string
    rateDate: Date
    source: string
  }
  const exchangeRates: ExchangeRateRow[] = [
    { currency: 'USD', rateToUah: '41.20', rateDate: d(2025, 6, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '44.80', rateDate: d(2025, 6, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.35', rateDate: d(2025, 7, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.10', rateDate: d(2025, 7, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.50', rateDate: d(2025, 8, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.30', rateDate: d(2025, 8, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.65', rateDate: d(2025, 9, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.55', rateDate: d(2025, 9, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '41.80', rateDate: d(2025, 10, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.70', rateDate: d(2025, 10, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.00', rateDate: d(2025, 11, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '45.90', rateDate: d(2025, 11, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.20', rateDate: d(2025, 12, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.10', rateDate: d(2025, 12, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.50', rateDate: d(2026, 1, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.40', rateDate: d(2026, 1, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.70', rateDate: d(2026, 2, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.60', rateDate: d(2026, 2, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '42.90', rateDate: d(2026, 3, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '46.80', rateDate: d(2026, 3, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '43.10', rateDate: d(2026, 4, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '47.00', rateDate: d(2026, 4, 1), source: 'NBU' },
    { currency: 'USD', rateToUah: '43.30', rateDate: d(2026, 5, 1), source: 'NBU' },
    { currency: 'EUR', rateToUah: '47.20', rateDate: d(2026, 5, 1), source: 'NBU' },
  ]
  // exchange_rate table check
  const hasCurrencyCol = await db.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_name='exchange_rate' AND column_name='currency' LIMIT 1" as unknown as Parameters<
      typeof db.execute
    >[0],
  )
  if (hasCurrencyCol.rows.length > 0) {
    for (const rate of exchangeRates) {
      await db.execute(
        `INSERT INTO exchange_rate (currency, rate_to_uah, rate_date, source) VALUES ('${rate.currency}', ${rate.rateToUah}, '${rate.rateDate.toISOString()}', '${rate.source}') ON CONFLICT DO NOTHING` as unknown as Parameters<
          typeof db.execute
        >[0],
      )
    }
    console.log('  ✓ 24 exchange rates inserted')
  } else {
    console.log('  ~ exchange_rate table not in expected shape, skipping rates')
  }

  // SENIOR_INCOME transactions — Oleksiy on proj1 (Jun–Nov 2025, PAID)
  interface TxInput {
    type: schema.NewTransaction['type']
    status: schema.NewTransaction['status']
    amount: string
    currency: schema.NewTransaction['currency']
    senderId?: string
    senderLabel?: string
    receiverId?: string
    receiverLabel?: string
    projectId?: string
    seniorSharePercent?: number
    seniorSharePercentSource?: string
    validatedBy?: string
    validatedAt?: Date
    txDate: Date
    createdBy: string
    createdAt: Date
    notes?: string
    salaryMonth?: string
  }
  const txRows: TxInput[] = []

  // Oleksiy — proj1 (PAID old transactions Jun–Oct 2025)
  for (let m = 6; m <= 10; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '5000.000000',
      currency: 'USDT',
      senderId: OLEKSIY_ID,
      senderLabel: 'TechCorp AI',
      receiverId: OLEKSIY_ID,
      projectId: proj1.id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2025, m, 10),
      txDate: d(2025, m, 5),
      createdBy: OLEKSIY_ID,
      createdAt: d(2025, m, 5),
    })
  }
  // Nov 2025 proj1 — VALIDATED (project closed, payout pending)
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '5000.000000',
    currency: 'USDT',
    senderId: OLEKSIY_ID,
    senderLabel: 'TechCorp AI',
    receiverId: OLEKSIY_ID,
    projectId: proj1.id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    validatedBy: MYKOLA_ID,
    validatedAt: d(2025, 11, 10),
    txDate: d(2025, 11, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2025, 11, 5),
  })

  // Oleksiy — proj2 LearnSpace (Jan–May 2026, mix statuses)
  for (let m = 1; m <= 3; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '4500.000000',
      currency: 'USD',
      senderId: OLEKSIY_ID,
      senderLabel: 'LearnSpace Inc',
      receiverId: OLEKSIY_ID,
      projectId: proj2.id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2026, m, 8),
      txDate: d(2026, m, 5),
      createdBy: OLEKSIY_ID,
      createdAt: d(2026, m, 5),
    })
  }
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '4500.000000',
    currency: 'USD',
    senderId: OLEKSIY_ID,
    senderLabel: 'LearnSpace Inc',
    receiverId: OLEKSIY_ID,
    projectId: proj2.id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    validatedBy: MYKOLA_ID,
    validatedAt: d(2026, 4, 8),
    txDate: d(2026, 4, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2026, 4, 5),
  })
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '4500.000000',
    currency: 'USD',
    senderId: OLEKSIY_ID,
    senderLabel: 'LearnSpace Inc',
    receiverId: OLEKSIY_ID,
    projectId: proj2.id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    txDate: d(2026, 5, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2026, 5, 5),
  })

  // Artem — proj4 OnePunch (Sep 2025–Apr 2026)
  for (let m = 9; m <= 12; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '4000.000000',
      currency: 'USD',
      senderId: ARTEM_ID,
      senderLabel: 'One Punch',
      receiverId: ARTEM_ID,
      projectId: proj4.id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2025, m, 12),
      txDate: d(2025, m, 8),
      createdBy: ARTEM_ID,
      createdAt: d(2025, m, 8),
    })
  }
  for (let m = 1; m <= 3; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '4000.000000',
      currency: 'USD',
      senderId: ARTEM_ID,
      senderLabel: 'One Punch',
      receiverId: ARTEM_ID,
      projectId: proj4.id,
      seniorSharePercent: 26,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2026, m, 12),
      txDate: d(2026, m, 8),
      createdBy: ARTEM_ID,
      createdAt: d(2026, m, 8),
    })
  }
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '4000.000000',
    currency: 'USD',
    senderId: ARTEM_ID,
    senderLabel: 'One Punch',
    receiverId: ARTEM_ID,
    projectId: proj4.id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    txDate: d(2026, 4, 8),
    createdBy: ARTEM_ID,
    createdAt: d(2026, 4, 8),
  })

  // Nazar — proj6 CloudOps (Oct 2025–Apr 2026)
  for (let m = 10; m <= 12; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'PAID',
      amount: '5500.000000',
      currency: 'USDT',
      senderId: NAZAR_ID,
      senderLabel: 'CloudOps UA',
      receiverId: NAZAR_ID,
      projectId: proj6.id,
      seniorSharePercent: 30,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2025, m, 15),
      txDate: d(2025, m, 10),
      createdBy: NAZAR_ID,
      createdAt: d(2025, m, 10),
    })
  }
  for (let m = 1; m <= 2; m++) {
    txRows.push({
      type: 'SENIOR_INCOME',
      status: 'VALIDATED',
      amount: '5500.000000',
      currency: 'USDT',
      senderId: NAZAR_ID,
      senderLabel: 'CloudOps UA',
      receiverId: NAZAR_ID,
      projectId: proj6.id,
      seniorSharePercent: 30,
      seniorSharePercentSource: 'USER_DEFAULT',
      validatedBy: MYKOLA_ID,
      validatedAt: d(2026, m, 15),
      txDate: d(2026, m, 10),
      createdBy: NAZAR_ID,
      createdAt: d(2026, m, 10),
    })
  }
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '5500.000000',
    currency: 'USDT',
    senderId: NAZAR_ID,
    senderLabel: 'CloudOps UA',
    receiverId: NAZAR_ID,
    projectId: proj6.id,
    seniorSharePercent: 30,
    seniorSharePercentSource: 'USER_DEFAULT',
    txDate: d(2026, 3, 10),
    createdBy: NAZAR_ID,
    createdAt: d(2026, 3, 10),
  })

  // One REJECTED transaction — Oleksiy (typo in amount)
  txRows.push({
    type: 'SENIOR_INCOME',
    status: 'REJECTED',
    amount: '50000.000000',
    currency: 'USDT',
    senderId: OLEKSIY_ID,
    senderLabel: 'TechCorp AI',
    receiverId: OLEKSIY_ID,
    projectId: proj1.id,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    validatedBy: MYKOLA_ID,
    validatedAt: d(2025, 8, 12),
    txDate: d(2025, 8, 5),
    createdBy: OLEKSIY_ID,
    createdAt: d(2025, 8, 5),
    notes: 'Помилка в сумі — відхилено',
  })

  // Company expenses — several months
  const expenseRows: TxInput[] = [
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '300.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 7, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 7, 1),
      notes: 'AWS EC2 + RDS — Jul 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '300.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 8, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 8, 1),
      notes: 'AWS EC2 + RDS — Aug 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '120.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'GitHub Team',
      txDate: d(2025, 9, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 9, 1),
      notes: 'GitHub Team plan — Q3',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '350.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 10, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 10, 1),
      notes: 'AWS EC2 + RDS — Oct 2025 (збільшений трафік)',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '89.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'Figma Business',
      txDate: d(2025, 11, 15),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 11, 15),
      notes: 'Figma Business — Nov 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '350.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2025, 12, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2025, 12, 1),
      notes: 'AWS EC2 + RDS — Dec 2025',
    },
    {
      type: 'EXPENSE',
      status: 'PENDING',
      amount: '350.000000',
      currency: 'USD',
      senderId: MAKSYM_ID,
      senderLabel: 'Cheeky Cheese IT',
      receiverLabel: 'AWS Hosting',
      txDate: d(2026, 5, 1),
      createdBy: MAKSYM_ID,
      createdAt: d(2026, 5, 1),
      notes: 'AWS EC2 + RDS — May 2026',
    },
  ]

  // Junior salary transactions
  const juniorSalaryRows: TxInput[] = [
    // Sofia — Jun–Nov 2025 (proj1 period) PAID
    ...([6, 7, 8, 9, 10, 11] as const).map((m) => ({
      type: 'SALARY' as const,
      status: 'PAID' as const,
      amount: '500.000000',
      currency: 'USD' as const,
      receiverId: SOFIA_ID,
      receiverLabel: 'Sofia Bondarenko',
      senderLabel: 'Cheeky Cheese IT',
      projectId: proj1.id,
      salaryMonth: `2025-${String(m).padStart(2, '0')}`,
      txDate: d(2025, m, 28),
      createdBy: MYKOLA_ID,
      createdAt: d(2025, m, 28),
    })),
    // Sofia — Jan–Apr 2026 (proj2) PAID
    ...([1, 2, 3] as const).map((m) => ({
      type: 'SALARY' as const,
      status: 'PAID' as const,
      amount: '500.000000',
      currency: 'USD' as const,
      receiverId: SOFIA_ID,
      receiverLabel: 'Sofia Bondarenko',
      senderLabel: 'Cheeky Cheese IT',
      projectId: proj2.id,
      salaryMonth: `2026-${String(m).padStart(2, '0')}`,
      txDate: d(2026, m, 28),
      createdBy: MYKOLA_ID,
      createdAt: d(2026, m, 28),
    })),
    {
      type: 'SALARY' as const,
      status: 'PENDING' as const,
      amount: '500.000000',
      currency: 'USD' as const,
      receiverId: SOFIA_ID,
      receiverLabel: 'Sofia Bondarenko',
      senderLabel: 'Cheeky Cheese IT',
      projectId: proj2.id,
      salaryMonth: '2026-04',
      txDate: d(2026, 4, 28),
      createdBy: MYKOLA_ID,
      createdAt: d(2026, 4, 28),
    },
  ]

  await db
    .insert(schema.transactions)
    .values([...txRows, ...expenseRows, ...juniorSalaryRows] as schema.NewTransaction[])
  console.log(
    `  ✓ ${txRows.length + expenseRows.length + juniorSalaryRows.length} transactions inserted`,
  )

  // ---- 7. Onboarding: ToS + contract templates + signed contracts ----
  console.log('\n[7/8] Inserting onboarding data...')

  // ToS v1
  const tosV1Rows = await db
    .insert(schema.tosVersions)
    .values({
      version: 1,
      bodyMarkdown: TOS_BODY,
      isActive: true,
      createdByUserId: MAKSYM_ID,
    })
    .returning()
  const tosV1 = tosV1Rows[0]!
  console.log('  ✓ ToS v1 (active) inserted')

  // Contract templates — 5 roles (not ADMIN)
  const templateMap: Record<string, string> = {}
  for (const role of ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const) {
    const tmplRows = await db
      .insert(schema.contractTemplates)
      .values({
        targetRole: role,
        version: 1,
        bodyMarkdown: CONTRACT_BODY[role] ?? '',
        isActive: true,
        createdByUserId: MAKSYM_ID,
      })
      .returning()
    const tmpl = tmplRows[0]!
    templateMap[role] = tmpl.id
  }
  console.log('  ✓ 5 contract templates (active) inserted')

  // Onboarded users (all except Dmytro + Ivan who are un-onboarded)
  interface OnboardUser {
    userId: string
    role: 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'
    legalName: string
    signedAt: Date
    contractNum: number
    payRequisite: string
    method: string
  }
  const onboardedUsers: OnboardUser[] = [
    {
      userId: OLEKSIY_ID,
      role: 'SENIOR',
      legalName: 'Коваленко Олексій Сергійович',
      signedAt: d(2025, 6, 5),
      contractNum: 1,
      payRequisite: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
      method: 'USDT ERC-20',
    },
    {
      userId: SOFIA_ID,
      role: 'JUNIOR',
      legalName: 'Бондаренко Софія Олегівна',
      signedAt: d(2025, 6, 5),
      contractNum: 2,
      payRequisite: 'UA213223130000026007233566001 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: ANNA_ID,
      role: 'HR',
      legalName: 'Лисенко Анна Вікторівна',
      signedAt: d(2025, 6, 5),
      contractNum: 3,
      payRequisite: 'UA213223130000026007233566002 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: KATERYNA_ID,
      role: 'HR',
      legalName: 'Шевченко Катерина Олексіївна',
      signedAt: d(2025, 6, 5),
      contractNum: 4,
      payRequisite: 'UA213223130000026007233566003 (monobank)',
      method: 'Bank UAH FOP',
    },
    {
      userId: MYKOLA_ID,
      role: 'ACCOUNTANT',
      legalName: 'Савченко Микола Григорович',
      signedAt: d(2025, 6, 5),
      contractNum: 5,
      payRequisite: 'UA213223130000026007233566004 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: ARTEM_ID,
      role: 'SENIOR',
      legalName: 'Кравченко Артем Миколайович',
      signedAt: d(2025, 8, 15),
      contractNum: 6,
      payRequisite: '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
      method: 'USDT ERC-20',
    },
    {
      userId: OKSANA_ID,
      role: 'JUNIOR',
      legalName: 'Мельник Оксана Павлівна',
      signedAt: d(2025, 8, 20),
      contractNum: 7,
      payRequisite: '0x617F2E2fD72FD9D5503197092AC168961b98769F',
      method: 'USDT ERC-20',
    },
    {
      userId: HR3_ID,
      role: 'HR',
      legalName: 'Ковальчук Дарина Сергіївна',
      signedAt: d(2025, 9, 1),
      contractNum: 8,
      payRequisite: 'UA093052990000026204444020123 (Ощадбанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: NAZAR_ID,
      role: 'SENIOR',
      legalName: 'Пономаренко Назар Іванович',
      signedAt: d(2025, 10, 1),
      contractNum: 9,
      payRequisite: '0x78731D3Ca6b7E34aC0F824c42a7cC18A495cabaB',
      method: 'USDT ERC-20',
    },
    {
      userId: YURIY_ID,
      role: 'JUNIOR',
      legalName: 'Ткаченко Юрій Анатолійович',
      signedAt: d(2025, 10, 5),
      contractNum: 10,
      payRequisite: 'UA443052990000026206555020567 (monobank)',
      method: 'Bank UAH FOP',
    },
    {
      userId: LENA_ID,
      role: 'JUNIOR',
      legalName: 'Гриценко Олена Михайлівна',
      signedAt: d(2025, 12, 10),
      contractNum: 11,
      payRequisite: 'UA233220010000026201300038581 (ПУМБ)',
      method: 'Bank UAH FOP',
    },
    {
      userId: DROP1_ID,
      role: 'DROP',
      legalName: 'Дрожжин Віктор Олегович',
      signedAt: d(2025, 7, 1),
      contractNum: 12,
      payRequisite: '0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec',
      method: 'USDT ERC-20',
    },
    {
      userId: DROP2_ID,
      role: 'DROP',
      legalName: 'Дроздова Олена Борисівна',
      signedAt: d(2025, 7, 15),
      contractNum: 13,
      payRequisite: 'UA153052990000026201111020999 (ПриватБанк)',
      method: 'Bank UAH FOP',
    },
    {
      userId: DROP3_ID,
      role: 'DROP',
      legalName: 'Дроботенко Роман Петрович',
      signedAt: d(2025, 8, 1),
      contractNum: 14,
      payRequisite: '0xdD870fA1b7C4700F2BD7f44238821C26f7392148',
      method: 'USDT ERC-20',
    },
    {
      userId: DROP4_ID,
      role: 'DROP',
      legalName: 'Дрозд Марта Іванівна',
      signedAt: d(2025, 9, 15),
      contractNum: 15,
      payRequisite: '0x583031D1113aD414F02576BD6afaBfb302140225',
      method: 'USDT ERC-20',
    },
    {
      userId: DROP5_ID,
      role: 'DROP',
      legalName: 'Дрофа Сергій Васильович',
      signedAt: d(2025, 10, 20),
      contractNum: 16,
      payRequisite: 'UA253052990000026208888020456 (monobank)',
      method: 'Bank UAH FOP',
    },
    {
      userId: DROP6_ID,
      role: 'DROP',
      legalName: 'Дробиш Тамара Григорівна',
      signedAt: d(2025, 11, 1),
      contractNum: 17,
      payRequisite: '0x4B0897b0513fdC7C541B6d9D7E929C4e5364D2dB',
      method: 'USDT ERC-20',
    },
  ]

  // Map userId → signed_contract.id for employee_contracts backfill (AC9)
  const signedContractIdByUser: Record<string, string> = {}

  for (const u of onboardedUsers) {
    const tmplId = templateMap[u.role]
    if (!tmplId) continue
    const snapshot = (CONTRACT_BODY[u.role] ?? '')
      .replace(/\{\{employeeName\}\}/g, u.legalName)
      .replace(/\{\{onboardingDate\}\}/g, u.signedAt.toISOString().slice(0, 10))
      .replace(/\{\{preferredMethod\}\}/g, u.method)
      .replace(/\{\{walletUsdt\}\}/g, u.method === 'USDT ERC-20' ? u.payRequisite : '')
      .replace(/\{\{bankUahFop\}\}/g, u.method === 'Bank UAH FOP' ? u.payRequisite : '')

    const [sc] = await db
      .insert(schema.signedContracts)
      .values({
        userId: u.userId,
        templateId: tmplId,
        bodyMarkdownSnapshot: snapshot,
        variablesFilled: {
          employeeName: u.legalName,
          onboardingDate: u.signedAt.toISOString().slice(0, 10),
          preferredMethod: u.method,
          walletUsdt: u.method === 'USDT ERC-20' ? u.payRequisite : '',
          bankUahFop: u.method === 'Bank UAH FOP' ? u.payRequisite : '',
        },
        signedTypedName: u.legalName,
        signedIp: '127.0.0.1',
        signedAt: u.signedAt,
        contractNumber: `CHK-${u.contractNum}-2025`,
      })
      .returning()
    if (sc) signedContractIdByUser[u.userId] = sc.id

    // ToS acceptance for onboarded users
    await db.insert(schema.tosAcceptances).values({
      userId: u.userId,
      tosVersionId: tosV1.id,
      acceptedAt: u.signedAt,
      acceptedIp: '127.0.0.1',
    })
  }
  console.log(`  ✓ ${onboardedUsers.length} signed contracts + ToS acceptances inserted`)

  // AC9 — employee_contracts backfill (A3-1):
  //   • SIGNED for every onboarded user (linked to their signed_contract)
  //   • READY_TO_SIGN for Dmytro (awaiting signing — wizard test scenario)
  //   • No record for Ivan (completely un-onboarded — blocked fallback scenario)
  for (const u of onboardedUsers) {
    const tmplId = templateMap[u.role]
    const scId = signedContractIdByUser[u.userId]
    if (!tmplId || !scId) continue
    const snapshot = (CONTRACT_BODY[u.role] ?? '')
      .replace(/\{\{employeeName\}\}/g, u.legalName)
      .replace(/\{\{onboardingDate\}\}/g, u.signedAt.toISOString().slice(0, 10))
      .replace(/\{\{preferredMethod\}\}/g, u.method)
      .replace(/\{\{walletUsdt\}\}/g, u.method === 'USDT ERC-20' ? u.payRequisite : '')
      .replace(/\{\{bankUahFop\}\}/g, u.method === 'Bank UAH FOP' ? u.payRequisite : '')

    await db.insert(schema.employeeContracts).values({
      userId: u.userId,
      sourceTemplateId: tmplId,
      bodyMarkdown: snapshot,
      status: 'SIGNED',
      signedContractId: scId,
      createdByUserId: MAKSYM_ID,
      createdAt: u.signedAt,
      updatedAt: u.signedAt,
    })
  }

  // Dmytro: READY_TO_SIGN — contract prepared by ADMIN, awaiting user signing
  const dmytroTmplId = templateMap['SENIOR']
  if (dmytroTmplId) {
    const dmytroSnapshot = (CONTRACT_BODY['SENIOR'] ?? '')
      .replace(/\{\{employeeName\}\}/g, 'Марченко Дмитро Олексійович')
      .replace(/\{\{onboardingDate\}\}/g, d(2025, 7, 1).toISOString().slice(0, 10))
      .replace(/\{\{preferredMethod\}\}/g, 'не вказано')
      .replace(/\{\{walletUsdt\}\}/g, '')
      .replace(/\{\{bankUahFop\}\}/g, '')

    await db.insert(schema.employeeContracts).values({
      userId: DMYTRO_ID,
      sourceTemplateId: dmytroTmplId,
      bodyMarkdown: dmytroSnapshot,
      status: 'READY_TO_SIGN',
      signedContractId: null,
      createdByUserId: MAKSYM_ID,
      createdAt: d(2025, 7, 1),
      updatedAt: d(2025, 7, 1),
    })
  }
  // Ivan: no employee_contract at all (completely blocked — frontend fallback scenario)

  console.log(
    `  ✓ ${onboardedUsers.length} employee_contracts (SIGNED) + 1 READY_TO_SIGN (Dmytro) inserted`,
  )
  console.log('  ✓ dmytro.marchenko — READY_TO_SIGN (wizard test); ivan.petrenko — no contract')

  // ---- 8. Final verification queries ----
  console.log('\n[8/8] Verification...')
  const userCounts = await db.execute(
    'SELECT role, count(*) FROM users GROUP BY role ORDER BY role' as unknown as Parameters<
      typeof db.execute
    >[0],
  )
  console.log('  Users by role:')
  for (const row of userCounts.rows) {
    const r = row as { role: string; count: string }
    console.log(`    ${r.role}: ${r.count}`)
  }

  const nullLfnRows = (
    await db.execute(
      "SELECT count(*) FROM users WHERE legal_full_name IS NULL AND role <> 'ADMIN'" as unknown as Parameters<
        typeof db.execute
      >[0],
    )
  ).rows as { count: string }[]
  const nullLfn = nullLfnRows[0]?.count ?? '?'
  console.log(`  Users with NULL legal_full_name (non-ADMIN): ${nullLfn} (expected: 0)`)

  await pool.end()
  console.log('\n=== Seed complete ===')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
