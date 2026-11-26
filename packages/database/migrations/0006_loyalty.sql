-- 0006_loyalty: configurable, versioned loyalty programs with an append-only
-- ledger. Business rules (earning rates, tiers, exclusions) are data in
-- program versions, never constants in code. Redeemable points and qualifying
-- spend are tracked separately so redemptions never reduce tier progress.

create table togiva.loyalty_programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index loyalty_programs_one_active on togiva.loyalty_programs (organization_id) where status = 'active';
create trigger loyalty_programs_touch before update on togiva.loyalty_programs
  for each row execute function togiva.touch_updated_at();

-- A published version is immutable. Ledger rows record the version used.
-- config shape: @togiva/shared-types LoyaltyProgramVersionConfig.
create table togiva.loyalty_program_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  loyalty_program_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  config jsonb not null,
  effective_from timestamptz,
  effective_to timestamptz,
  created_by uuid references togiva.user_profiles(id),
  published_by uuid references togiva.user_profiles(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (loyalty_program_id, version),
  foreign key (organization_id, loyalty_program_id) references togiva.loyalty_programs (organization_id, id)
);

create or replace function togiva.guard_published_program_version() returns trigger
language plpgsql as $$
begin
  if old.status in ('published', 'retired') and (
       new.config is distinct from old.config or new.version is distinct from old.version
       or new.effective_from is distinct from old.effective_from
       or new.loyalty_program_id is distinct from old.loyalty_program_id) then
    raise exception 'published loyalty program versions are immutable; create a new version' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger loyalty_program_versions_guard before update on togiva.loyalty_program_versions
  for each row execute function togiva.guard_published_program_version();

create table togiva.loyalty_tiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  program_version_id uuid not null,
  rank smallint not null check (rank > 0),
  name text not null,
  description text,
  qualification_metric text not null default 'qualifying_spend' check (qualification_metric in ('qualifying_spend', 'qualifying_visits', 'qualifying_points')),
  qualification_threshold bigint not null check (qualification_threshold >= 0),
  earning_multiplier numeric(6, 3) not null default 1 check (earning_multiplier > 0),
  benefits jsonb not null default '[]'::jsonb,
  unique (organization_id, id),
  unique (program_version_id, rank),
  foreign key (organization_id, program_version_id) references togiva.loyalty_program_versions (organization_id, id) on delete cascade
);

create table togiva.loyalty_earning_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  program_version_id uuid not null,
  rule_type text not null check (rule_type in ('base_rate', 'multiplier', 'fixed_bonus', 'spend_threshold_bonus', 'product_bonus', 'visit_bonus')),
  name text not null,
  priority integer not null default 100,
  -- points per one major currency unit of eligible spend (base_rate/product_bonus)
  points_per_unit numeric(12, 4),
  multiplier numeric(6, 3),
  bonus_points bigint,
  -- { locationIds?, regionIds?, tierRanks?, productRefs?, categories?, minEligibleMinor?, daysOfWeek? }
  conditions jsonb not null default '{}'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  campaign_id uuid,
  status text not null default 'active' check (status in ('active', 'disabled')),
  foreign key (organization_id, program_version_id) references togiva.loyalty_program_versions (organization_id, id) on delete cascade
);
create index loyalty_earning_rules_version on togiva.loyalty_earning_rules (program_version_id);

create table togiva.loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  organization_customer_id uuid not null,
  loyalty_program_id uuid not null,
  current_tier_id uuid,
  status text not null default 'active' check (status in ('active', 'frozen', 'closed')),
  opened_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_customer_id, loyalty_program_id),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id),
  foreign key (organization_id, loyalty_program_id) references togiva.loyalty_programs (organization_id, id),
  foreign key (organization_id, current_tier_id) references togiva.loyalty_tiers (organization_id, id)
);

-- Append-only. Positive points = credit, negative = debit. Corrections are
-- compensating entries referencing reverses_entry_id.
create table togiva.loyalty_ledger (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  loyalty_account_id uuid not null,
  entry_type text not null check (entry_type in ('earn', 'bonus', 'redeem', 'redeem_reversal', 'refund_reversal', 'void_reversal', 'adjustment', 'expiration')),
  points bigint not null check (points <> 0),
  qualifying_amount_minor bigint not null default 0,
  qualifying_visits integer not null default 0,
  currency char(3),
  source_type text not null check (source_type in ('pos_transaction', 'reward_redemption', 'adjustment_request', 'campaign', 'expiration_job', 'migration')),
  source_id text not null,
  location_id uuid,
  program_version_id uuid,
  earning_rule_ids uuid[] not null default '{}',
  reverses_entry_id bigint references togiva.loyalty_ledger(id),
  idempotency_key text not null,
  points_expire_at timestamptz,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid references togiva.user_profiles(id),
  metadata jsonb not null default '{}'::jsonb,
  unique (organization_id, idempotency_key),
  foreign key (organization_id, loyalty_account_id) references togiva.loyalty_accounts (organization_id, id),
  foreign key (organization_id, program_version_id) references togiva.loyalty_program_versions (organization_id, id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);
create index loyalty_ledger_account_time on togiva.loyalty_ledger (loyalty_account_id, occurred_at desc);
create index loyalty_ledger_source on togiva.loyalty_ledger (organization_id, source_type, source_id);
create trigger loyalty_ledger_append_only before update or delete on togiva.loyalty_ledger
  for each row execute function togiva.prevent_mutation();

-- Read model derived from the ledger. Rebuildable at any time.
create table togiva.loyalty_balance_projections (
  loyalty_account_id uuid primary key references togiva.loyalty_accounts(id),
  organization_id uuid not null,
  available_points bigint not null default 0 check (available_points >= 0),
  pending_points bigint not null default 0,
  lifetime_earned_points bigint not null default 0,
  lifetime_redeemed_points bigint not null default 0,
  last_ledger_entry_id bigint,
  updated_at timestamptz not null default now()
);

create table togiva.loyalty_qualification_progress (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  loyalty_account_id uuid not null,
  period_start date not null,
  period_end date not null,
  qualifying_amount_minor bigint not null default 0,
  qualifying_visits integer not null default 0,
  qualifying_points bigint not null default 0,
  achieved_tier_id uuid,
  updated_at timestamptz not null default now(),
  unique (loyalty_account_id, period_start),
  foreign key (organization_id, loyalty_account_id) references togiva.loyalty_accounts (organization_id, id)
);

create table togiva.rewards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  loyalty_program_id uuid not null,
  name text not null,
  description text,
  category text not null check (category in ('food', 'drink', 'side', 'upgrade', 'discount', 'merchandise', 'birthday', 'exclusive', 'limited_time', 'surprise')),
  points_cost bigint not null check (points_cost >= 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'retired')),
  available_from timestamptz,
  available_until timestamptz,
  all_participating_locations boolean not null default true,
  min_tier_rank smallint,
  per_customer_limit integer,
  per_customer_limit_period text check (per_customer_limit_period in ('day', 'week', 'month', 'year', 'lifetime')),
  redemption_ttl_seconds integer not null default 900 check (redemption_ttl_seconds between 60 and 86400),
  is_birthday boolean not null default false,
  is_exclusive boolean not null default false,
  is_surprise boolean not null default false,
  image_ref text,
  pos_discount_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, loyalty_program_id) references togiva.loyalty_programs (organization_id, id)
);
create trigger rewards_touch before update on togiva.rewards
  for each row execute function togiva.touch_updated_at();

create table togiva.reward_location_eligibility (
  organization_id uuid not null,
  reward_id uuid not null,
  location_id uuid not null,
  primary key (reward_id, location_id),
  foreign key (organization_id, reward_id) references togiva.rewards (organization_id, id) on delete cascade,
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);

create table togiva.reward_inventory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reward_id uuid not null,
  location_id uuid,
  quantity_total integer not null check (quantity_total >= 0),
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  quantity_redeemed integer not null default 0 check (quantity_redeemed >= 0),
  check (quantity_reserved + quantity_redeemed <= quantity_total),
  foreign key (organization_id, reward_id) references togiva.rewards (organization_id, id) on delete cascade,
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);
create unique index reward_inventory_scope on togiva.reward_inventory (reward_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Redemption tokens are separate from connection codes and are high-entropy.
create table togiva.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reward_id uuid not null,
  loyalty_account_id uuid not null,
  location_id uuid not null,
  status text not null default 'issued' check (status in ('issued', 'completed', 'expired', 'cancelled', 'reversed')),
  token_hash bytea not null unique,
  points_cost bigint not null,
  debit_ledger_entry_id bigint references togiva.loyalty_ledger(id),
  reversal_ledger_entry_id bigint references togiva.loyalty_ledger(id),
  idempotency_key text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  completed_by uuid references togiva.user_profiles(id),
  terminal_id text,
  pos_transaction_id uuid,
  unique (organization_id, idempotency_key),
  foreign key (organization_id, reward_id) references togiva.rewards (organization_id, id),
  foreign key (organization_id, loyalty_account_id) references togiva.loyalty_accounts (organization_id, id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  foreign key (organization_id, pos_transaction_id) references togiva.pos_transactions (organization_id, id)
);
create index reward_redemptions_account on togiva.reward_redemptions (loyalty_account_id, issued_at desc);
create index reward_redemptions_location on togiva.reward_redemptions (location_id, issued_at desc);

create table togiva.loyalty_adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  loyalty_account_id uuid not null,
  location_id uuid,
  points bigint not null check (points <> 0),
  qualifying_amount_minor bigint not null default 0,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'applied')),
  support_case_id uuid references togiva.support_cases(id),
  requested_by uuid not null references togiva.user_profiles(id),
  reviewed_by uuid references togiva.user_profiles(id),
  reviewed_at timestamptz,
  ledger_entry_id bigint references togiva.loyalty_ledger(id),
  created_at timestamptz not null default now(),
  foreign key (organization_id, loyalty_account_id) references togiva.loyalty_accounts (organization_id, id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  check (reviewed_by is null or reviewed_by <> requested_by)
);
