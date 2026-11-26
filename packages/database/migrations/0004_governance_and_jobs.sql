-- 0004_governance_and_jobs: audit trail, administrative events, support access,
-- data exports, integration errors, support cases, and the durable job queue.

create table togiva.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references togiva.organizations(id),
  actor_user_id uuid references togiva.user_profiles(id),
  actor_type text not null check (actor_type in ('user', 'system', 'worker', 'integration')),
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_type text not null,
  target_id text,
  location_id uuid,
  context jsonb not null default '{}'::jsonb,
  request_id text,
  ip_address inet,
  user_agent text,
  occurred_at timestamptz not null default now()
);
create index audit_logs_org_time on togiva.audit_logs (organization_id, occurred_at desc);
create index audit_logs_target on togiva.audit_logs (target_type, target_id);
create index audit_logs_actor on togiva.audit_logs (actor_user_id, occurred_at desc);
create trigger audit_logs_append_only before update or delete on togiva.audit_logs
  for each row execute function togiva.prevent_mutation();

-- Request handlers write audit rows only through this function, which stamps
-- the actor from the request context so it cannot be spoofed.
create or replace function togiva.write_audit(
  p_organization_id uuid, p_action text, p_target_type text, p_target_id text,
  p_context jsonb default '{}'::jsonb, p_location_id uuid default null,
  p_ip inet default null, p_user_agent text default null
) returns bigint language plpgsql security definer set search_path = togiva, pg_temp as $$
declare v_id bigint;
begin
  insert into audit_logs (organization_id, actor_user_id, actor_type, action, target_type, target_id, location_id, context, request_id, ip_address, user_agent)
  values (p_organization_id, togiva.current_user_id(),
          case when togiva.current_user_id() is null then 'system' else 'user' end,
          p_action, p_target_type, p_target_id, p_location_id, coalesce(p_context, '{}'::jsonb), togiva.current_request_id(), p_ip, p_user_agent)
  returning id into v_id;
  return v_id;
end $$;

create table togiva.administrative_events (
  id bigint generated always as identity primary key,
  organization_id uuid references togiva.organizations(id),
  actor_user_id uuid references togiva.user_profiles(id),
  event_type text not null,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index administrative_events_org_time on togiva.administrative_events (organization_id, occurred_at desc);
create trigger administrative_events_append_only before update or delete on togiva.administrative_events
  for each row execute function togiva.prevent_mutation();

-- Any time a platform operator accesses an organization's data for support.
create table togiva.support_access_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references togiva.organizations(id),
  accessed_by uuid not null references togiva.user_profiles(id),
  reason text not null,
  support_case_id uuid,
  scope text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table togiva.data_export_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references togiva.organizations(id),
  requested_by uuid not null references togiva.user_profiles(id),
  export_type text not null,
  filters jsonb not null default '{}'::jsonb,
  row_count integer,
  contains_pii boolean not null default false,
  created_at timestamptz not null default now()
);

create table togiva.integration_errors (
  id bigint generated always as identity primary key,
  organization_id uuid references togiva.organizations(id),
  location_id uuid,
  source text not null,
  error_code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by uuid references togiva.user_profiles(id),
  occurred_at timestamptz not null default now()
);
create index integration_errors_open on togiva.integration_errors (organization_id, occurred_at desc) where resolved_at is null;

-- Operational support (franchise -> corporate): disputes, POS issues,
-- account issues, redemption issues, transaction discrepancies.
create table togiva.support_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id),
  location_id uuid,
  category text not null check (category in ('loyalty_dispute', 'pos_integration', 'customer_account', 'redemption', 'transaction_discrepancy', 'connection_association', 'other')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
  subject text not null,
  description text not null,
  related_type text,
  related_id text,
  submitted_by uuid not null references togiva.user_profiles(id),
  assigned_to uuid references togiva.user_profiles(id),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);
create index support_cases_org_status on togiva.support_cases (organization_id, status, created_at desc);
create trigger support_cases_touch before update on togiva.support_cases
  for each row execute function togiva.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Durable background jobs. Claimed with FOR UPDATE SKIP LOCKED; retried with
-- backoff; jobs that exhaust attempts move to 'dead' and raise an alert, they
-- are never silently discarded.
-- ---------------------------------------------------------------------------
create table togiva.background_jobs (
  id bigint generated always as identity primary key,
  organization_id uuid references togiva.organizations(id),
  queue text not null default 'default',
  job_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  priority smallint not null default 0,
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 10 check (max_attempts > 0),
  idempotency_key text,
  locked_by text,
  locked_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index background_jobs_idempotency on togiva.background_jobs (job_type, idempotency_key) where idempotency_key is not null;
create index background_jobs_ready on togiva.background_jobs (queue, priority desc, run_at) where status in ('pending', 'failed');
create index background_jobs_running on togiva.background_jobs (locked_at) where status = 'running';
create trigger background_jobs_touch before update on togiva.background_jobs
  for each row execute function togiva.touch_updated_at();

-- Fixed-window rate limit buckets (connection-code issuing, logins, etc).
create table togiva.rate_limit_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket_key, window_start)
);

create or replace function togiva.rate_limit_hit(p_key text, p_window_seconds integer, p_limit integer)
returns boolean language plpgsql security definer set search_path = togiva, pg_temp as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into rate_limit_buckets (bucket_key, window_start, hits) values (p_key, v_start, 1)
  on conflict (bucket_key, window_start) do update set hits = rate_limit_buckets.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;
