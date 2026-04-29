-- Migration: إضافة allowlist للمحافظ
-- شغّل هذا الـ SQL في Supabase → SQL Editor

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS allowlist_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allowlist         text[]  NOT NULL DEFAULT '{}';
