-- Migration: optional teams.telegram_channel column.
-- Stores a Telegram channel handle (without/with leading @) for team-wide
-- comms. Frontend renders it as a t.me/<channel> link when present.
-- Constraint shape mirrors the user.telegram regex: 5–32 latin chars / digits / _.

ALTER TABLE "teams" ADD COLUMN "telegram_channel" text;
