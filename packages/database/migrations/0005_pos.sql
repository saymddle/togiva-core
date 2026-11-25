-- 0005_pos: provider-independent POS integration model.
-- The POS is authoritative for the sale; TOGIVA stores the normalized subset it
-- needs for loyalty auditing and reconciliation. Card numbers, CVVs and other
-- payment instrument data are never stored. Money is integer minor units.

create table togiva.pos_providers (
  code text primary key check (code ~ '^[a-z_]+$'),
  name text not null,
  status text not null check (status in ('available', 'in_development', 'planned', 'development_only')),
  capabilities jsonb not null default '{}'::jsonb
);
insert into togiva.pos_providers (code, name, status, capabilities) values
  ('clover', 'Clover', 'in_development', '{"verified": false}'::jsonb),
  ('toast', 'Toast', 'planned', '{}'::jsonb),
  ('square', 'Square', 'planned', '{}'::jsonb),
  ('fixture', 'Development fixture POS', 'development_only', '{"customer_attach": false, "order_reference": true, "recent_transactions": true}'::jsonb);

create table togiva.pos_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id),
  provider_code text not null references togiva.pos_providers(code),
  environment text not null check (environment in ('production', 'sandbox', 'fixture')),
  merchant_external_id text not null,
  display_name text,
  status text not null default 'pending' check (status in ('pending', 'active', 'error', 'revoked')),
  -- Encrypted by the application (AES-256-GCM, key from secret store).
  -- Not granted to togiva_app; only the worker role can read these columns.
  credentials_ciphertext bytea,
  credentials_key_version smallint,
  webhook_secret_ciphertext bytea,
  granted_scopes text[] not null default '{}',
  connected_by uuid references togiva.user_profiles(id),
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_webhook_at timestamptz,
  webhook_status text not null default 'unknown' check (webhook_status in ('unknown', 'healthy', 'degraded', 'failing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (provider_code, environment, merchant_external_id)
);
create trigger pos_connections_touch before update on togiva.pos_connections
  for each row execute function togiva.touch_updated_at();

create table togiva.pos_location_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pos_connection_id uuid not null,
  location_id uuid not null,
  external_location_ref text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, pos_connection_id) references togiva.pos_connections (organization_id, id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);
create unique index pos_location_mappings_ref on togiva.pos_location_mappings (pos_connection_id, external_location_ref) where status = 'active';

-- Raw inbound events. Persisted before processing; duplicates are detected by
-- (provider, provider_event_id). Payloads expire per retention settings.
create table togiva.pos_webhook_events (
  id bigint generated always as identity primary key,
  provider_code text not null references togiva.pos_providers(code),
  provider_event_id text not null,
  organization_id uuid references togiva.organizations(id),
  pos_connection_id uuid references togiva.pos_connections(id),
  signature_valid boolean not null,
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  payload_purge_after timestamptz,
  unique (provider_code, provider_event_id)
);
create index pos_webhook_events_pending on togiva.pos_webhook_events (received_at) where status in ('received', 'failed');

-- Normalized transaction (see @togiva/shared-types NormalizedTransaction).
create table togiva.pos_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  pos_connection_id uuid not null,
  provider_code text not null references togiva.pos_providers(code),
  external_transaction_id text not null,
  external_order_id text,
  last_provider_event_id text,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null,
  discount_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  tip_minor bigint not null default 0,
  service_charge_minor bigint not null default 0,
  fee_minor bigint not null default 0,
  total_minor bigint not null,
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  status text not null check (status in ('open', 'paid', 'partially_refunded', 'refunded', 'voided')),
  purchased_at timestamptz not null,
  -- provider modification time; used to ignore out-of-order stale updates
  provider_updated_at timestamptz,
  external_customer_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, provider_code, external_transaction_id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  foreign key (organization_id, pos_connection_id) references togiva.pos_connections (organization_id, id)
);
create index pos_transactions_location_time on togiva.pos_transactions (location_id, purchased_at desc);
create index pos_transactions_order_ref on togiva.pos_transactions (organization_id, provider_code, external_order_id) where external_order_id is not null;
create trigger pos_transactions_touch before update on togiva.pos_transactions
  for each row execute function togiva.touch_updated_at();

create table togiva.pos_transaction_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pos_transaction_id uuid not null,
  external_line_id text not null,
  external_product_ref text,
  name text not null,
  category text,
  quantity numeric(12, 3) not null,
  unit_price_minor bigint not null,
  discount_minor bigint not null default 0,
  total_minor bigint not null,
  refunded boolean not null default false,
  foreign key (organization_id, pos_transaction_id) references togiva.pos_transactions (organization_id, id) on delete cascade,
  unique (pos_transaction_id, external_line_id)
);

create table togiva.pos_customer_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pos_connection_id uuid not null,
  external_customer_id text not null,
  organization_customer_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, pos_connection_id) references togiva.pos_connections (organization_id, id),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id),
  unique (pos_connection_id, external_customer_id)
);

create table togiva.pos_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pos_connection_id uuid not null,
  sync_type text not null check (sync_type in ('historical', 'incremental', 'webhook_backfill', 'reconciliation')),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  window_start timestamptz,
  window_end timestamptz,
  cursor text,
  stats jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, pos_connection_id) references togiva.pos_connections (organization_id, id)
);

create table togiva.pos_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pos_connection_id uuid not null,
  location_id uuid,
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'clean', 'discrepancies', 'failed')),
  provider_count integer,
  togiva_count integer,
  missing_count integer,
  mismatch_count integer,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, pos_connection_id) references togiva.pos_connections (organization_id, id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);

-- Request/response metadata for provider calls. Never bodies or tokens.
create table togiva.pos_integration_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references togiva.organizations(id),
  pos_connection_id uuid references togiva.pos_connections(id),
  direction text not null check (direction in ('outbound', 'inbound')),
  operation text not null,
  http_status integer,
  duration_ms integer,
  outcome text not null check (outcome in ('success', 'retryable_error', 'fatal_error')),
  message text,
  created_at timestamptz not null default now()
);
create index pos_integration_logs_conn_time on togiva.pos_integration_logs (pos_connection_id, created_at desc);
