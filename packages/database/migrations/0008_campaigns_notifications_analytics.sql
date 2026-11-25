-- 0008: campaigns, offers, notifications and analytics aggregates.
-- Aggregates are produced by background jobs from verified operational data;
-- dashboards read these tables, never the transactional hot path.

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table togiva.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id),
  name text not null,
  objective text,
  scope text not null check (scope in ('network', 'regional', 'location')),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'active', 'paused', 'ended', 'cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  incentive jsonb not null default '{}'::jsonb,
  created_by uuid references togiva.user_profiles(id),
  published_by uuid references togiva.user_profiles(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create trigger campaigns_touch before update on togiva.campaigns
  for each row execute function togiva.touch_updated_at();

alter table togiva.loyalty_earning_rules
  add constraint loyalty_earning_rules_campaign_fk foreign key (organization_id, campaign_id) references togiva.campaigns (organization_id, id);

create table togiva.campaign_locations (
  organization_id uuid not null,
  campaign_id uuid not null,
  location_id uuid,
  region_id uuid,
  foreign key (organization_id, campaign_id) references togiva.campaigns (organization_id, id) on delete cascade,
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  foreign key (organization_id, region_id) references togiva.regions (organization_id, id),
  check ((location_id is null) <> (region_id is null))
);
create unique index campaign_locations_unique on togiva.campaign_locations (campaign_id, coalesce(location_id, region_id));

create table togiva.campaign_segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  name text not null,
  -- { tierRanks?, joinedAfter?, lastVisitBefore?, birthdayMonth?, preferredLocationIds? }
  definition jsonb not null,
  foreign key (organization_id, campaign_id) references togiva.campaigns (organization_id, id) on delete cascade
);

create table togiva.campaign_eligibility_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  rule_type text not null,
  parameters jsonb not null default '{}'::jsonb,
  foreign key (organization_id, campaign_id) references togiva.campaigns (organization_id, id) on delete cascade
);

create table togiva.customer_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid,
  organization_customer_id uuid not null,
  title text not null,
  body text,
  offer_type text not null check (offer_type in ('bonus_points', 'points_multiplier', 'reward_unlock', 'discount', 'informational')),
  parameters jsonb not null default '{}'::jsonb,
  status text not null default 'available' check (status in ('available', 'activated', 'redeemed', 'expired', 'withdrawn')),
  available_from timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, campaign_id) references togiva.campaigns (organization_id, id),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id)
);
create index customer_offers_customer on togiva.customer_offers (organization_customer_id, status);

create table togiva.offer_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_offer_id uuid not null,
  location_id uuid,
  pos_transaction_id uuid,
  ledger_entry_id bigint references togiva.loyalty_ledger(id),
  redeemed_at timestamptz not null default now(),
  foreign key (organization_id, customer_offer_id) references togiva.customer_offers (organization_id, id),
  unique (customer_offer_id)
);

create table togiva.campaign_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references togiva.organizations(id),
  campaign_id uuid not null,
  organization_customer_id uuid,
  event_type text not null check (event_type in ('published', 'paused', 'resumed', 'ended', 'offer_issued', 'offer_viewed', 'offer_activated', 'offer_redeemed', 'bonus_awarded')),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index campaign_events_campaign_time on togiva.campaign_events (campaign_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Notifications (provider-independent)
-- ---------------------------------------------------------------------------
create table togiva.notification_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references togiva.organizations(id),
  key text not null,
  channel text not null check (channel in ('email', 'push', 'sms', 'in_app')),
  locale text not null default 'en',
  subject text,
  body text not null,
  version integer not null default 1,
  status text not null default 'active' check (status in ('draft', 'active', 'retired')),
  created_at timestamptz not null default now()
);
create unique index notification_templates_key on togiva.notification_templates (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key, channel, locale, version);

create table togiva.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id),
  recipient_user_id uuid not null references togiva.user_profiles(id),
  category text not null,
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_recipient on togiva.notifications (recipient_user_id, created_at desc);

-- Staff notification preferences (customers use customer_notification_preferences).
create table togiva.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id),
  user_id uuid not null references togiva.user_profiles(id),
  channel text not null check (channel in ('email', 'push', 'sms', 'in_app')),
  category text not null,
  enabled boolean not null,
  unique (organization_id, user_id, channel, category)
);

create table togiva.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references togiva.user_profiles(id) on delete cascade,
  organization_id uuid not null references togiva.organizations(id),
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (endpoint)
);

create table togiva.notification_delivery_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references togiva.organizations(id),
  notification_id uuid references togiva.notifications(id),
  channel text not null,
  provider text not null,
  provider_message_id text,
  status text not null check (status in ('queued', 'sent', 'delivered', 'failed', 'suppressed')),
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Analytics aggregates. Money in minor units; `data_status` makes delayed or
-- partial days explicit to dashboards ("estimated" vs "finalized").
-- ---------------------------------------------------------------------------
create table togiva.location_daily_metrics (
  organization_id uuid not null,
  location_id uuid not null,
  metric_date date not null,
  currency char(3) not null,
  gross_sales_minor bigint not null default 0,
  net_sales_minor bigint not null default 0,
  refunds_minor bigint not null default 0,
  transaction_count integer not null default 0,
  member_transaction_count integer not null default 0,
  unique_members integer not null default 0,
  returning_members integer not null default 0,
  new_members integer not null default 0,
  points_issued bigint not null default 0,
  points_redeemed bigint not null default 0,
  rewards_redeemed integer not null default 0,
  connection_codes_issued integer not null default 0,
  connection_codes_associated integer not null default 0,
  data_status text not null default 'estimated' check (data_status in ('estimated', 'finalized')),
  computed_at timestamptz not null default now(),
  primary key (location_id, metric_date),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);
create index location_daily_metrics_org_date on togiva.location_daily_metrics (organization_id, metric_date);

create table togiva.regional_daily_metrics (
  organization_id uuid not null,
  region_id uuid not null,
  metric_date date not null,
  currency char(3) not null,
  location_count integer not null default 0,
  gross_sales_minor bigint not null default 0,
  net_sales_minor bigint not null default 0,
  transaction_count integer not null default 0,
  member_transaction_count integer not null default 0,
  points_issued bigint not null default 0,
  points_redeemed bigint not null default 0,
  data_status text not null default 'estimated' check (data_status in ('estimated', 'finalized')),
  computed_at timestamptz not null default now(),
  primary key (region_id, metric_date),
  foreign key (organization_id, region_id) references togiva.regions (organization_id, id)
);

create table togiva.network_daily_metrics (
  organization_id uuid not null references togiva.organizations(id),
  metric_date date not null,
  currency char(3) not null,
  active_locations integer not null default 0,
  gross_sales_minor bigint not null default 0,
  net_sales_minor bigint not null default 0,
  transaction_count integer not null default 0,
  member_transaction_count integer not null default 0,
  total_members integer not null default 0,
  active_members_30d integer not null default 0,
  new_members integer not null default 0,
  points_issued bigint not null default 0,
  points_redeemed bigint not null default 0,
  data_status text not null default 'estimated' check (data_status in ('estimated', 'finalized')),
  computed_at timestamptz not null default now(),
  primary key (organization_id, metric_date)
);

create table togiva.customer_activity_aggregates (
  organization_id uuid not null,
  organization_customer_id uuid not null,
  first_visit_at timestamptz,
  last_visit_at timestamptz,
  visit_count integer not null default 0,
  lifetime_spend_minor bigint not null default 0,
  visits_90d integer not null default 0,
  spend_90d_minor bigint not null default 0,
  computed_at timestamptz not null default now(),
  primary key (organization_customer_id),
  foreign key (organization_id, organization_customer_id) references togiva.organization_customers (organization_id, id)
);

create table togiva.campaign_performance_aggregates (
  organization_id uuid not null,
  campaign_id uuid not null,
  metric_date date not null,
  offers_issued integer not null default 0,
  offers_redeemed integer not null default 0,
  participating_members integer not null default 0,
  attributed_sales_minor bigint not null default 0,
  bonus_points_awarded bigint not null default 0,
  computed_at timestamptz not null default now(),
  primary key (campaign_id, metric_date),
  foreign key (organization_id, campaign_id) references togiva.campaigns (organization_id, id)
);

create table togiva.reward_performance_aggregates (
  organization_id uuid not null,
  reward_id uuid not null,
  location_id uuid,
  metric_date date not null,
  redemptions integer not null default 0,
  points_spent bigint not null default 0,
  computed_at timestamptz not null default now(),
  foreign key (organization_id, reward_id) references togiva.rewards (organization_id, id)
);
create unique index reward_performance_aggregates_key on togiva.reward_performance_aggregates (reward_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), metric_date);
