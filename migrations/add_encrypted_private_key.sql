-- Migration: إضافة encrypted_private_key لجدول agent_wallets
-- شغّل هذا الـ SQL في Supabase → SQL Editor

ALTER TABLE agent_wallets
  ADD COLUMN IF NOT EXISTS encrypted_private_key text;
