# Модуль: Финансы (Finance)

## Статус: ✅ Реализован (PHASE 5)

## Финансовый поток

```
SENIOR вносит транзакцию (PENDING)
→ ACCOUNTANT валидирует (VALIDATED)
→ SENIOR нажимает "Оплатить" (PENDING_PAYMENT)
→ SENIOR платит 74% через смарт-контракт (Phase 8)
  ├── JUNIOR: фиксированная сумма (из project_finance_settings)
  └── Остаток: 50% ADMIN + 50% партнёр
→ SENIOR оставляет 26% → статус PAID
```

## RBAC

| Роль | Доступ |
|------|--------|
| ADMIN | Все транзакции, все отчёты |
| ACCOUNTANT | Все транзакции, валидация, расходы, выплаты |
| SENIOR | Только свои транзакции и баланс |
| HR | Свои зарплатные выплаты |
| JUNIOR | ❌ Нет доступа к финансам |

## Сущности

- **transactions** — доход SENIOR от проекта (PENDING → VALIDATED → PENDING_PAYMENT → PAID / REJECTED)
- **expenses** — расходы компании (ADMIN/ACCOUNTANT)
- **junior_payments** — выплаты JUNIOR по проекту
- **invoices** + **invoice_transactions** — инвойс объединяет транзакции (DRAFT → SIGNED / CANCELLED)
- **payouts** + **payout_transactions** — выплаты партнёрам MAKSYM/KOSTYA (PENDING_PAYMENT → PAID)

## Дополнительные сервисы

- **NBU rates** — ежедневный cron, курсы валют из API НБУ
- **Etherscan** — верификация крипто-транзакций по хэшу (read-only)
- **PDF invoice** — генерация через pdfkit

## Endpoints (ключевые)

```
POST   /api/transactions                  → создать (SENIOR)
PATCH  /api/transactions/:id/validate     → валидировать (ACCOUNTANT)
PATCH  /api/transactions/:id/reject       → отклонить (ACCOUNTANT)
POST   /api/transactions/:id/pay          → оплатить (SENIOR)
GET    /api/invoices/:id/pdf              → скачать PDF
POST   /api/payouts/:id/pay              → отметить выплату оплаченной
```
