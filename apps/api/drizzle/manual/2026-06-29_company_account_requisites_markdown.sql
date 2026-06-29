-- Migration: add company_account.requisites_markdown (nullable TEXT)
--
-- Feature: «Компания» tab requisites + auto-appended «Реквизиты компании»
-- section in NEW contracts (feat/company-requisites-and-pdf-preview).
--
-- This repo uses `drizzle-kit push` for local/dev schema-sync and does NOT keep
-- a drizzle migration history; the prod image has no drizzle-kit. So this single
-- reviewed statement is what the OWNER applies manually on prod at deploy:
--   docker exec -i <postgres> psql -U <user> -d <db> \
--     < apps/api/drizzle/manual/2026-06-29_company_account_requisites_markdown.sql
--
-- Idempotent (IF NOT EXISTS) so a re-run is safe. Matches exactly the column
-- drizzle-kit generates for `text('requisites_markdown')` on company_account.

ALTER TABLE "company_account"
  ADD COLUMN IF NOT EXISTS "requisites_markdown" text;
