-- 0026_company_debtor.sql
--
-- task-drop-company-debt-and-invoices.
--
-- Adds 'COMPANY' value to the pending_obligation_debtor_type enum so the
-- new senior IOU rows created by confirmCryptoPayment (crypto channel) and
-- confirmCashPayment (cash channel) can carry debtorType=COMPANY instead
-- of DROP. Existing DROP / TOV rows are NOT touched — they remain readable
-- for audit. Closure of COMPANY-debt rows happens via settleByCompany
-- (ADMIN / ACCOUNTANT only) which also triggers invoice auto-creation on
-- the resulting SENIOR_INCOME transaction.

ALTER TYPE "pending_obligation_debtor_type" ADD VALUE IF NOT EXISTS 'COMPANY';
