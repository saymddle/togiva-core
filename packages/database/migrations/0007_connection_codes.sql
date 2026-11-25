-- 0007_connection_codes: the four-digit membership connection code.
--
-- The raw code is never stored. code_hash = HMAC-SHA256(server secret,
-- organization_id | location_id | code), computed in the API. Including the
-- location in the MAC scopes every code to one location: the same digits
-- entered at another location do not match.
--
-- Lifecycle: active -> reserved -> consumed; active -> expired | revoked;
-- reserved -> active (released by cashier) | expired (reservation lapsed).
-- A code only identifies a customer. It never authorizes account changes,
-- payments or redemptions, and never awards points by itself.

create table togiva.customer_connection_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  organization_customer_id uuid not null,
  location_id uuid not null,
  code_hash bytea not null,
  key_version smallint not null default 1,
  status text not null default 'active' check (status in ('active', 'reserved', 'consumed', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reserved_at timestamptz,
  reservation_expires_at timestamptz,
  reserved_by_user_id uuid references togiva.user_profiles(id),
  reserved_terminal_id text,
  reservation_idempotency_key text,
  consumed_at timestamptz,
  association_id uuid,
  pos_transaction_id uuid,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('replaced', 'location_changed', 'customer_cancelled', 'membership_inactive', 'administrative')),
  unique (organization_id, id),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  check (expires_at > created_at),
  check (status <> 'reserved' or (reserved_at is not null and reserved_by_user_id is not null and reservation_expires_at is not null)),
  check (status <> 'consumed' or consumed_at is not null)
);
-- A live code's digits are unique within its location.
create unique index connection_codes_live_hash on togiva.customer_connection_codes (location_id, code_hash) where status in ('active', 'reserved');
-- One active code per customer per organization.
create unique index connection_codes_one_active on togiva.customer_connection_codes (organization_customer_id) where status = 'active';
create index connection_codes_expiry_sweep on togiva.customer_connection_codes (expires_at) where status = 'active';
create index connection_codes_reservation_sweep on togiva.customer_connection_codes (reservation_expires_at) where status = 'reserved';

-- Links an identified customer to a POS order/transaction. Points are only
-- awarded after the POS confirms the sale and the association is 'confirmed'.
create table togiva.customer_transaction_associations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  organization_customer_id uuid not null,
  connection_code_id uuid,
  pos_connection_id uuid,
  provider_code text not null references togiva.pos_providers(code),
  method text not null check (method in ('pos_customer_attach', 'order_reference', 'recent_transaction_select')),
  external_order_id text,
  external_transaction_id text,
  pos_transaction_id uuid,
  status text not null default 'pending_pos_confirmation'
    check (status in ('pending_pos_confirmation', 'confirmed', 'needs_review', 'rejected', 'cancelled')),
  status_reason text,
  associated_by_user_id uuid not null references togiva.user_profiles(id),
  terminal_id text,
  idempotency_key text not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  unique (connection_code_id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id),
  foreign key (organization_id, connection_code_id) references togiva.customer_connection_codes (organization_id, id),
  foreign key (organization_id, pos_connection_id) references togiva.pos_connections (organization_id, id),
  foreign key (organization_id, pos_transaction_id) references togiva.pos_transactions (organization_id, id),
  check (external_order_id is not null or external_transaction_id is not null or pos_transaction_id is not null)
);
-- One purchase can belong to only one customer.
create unique index associations_one_customer_per_order on togiva.customer_transaction_associations (organization_id, provider_code, external_order_id)
  where external_order_id is not null and status in ('pending_pos_confirmation', 'confirmed', 'needs_review');
create unique index associations_one_customer_per_txn on togiva.customer_transaction_associations (organization_id, pos_transaction_id)
  where pos_transaction_id is not null and status in ('pending_pos_confirmation', 'confirmed', 'needs_review');
create index associations_pending on togiva.customer_transaction_associations (created_at) where status in ('pending_pos_confirmation', 'needs_review');
create trigger customer_transaction_associations_touch before update on togiva.customer_transaction_associations
  for each row execute function togiva.touch_updated_at();

alter table togiva.customer_connection_codes
  add constraint connection_codes_association_fk foreign key (organization_id, association_id)
  references togiva.customer_transaction_associations (organization_id, id);

-- Append-only event stream: issue, replace, lookup success/failure, reserve,
-- release, associate, consume, expire, lockout. Never contains the raw code.
create table togiva.customer_connection_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references togiva.organizations(id),
  location_id uuid,
  connection_code_id uuid,
  organization_customer_id uuid,
  association_id uuid,
  actor_user_id uuid references togiva.user_profiles(id),
  event_type text not null check (event_type in (
    'code_issued', 'code_revoked', 'code_expired', 'lookup_succeeded', 'lookup_failed', 'lookup_locked_out',
    'reservation_released', 'reservation_expired', 'association_created', 'association_confirmed',
    'association_rejected', 'association_needs_review', 'code_consumed')),
  reason text,
  terminal_id text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index connection_events_failures_by_actor on togiva.customer_connection_events (actor_user_id, occurred_at desc) where event_type = 'lookup_failed';
create index connection_events_failures_by_location on togiva.customer_connection_events (location_id, occurred_at desc) where event_type = 'lookup_failed';
create index connection_events_code on togiva.customer_connection_events (connection_code_id);
create trigger customer_connection_events_append_only before update or delete on togiva.customer_connection_events
  for each row execute function togiva.prevent_mutation();

-- Lockout rule: if the N most recent failed lookups (N = limit) all fall
-- inside one failure window, lookups are locked until the last failure plus
-- the lockout period. Applied per employee-at-location and per location.
create or replace function togiva.lockout_remaining_seconds(p_times timestamptz[], p_limit int, p_window_s int, p_lockout_s int)
returns integer language sql stable as $$
  select case
    when coalesce(array_length(p_times, 1), 0) < p_limit then 0
    when p_times[p_limit] <= p_times[1] - make_interval(secs => p_window_s) then 0
    when p_times[1] + make_interval(secs => p_lockout_s) <= now() then 0
    else ceil(extract(epoch from (p_times[1] + make_interval(secs => p_lockout_s) - now())))::int
  end
$$;

-- Spans other employees' events (which RLS hides), hence SECURITY DEFINER.
-- Returns seconds remaining in a lockout, or 0.
create or replace function togiva.connection_code_lockout_seconds(p_location uuid, p_user uuid default togiva.current_user_id())
returns integer language plpgsql stable security definer set search_path = togiva, pg_temp as $$
declare
  v_window int := 600; v_lockout int := 900; v_user_limit int := 5; v_loc_limit int := 30;
  v_since timestamptz;
  v_user_times timestamptz[];
  v_loc_times timestamptz[];
begin
  select s.connection_code_failure_window_seconds, s.connection_code_lockout_seconds,
         s.connection_code_employee_failure_limit, s.connection_code_location_failure_limit
    into v_window, v_lockout, v_user_limit, v_loc_limit
  from locations l join organization_settings s on s.organization_id = l.organization_id
  where l.id = p_location;
  v_window := coalesce(v_window, 600); v_lockout := coalesce(v_lockout, 900);
  v_user_limit := coalesce(v_user_limit, 5); v_loc_limit := coalesce(v_loc_limit, 30);
  v_since := now() - make_interval(secs => v_window + v_lockout);

  select array_agg(occurred_at order by occurred_at desc) into v_user_times from (
    select occurred_at from customer_connection_events
    where event_type = 'lookup_failed' and location_id = p_location and actor_user_id = p_user and occurred_at > v_since
    order by occurred_at desc limit v_user_limit) t;
  select array_agg(occurred_at order by occurred_at desc) into v_loc_times from (
    select occurred_at from customer_connection_events
    where event_type = 'lookup_failed' and location_id = p_location and occurred_at > v_since
    order by occurred_at desc limit v_loc_limit) t;

  return greatest(
    togiva.lockout_remaining_seconds(v_user_times, v_user_limit, v_window, v_lockout),
    togiva.lockout_remaining_seconds(v_loc_times, v_loc_limit, v_window, v_lockout));
end $$;

-- Minimal disclosure to the cashier who holds the reservation: first name,
-- membership status, last four of the membership number, and tier name.
-- Nothing else about the customer is reachable through a connection code.
create or replace function togiva.connection_code_customer_summary(p_code_id uuid, p_user uuid default togiva.current_user_id())
returns table (first_name text, membership_status text, membership_number_last4 text, tier_name text)
language sql stable security definer set search_path = togiva, pg_temp as $$
  select cp.first_name, oc.status, right(oc.membership_number, 4), t.name
  from customer_connection_codes c
  join organization_customers oc on oc.id = c.organization_customer_id
  join customer_profiles cp on cp.id = oc.customer_profile_id
  left join loyalty_programs lp on lp.organization_id = oc.organization_id and lp.status = 'active'
  left join loyalty_accounts la on la.organization_customer_id = oc.id and la.loyalty_program_id = lp.id
  left join loyalty_tiers t on t.id = la.current_tier_id
  where c.id = p_code_id
    and c.reserved_by_user_id = p_user
    and c.status in ('reserved', 'consumed')
    and togiva.has_location_permission(c.location_id, 'customer.identify', p_user)
$$;

-- Settings readable by the connection-code service for any caller (customers
-- cannot read organization_settings directly).
create or replace function togiva.connection_code_settings(p_org uuid)
returns table (code_ttl_seconds int, reservation_ttl_seconds int, issue_limit_per_window int, failure_window_seconds int)
language sql stable security definer set search_path = togiva, pg_temp as $$
  select coalesce(s.connection_code_ttl_seconds, 300), coalesce(s.connection_code_reservation_ttl_seconds, 600),
         coalesce(s.connection_code_issue_limit_per_window, 10), coalesce(s.connection_code_failure_window_seconds, 600)
  from (select p_org as id) o left join organization_settings s on s.organization_id = o.id
$$;

-- Expires codes past expires_at and lapsed reservations. Called lazily before
-- issuing/looking up at a location, and by the periodic sweeper (p_location
-- null). A lapsed reservation returns the code to 'active' if the code itself
-- has not expired, so a slow checkout can be retried by the customer.
create or replace function togiva.expire_stale_connection_codes(p_location uuid default null)
returns integer language plpgsql security definer set search_path = togiva, pg_temp as $$
declare v_count int := 0; v_n int;
begin
  with lapsed as (
    update customer_connection_codes c
       set status = case when c.expires_at > now() then 'active' else 'expired' end,
           reserved_at = null, reservation_expires_at = null, reserved_by_user_id = null,
           reserved_terminal_id = null, reservation_idempotency_key = null
     where c.status = 'reserved' and c.reservation_expires_at <= now()
       and (p_location is null or c.location_id = p_location)
       and not exists (select 1 from customer_connection_codes o
                       where c.expires_at > now() and o.organization_customer_id = c.organization_customer_id
                         and o.status = 'active' and o.id <> c.id)
    returning c.id, c.organization_id, c.location_id, c.organization_customer_id, c.status)
  insert into customer_connection_events (organization_id, location_id, connection_code_id, organization_customer_id, event_type, reason)
  select organization_id, location_id, id, organization_customer_id, 'reservation_expired', 'reservation_lapsed_now_' || status from lapsed;
  get diagnostics v_n = row_count; v_count := v_count + v_n;

  -- lapsed reservations whose customer already holds a newer active code
  with lapsed as (
    update customer_connection_codes c
       set status = 'expired', reserved_at = null, reservation_expires_at = null, reserved_by_user_id = null,
           reserved_terminal_id = null, reservation_idempotency_key = null
     where c.status = 'reserved' and c.reservation_expires_at <= now()
       and (p_location is null or c.location_id = p_location)
    returning c.id, c.organization_id, c.location_id, c.organization_customer_id)
  insert into customer_connection_events (organization_id, location_id, connection_code_id, organization_customer_id, event_type, reason)
  select organization_id, location_id, id, organization_customer_id, 'reservation_expired', 'reservation_lapsed_now_expired' from lapsed;
  get diagnostics v_n = row_count; v_count := v_count + v_n;

  with expired as (
    update customer_connection_codes c set status = 'expired'
     where c.status = 'active' and c.expires_at <= now()
       and (p_location is null or c.location_id = p_location)
    returning c.id, c.organization_id, c.location_id, c.organization_customer_id)
  insert into customer_connection_events (organization_id, location_id, connection_code_id, organization_customer_id, event_type)
  select organization_id, location_id, id, organization_customer_id, 'code_expired' from expired;
  get diagnostics v_n = row_count; v_count := v_count + v_n;
  return v_count;
end $$;
