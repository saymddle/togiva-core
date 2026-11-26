-- 0003_customers: global customer identity separated from organization-specific
-- membership. A person has one customer_profile across the platform; each
-- organization they join gets its own organization_customers row with its own
-- membership number, consents, balances and history.

create table togiva.customer_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references togiva.user_profiles(id) on delete restrict,
  first_name text,
  last_name text,
  birth_month smallint check (birth_month between 1 and 12),
  birth_day smallint check (birth_day between 1 and 31),
  locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger customer_profiles_touch before update on togiva.customer_profiles
  for each row execute function togiva.touch_updated_at();

create table togiva.organization_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id) on delete restrict,
  customer_profile_id uuid not null references togiva.customer_profiles(id) on delete restrict,
  -- opaque, organization-unique, safe to show to staff
  membership_number text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  joined_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, customer_profile_id),
  unique (organization_id, membership_number)
);
create trigger organization_customers_touch before update on togiva.organization_customers
  for each row execute function togiva.touch_updated_at();

create table togiva.customer_preferences (
  organization_customer_id uuid primary key references togiva.organization_customers(id) on delete cascade,
  organization_id uuid not null references togiva.organizations(id),
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Consent is append-only per change so the history is provable.
create table togiva.customer_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  organization_customer_id uuid not null,
  consent_type text not null check (consent_type ~ '^[a-z_]+$'),
  granted boolean not null,
  policy_version text not null,
  source text not null default 'customer_app',
  recorded_at timestamptz not null default now(),
  ip_address inet,
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id)
);
create index customer_consents_lookup on togiva.customer_consents (organization_customer_id, consent_type, recorded_at desc);
create trigger customer_consents_append_only before update or delete on togiva.customer_consents
  for each row execute function togiva.prevent_mutation();

create table togiva.customer_location_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  organization_customer_id uuid not null,
  location_id uuid not null,
  is_preferred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id) on delete cascade,
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  unique (organization_customer_id, location_id)
);
create unique index customer_location_preferences_one_preferred on togiva.customer_location_preferences (organization_customer_id) where is_preferred;

create table togiva.customer_notification_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  organization_customer_id uuid not null,
  channel text not null check (channel in ('email', 'push', 'sms', 'in_app')),
  category text not null check (category ~ '^[a-z_]+$'),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id) on delete cascade,
  unique (organization_customer_id, channel, category)
);

-- Helper for RLS: organization_customer ids that belong to the caller.
create or replace function togiva.my_organization_customer_ids(p_user uuid default togiva.current_user_id())
returns setof uuid language sql stable security definer set search_path = togiva, pg_temp as $$
  select oc.id from organization_customers oc
  join customer_profiles cp on cp.id = oc.customer_profile_id
  where cp.user_id = p_user
$$;
