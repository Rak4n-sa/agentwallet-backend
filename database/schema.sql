-- ══════════════════════════════════════════════════════════════════════════════
-- AgentWallet — Database Schema
-- Supabase (PostgreSQL) — يُشغَّل مرة واحدة في SQL Editor
-- ══════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════
-- ١. developers — بيانات المطور الإضافية (فوق Supabase Auth)
-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase Auth يحفظ email + password تلقائياً
-- هذا الجدول يحفظ البيانات الإضافية: الاسم، webhook، إلخ

CREATE TABLE IF NOT EXISTS developers (
  id             UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  email          TEXT        NOT NULL,
  webhook_url    TEXT,
  webhook_secret TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٢. api_keys — مفاتيح API للمطورين
-- ══════════════════════════════════════════════════════════════════════════════
-- النص الأصلي للـ key لا يُحفظ أبداً — فقط الـ hash

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id UUID        NOT NULL REFERENCES developers (id) ON DELETE CASCADE,
  key_hash     TEXT        NOT NULL UNIQUE,
  key_prefix   TEXT        NOT NULL,          -- أول 10 أحرف للعرض فقط
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_developer_id ON api_keys (developer_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash     ON api_keys (key_hash);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٣. wallets — المحافظ التي ينشئها المطور لـ agents الخاص به
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wallets (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id  UUID          NOT NULL REFERENCES developers (id) ON DELETE RESTRICT,
  name          TEXT          NOT NULL,
  description   TEXT          NOT NULL DEFAULT '',
  is_active     BOOLEAN       NOT NULL DEFAULT true,
  tba_address   TEXT,                          -- عنوان الـ Smart Account (ERC-4337)
  balance       NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallets_developer_id ON wallets (developer_id);
CREATE INDEX IF NOT EXISTS idx_wallets_created_at   ON wallets (created_at);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٤. agent_wallets — بيانات الـ Smart Account (ERC-4337) لكل محفظة
-- ══════════════════════════════════════════════════════════════════════════════
-- token_id    = salt المستخدم لاشتقاق العنوان (counterfactual address)
-- tba_address = Smart Account address الفعلي
-- nft_contract = null دائماً بعد إزالة ERC-6551

CREATE TABLE IF NOT EXISTS agent_wallets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     UUID        NOT NULL UNIQUE REFERENCES wallets (id) ON DELETE CASCADE,
  token_id      TEXT        NOT NULL,          -- salt كـ BigInt string
  tba_address   TEXT        NOT NULL,          -- Smart Account address
  nft_contract  TEXT,                          -- null في ERC-4337 (كان يُستخدم في ERC-6551)
  mint_tx       TEXT,                          -- deploy transaction hash
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_wallets_wallet_id ON agent_wallets (wallet_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٥. transactions — كل عملية مالية في المشروع
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS transactions (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT          UNIQUE,
  wallet_id        UUID          NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  developer_id     UUID          NOT NULL REFERENCES developers (id) ON DELETE RESTRICT,
  direction        TEXT          NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type             TEXT          NOT NULL CHECK (type IN ('onramp', 'payment', 'transfer', 'external', 'rollback')),
  amount           NUMERIC(18,6) NOT NULL,
  fee              NUMERIC(18,6) NOT NULL DEFAULT 0,
  net_amount       NUMERIC(18,6) NOT NULL,
  currency         TEXT          NOT NULL DEFAULT 'USDC',
  counterparty     TEXT,                        -- عنوان المرسل أو المستلم
  service_url      TEXT,                        -- الـ API اللي دُفع لها
  description      TEXT,
  status           TEXT          NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'confirmed', 'failed', 'rolled_back')),
  tx_hash          TEXT,                        -- رقم العملية على Base
  block_number     BIGINT,
  metadata         JSONB,                       -- تفاصيل إضافية حسب النوع
  error_code       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id    ON transactions (wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_developer_id ON transactions (developer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status       ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at   ON transactions (created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_type         ON transactions (type);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٦. idempotency_keys — منع تكرار الدفع
-- ══════════════════════════════════════════════════════════════════════════════
-- agent_id هنا = wallet_id — الاسم القديم محفوظ في الكود

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT        NOT NULL,
  agent_id     UUID        NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'completed')),
  result       JSONB,                           -- نتيجة الدفعة بعد اكتمالها
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (key, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key      ON idempotency_keys (key);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_agent_id ON idempotency_keys (agent_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires  ON idempotency_keys (expires_at);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٧. wallet_limits — حدود المحفظة (max per transaction + ميزانية)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wallet_limits (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id              UUID          NOT NULL UNIQUE REFERENCES wallets (id) ON DELETE CASCADE,
  max_transaction_amount NUMERIC(18,6),          -- الحد الأقصى لكل عملية
  daily_budget           NUMERIC(18,6),          -- الميزانية اليومية
  monthly_budget         NUMERIC(18,6),          -- الميزانية الشهرية
  is_active              BOOLEAN       NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_limits_wallet_id ON wallet_limits (wallet_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٨. agent_limits — حالة الحد (ok / exceeded) لكل نوع
-- ══════════════════════════════════════════════════════════════════════════════
-- يُستخدم من Supabase Realtime كـ trigger للـ onLimitExceeded event

CREATE TABLE IF NOT EXISTS agent_limits (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id    UUID        NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  limit_type   TEXT        NOT NULL CHECK (limit_type IN ('daily', 'monthly')),
  status       TEXT        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'exceeded')),
  exceeded_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, limit_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_limits_wallet_id ON agent_limits (wallet_id);
CREATE INDEX IF NOT EXISTS idx_agent_limits_status    ON agent_limits (status);

-- ══════════════════════════════════════════════════════════════════════════════
-- ٩. rollbacks — طلبات الإرجاع
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rollbacks (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID          NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  wallet_id        UUID          NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  developer_id     UUID          NOT NULL REFERENCES developers (id) ON DELETE RESTRICT,
  amount           NUMERIC(18,6) NOT NULL,
  reason           TEXT          NOT NULL,
  status           TEXT          NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'completed', 'failed')),
  attempts         INTEGER       NOT NULL DEFAULT 0,
  max_attempts     INTEGER       NOT NULL DEFAULT 3,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rollbacks_transaction_id ON rollbacks (transaction_id);
CREATE INDEX IF NOT EXISTS idx_rollbacks_wallet_id      ON rollbacks (wallet_id);
CREATE INDEX IF NOT EXISTS idx_rollbacks_status         ON rollbacks (status);

-- ══════════════════════════════════════════════════════════════════════════════
-- ١٠. webhook_logs — سجل كل webhook أُرسل أو فشل
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS webhook_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID        NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  developer_id     UUID        NOT NULL REFERENCES developers (id) ON DELETE CASCADE,
  url              TEXT        NOT NULL,
  payload          JSONB,
  response_status  INTEGER,
  success          BOOLEAN     NOT NULL DEFAULT false,
  error_message    TEXT,
  attempts         INTEGER     NOT NULL DEFAULT 1,
  retried_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_transaction_id ON webhook_logs (transaction_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_developer_id   ON webhook_logs (developer_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_success        ON webhook_logs (success);

-- ══════════════════════════════════════════════════════════════════════════════
-- ١١. notification_logs — الإشعارات المرسلة للمطورين
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notification_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id     UUID        NOT NULL REFERENCES developers (id) ON DELETE CASCADE,
  wallet_id        UUID        REFERENCES wallets (id) ON DELETE SET NULL,
  transaction_id   UUID        REFERENCES transactions (id) ON DELETE SET NULL,
  type             TEXT        NOT NULL
                               CHECK (type IN (
                                 'payment_received',
                                 'limit_exceeded',
                                 'wallet_auto_stopped',
                                 'rollback_initiated'
                               )),
  message          TEXT        NOT NULL,
  metadata         JSONB,
  is_read          BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_developer_id ON notification_logs (developer_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_wallet_id    ON notification_logs (wallet_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_type         ON notification_logs (type);
CREATE INDEX IF NOT EXISTS idx_notification_logs_created_at   ON notification_logs (created_at);

-- ══════════════════════════════════════════════════════════════════════════════
-- ١٢. audit_logs — سجل تدقيقي لكل العمليات الحساسة
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action     TEXT        NOT NULL,               -- مثل: developer.registered، api_key.generated
  agent_id   TEXT,                               -- wallet_id أو resource_id المتعلق بالحدث
  actor_id   TEXT,                               -- UUID للمطور، أو 'system' للعمليات التلقائية
  metadata   JSONB,
  status     TEXT        NOT NULL DEFAULT 'success'
                         CHECK (status IN ('success', 'failure')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id  ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action    ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);

-- ══════════════════════════════════════════════════════════════════════════════
-- Supabase Realtime — تفعيل الـ events التلقائية
-- ══════════════════════════════════════════════════════════════════════════════
-- هذه الجداول تطلق events لـ events/ listeners عند أي تغيير

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'transactions'
  ) THEN ALTER PUBLICATION supabase_realtime ADD TABLE transactions; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'agent_limits'
  ) THEN ALTER PUBLICATION supabase_realtime ADD TABLE agent_limits; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'rollbacks'
  ) THEN ALTER PUBLICATION supabase_realtime ADD TABLE rollbacks; END IF;
END $$;
