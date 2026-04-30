-- جدول أرباح المنصة — يتجمع من رسوم الإيداع (0.5%) والشحن (1%)
create table if not exists platform_earnings (
  id            uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id),
  wallet_id     uuid references wallets(id),
  developer_id  uuid references developers(id),
  fee_type      text not null check (fee_type in ('deposit', 'charge')),
  gross_amount  numeric(18,6) not null,
  fee_amount    numeric(18,6) not null,
  fee_rate      numeric(6,4)  not null,
  created_at    timestamptz default now()
);

create index if not exists platform_earnings_created_at on platform_earnings(created_at desc);
