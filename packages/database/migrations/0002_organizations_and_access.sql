-- 0002_organizations_and_access: tenants, locations, regions, franchise ownership,
-- user identities, roles, permissions and the permission-resolution functions
-- that both row-level security and the API use. There is exactly one
-- implementation of "can user U do P at location L": togiva.has_location_permission.
--
-- Tenant consistency: every tenant-owned table carries organization_id, and
-- child rows reference parents through composite (organization_id, id) keys
-- so a row can never point at another tenant's parent.

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------
create table togiva.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  status text not null default 'active' check (status in ('onboarding', 'active', 'suspended', 'closed')),
  industry text,
  infrastructure_mode text not null default 'shared' check (infrastructure_mode in ('shared', 'dedicated')),
  default_currency char(3) not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  default_timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_touch before update on togiva.organizations
  for each row execute function togiva.touch_updated_at();

-- Typed platform settings. Client-specific presentation config (brand, copy)
-- does not belong here; it lives in the client application repository.
create table togiva.organization_settings (
  organization_id uuid primary key references togiva.organizations(id) on delete cascade,
  -- connection code service
  connection_code_ttl_seconds integer not null default 300 check (connection_code_ttl_seconds between 60 and 1800),
  connection_code_reservation_ttl_seconds integer not null default 600 check (connection_code_reservation_ttl_seconds between 60 and 3600),
  connection_code_issue_limit_per_window integer not null default 10 check (connection_code_issue_limit_per_window > 0),
  connection_code_employee_failure_limit integer not null default 5 check (connection_code_employee_failure_limit > 0),
  connection_code_location_failure_limit integer not null default 30 check (connection_code_location_failure_limit > 0),
  connection_code_failure_window_seconds integer not null default 600 check (connection_code_failure_window_seconds > 0),
  connection_code_lockout_seconds integer not null default 900 check (connection_code_lockout_seconds > 0),
  -- data retention (days); null means retain until a policy is set
  retention_connection_events_days integer default 365,
  retention_pos_raw_payload_days integer default 90,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create trigger organization_settings_touch before update on togiva.organization_settings
  for each row execute function togiva.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Locations and regions
-- ---------------------------------------------------------------------------
create table togiva.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id) on delete restrict,
  store_code text not null,
  name text not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'inactive', 'closed')),
  loyalty_participating boolean not null default false,
  timezone text not null default 'UTC',
  address_line1 text,
  address_line2 text,
  city text,
  region_code text,
  postal_code text,
  country_code char(2),
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  phone text,
  opened_on date,
  closed_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, store_code)
);
create index locations_org_status_idx on togiva.locations (organization_id, status);
create trigger locations_touch before update on togiva.locations
  for each row execute function togiva.touch_updated_at();

create table togiva.regions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id) on delete restrict,
  name text not null,
  code text,
  parent_region_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name),
  foreign key (organization_id, parent_region_id) references togiva.regions (organization_id, id)
);
create trigger regions_touch before update on togiva.regions
  for each row execute function togiva.touch_updated_at();

-- Historical: a location's region assignment ends by setting effective_to.
create table togiva.location_regions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  region_id uuid not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  foreign key (organization_id, region_id) references togiva.regions (organization_id, id),
  check (effective_to is null or effective_to > effective_from)
);
create unique index location_regions_one_current on togiva.location_regions (location_id, region_id) where effective_to is null;
create index location_regions_region_idx on togiva.location_regions (region_id) where effective_to is null;

-- ---------------------------------------------------------------------------
-- Users (global identities). id is the subject of the identity provider
-- (Supabase Auth user id today). Credentials never live in this table.
-- ---------------------------------------------------------------------------
create table togiva.user_profiles (
  id uuid primary key,
  email text not null,
  email_verified_at timestamptz,
  first_name text,
  last_name text,
  display_name text,
  phone text,
  status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index user_profiles_email_key on togiva.user_profiles (lower(email)) where status <> 'deleted';
create trigger user_profiles_touch before update on togiva.user_profiles
  for each row execute function togiva.touch_updated_at();

-- TOGIVA staff who operate the platform. Grants platform administration only;
-- it does NOT grant access to any organization's customer PII.
create table togiva.platform_admins (
  user_id uuid primary key references togiva.user_profiles(id) on delete cascade,
  granted_by uuid references togiva.user_profiles(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Franchise ownership
-- ---------------------------------------------------------------------------
create table togiva.franchise_owners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id) on delete restrict,
  legal_name text not null,
  display_name text,
  contact_email text,
  contact_phone text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create trigger franchise_owners_touch before update on togiva.franchise_owners
  for each row execute function togiva.touch_updated_at();

-- People who act for a franchise owner entity (an owner may be a company).
create table togiva.franchise_owner_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  franchise_owner_id uuid not null,
  user_id uuid not null references togiva.user_profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (organization_id, franchise_owner_id) references togiva.franchise_owners (organization_id, id)
);
create unique index franchise_owner_members_active on togiva.franchise_owner_members (franchise_owner_id, user_id) where status = 'active';
create index franchise_owner_members_user_idx on togiva.franchise_owner_members (user_id) where status = 'active';

-- Many owners per location and many locations per owner, with history.
create table togiva.franchise_location_ownerships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  franchise_owner_id uuid not null,
  location_id uuid not null,
  ownership_percent numeric(5, 2) check (ownership_percent is null or (ownership_percent > 0 and ownership_percent <= 100)),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  created_by uuid references togiva.user_profiles(id),
  foreign key (organization_id, franchise_owner_id) references togiva.franchise_owners (organization_id, id),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  check (effective_to is null or effective_to > effective_from)
);
create index franchise_location_ownerships_location_idx on togiva.franchise_location_ownerships (location_id);
create index franchise_location_ownerships_owner_idx on togiva.franchise_location_ownerships (franchise_owner_id);

-- ---------------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------------
create table togiva.permissions (
  code text primary key check (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description text not null,
  grants_customer_pii boolean not null default false
);

-- organization_id null = platform-provided role template usable by every
-- organization. scope says where an assignment of this role applies.
create table togiva.role_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references togiva.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z_]+$'),
  name text not null,
  description text,
  scope text not null check (scope in ('organization', 'region', 'franchise', 'location')),
  -- may a location-level manager (franchise owner / GM) assign this role?
  assignable_by_location_managers boolean not null default false,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index role_definitions_key on togiva.role_definitions (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

create table togiva.role_permissions (
  role_id uuid not null references togiva.role_definitions(id) on delete cascade,
  permission_code text not null references togiva.permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

-- Staff membership in an organization. role_id is set for organization-wide
-- roles (corporate admin / analyst). Location, region and franchise roles are
-- granted through the scoped membership tables below, but every staff member
-- must also hold an active organization membership.
create table togiva.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id) on delete restrict,
  user_id uuid not null references togiva.user_profiles(id) on delete cascade,
  role_id uuid references togiva.role_definitions(id),
  status text not null default 'active' check (status in ('invited', 'active', 'suspended', 'revoked')),
  invited_by uuid references togiva.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (organization_id, user_id)
);
create index organization_memberships_user_idx on togiva.organization_memberships (user_id) where status = 'active';
create trigger organization_memberships_touch before update on togiva.organization_memberships
  for each row execute function togiva.touch_updated_at();

create table togiva.region_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  region_id uuid not null,
  user_id uuid not null references togiva.user_profiles(id) on delete cascade,
  role_id uuid not null references togiva.role_definitions(id),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid references togiva.user_profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (organization_id, region_id) references togiva.regions (organization_id, id)
);
create unique index region_memberships_active on togiva.region_memberships (region_id, user_id, role_id) where status = 'active';
create index region_memberships_user_idx on togiva.region_memberships (user_id) where status = 'active';

create table togiva.location_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  user_id uuid not null references togiva.user_profiles(id) on delete cascade,
  role_id uuid not null references togiva.role_definitions(id),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid references togiva.user_profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id)
);
create unique index location_memberships_active on togiva.location_memberships (location_id, user_id, role_id) where status = 'active';
create index location_memberships_user_idx on togiva.location_memberships (user_id) where status = 'active';

-- Franchise-owner role assignment: applies to every location the owner entity
-- currently owns.
create table togiva.franchise_role_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  franchise_owner_member_id uuid not null references togiva.franchise_owner_members(id) on delete cascade,
  role_id uuid not null references togiva.role_definitions(id),
  created_at timestamptz not null default now()
);

create table togiva.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references togiva.organizations(id),
  email text not null,
  role_id uuid not null references togiva.role_definitions(id),
  location_id uuid,
  region_id uuid,
  token_hash bytea not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid not null references togiva.user_profiles(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid references togiva.user_profiles(id),
  created_at timestamptz not null default now(),
  foreign key (organization_id, location_id) references togiva.locations (organization_id, id),
  foreign key (organization_id, region_id) references togiva.regions (organization_id, id)
);

-- ---------------------------------------------------------------------------
-- Permission resolution (single source of truth).
-- SECURITY DEFINER so RLS policies can call them without recursive RLS.
-- ---------------------------------------------------------------------------
create or replace function togiva.is_platform_admin(p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select exists (select 1 from platform_admins where user_id = p_user and revoked_at is null)
$$;

create or replace function togiva.is_active_org_member(p_org uuid, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select exists (
    select 1 from organization_memberships m
    join organizations o on o.id = m.organization_id and o.status in ('onboarding', 'active')
    join user_profiles u on u.id = m.user_id and u.status = 'active'
    where m.organization_id = p_org and m.user_id = p_user and m.status = 'active')
$$;

-- Organization-wide permission (corporate roles only).
create or replace function togiva.has_org_permission(p_org uuid, p_permission text, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select togiva.is_active_org_member(p_org, p_user) and exists (
    select 1 from organization_memberships m
    join role_permissions rp on rp.role_id = m.role_id
    where m.organization_id = p_org and m.user_id = p_user and m.status = 'active'
      and rp.permission_code = p_permission)
$$;

-- Every location where p_user holds p_permission, through any path:
-- organization role, region role, franchise ownership, or location role.
create or replace function togiva.permitted_location_ids(p_permission text, p_user uuid default togiva.current_user_id())
returns table (organization_id uuid, location_id uuid)
language sql stable security definer set search_path = togiva, pg_temp as $$
  with orgs as (
    select m.organization_id from organization_memberships m
    join organizations o on o.id = m.organization_id and o.status in ('onboarding', 'active')
    join user_profiles u on u.id = m.user_id and u.status = 'active'
    where m.user_id = p_user and m.status = 'active'
  )
  -- organization-wide role
  select l.organization_id, l.id from locations l
  join organization_memberships m on m.organization_id = l.organization_id and m.user_id = p_user and m.status = 'active'
  join role_permissions rp on rp.role_id = m.role_id and rp.permission_code = p_permission
  where l.organization_id in (select organization_id from orgs)
  union
  -- region role (current region assignment, including child regions one level deep)
  select l.organization_id, l.id from region_memberships rm
  join role_permissions rp on rp.role_id = rm.role_id and rp.permission_code = p_permission
  join regions r on r.organization_id = rm.organization_id and (r.id = rm.region_id or r.parent_region_id = rm.region_id)
  join location_regions lr on lr.region_id = r.id and lr.effective_to is null
  join locations l on l.id = lr.location_id
  where rm.user_id = p_user and rm.status = 'active' and rm.organization_id in (select organization_id from orgs)
  union
  -- franchise owner role on currently owned locations
  select l.organization_id, l.id from franchise_owner_members fm
  join franchise_owners fo on fo.id = fm.franchise_owner_id and fo.status = 'active'
  join franchise_role_assignments fra on fra.franchise_owner_member_id = fm.id
  join role_permissions rp on rp.role_id = fra.role_id and rp.permission_code = p_permission
  join franchise_location_ownerships flo on flo.franchise_owner_id = fo.id
    and flo.effective_from <= current_date and (flo.effective_to is null or flo.effective_to > current_date)
  join locations l on l.id = flo.location_id
  where fm.user_id = p_user and fm.status = 'active' and fm.organization_id in (select organization_id from orgs)
  union
  -- direct location role
  select l.organization_id, l.id from location_memberships lm
  join role_permissions rp on rp.role_id = lm.role_id and rp.permission_code = p_permission
  join locations l on l.id = lm.location_id
  where lm.user_id = p_user and lm.status = 'active' and lm.organization_id in (select organization_id from orgs)
$$;

create or replace function togiva.has_location_permission(p_location uuid, p_permission text, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select exists (select 1 from togiva.permitted_location_ids(p_permission, p_user) where location_id = p_location)
$$;

-- True when the user holds the permission at the organization level or at any
-- of its locations (used for organization-scoped resources visible to
-- location staff, e.g. the reward catalog).
create or replace function togiva.has_any_permission_in_org(p_org uuid, p_permission text, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select togiva.has_org_permission(p_org, p_permission, p_user)
      or exists (select 1 from togiva.permitted_location_ids(p_permission, p_user) where organization_id = p_org)
$$;

-- Privilege-escalation guard: who may grant a role at a location.
-- Organization staff managers may grant any location role; location managers
-- (franchise owner, general manager) may grant only roles flagged
-- assignable_by_location_managers, and never organization or region roles.
create or replace function togiva.can_grant_location_role(p_location uuid, p_role uuid, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select exists (
    select 1 from role_definitions r
    join locations l on l.id = p_location
    where r.id = p_role and r.scope = 'location'
      and (r.organization_id is null or r.organization_id = l.organization_id)
      and (
        togiva.has_org_permission(l.organization_id, 'staff.manage', p_user)
        or (r.assignable_by_location_managers and togiva.has_location_permission(p_location, 'staff.manage', p_user))
      ))
$$;

create or replace function togiva.enforce_location_membership_grant() returns trigger
language plpgsql as $$
begin
  -- Enforced for request-scoped writes made as togiva_app. Trusted services
  -- (togiva_service) authorize in code before writing.
  if current_user = 'togiva_app' and not togiva.can_grant_location_role(new.location_id, new.role_id) then
    raise exception 'not permitted to grant this role at this location' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger location_memberships_grant_guard before insert or update of role_id, location_id on togiva.location_memberships
  for each row execute function togiva.enforce_location_membership_grant();

-- ---------------------------------------------------------------------------
-- Platform permission catalogue and role templates. These are TOGIVA platform
-- definitions, not client data. Organizations may add custom roles later.
-- ---------------------------------------------------------------------------
insert into togiva.permissions (code, description, grants_customer_pii) values
  ('organization.read', 'View organization profile and settings', false),
  ('organization.manage', 'Edit organization profile and settings', false),
  ('location.read', 'View location details', false),
  ('location.manage', 'Create and edit locations, activate or deactivate', false),
  ('region.read', 'View regions', false),
  ('region.manage', 'Create regions and assign locations', false),
  ('franchise.read', 'View franchise owners and ownership', false),
  ('franchise.manage', 'Manage franchise owners and ownership records', false),
  ('staff.read', 'View staff and their assignments', false),
  ('staff.manage', 'Invite, assign and deactivate staff', false),
  ('customer.identify', 'Look up a customer by connection code and see minimal identification', false),
  ('customer.read_membership', 'View membership status, tier and balance for a customer', false),
  ('customer.read_pii', 'View customer contact details and profile', true),
  ('customer.manage', 'Edit or deactivate customer accounts', true),
  ('connection.associate', 'Attach an identified customer to a POS order', false),
  ('loyalty.read', 'View loyalty program configuration', false),
  ('loyalty.configure', 'Edit loyalty programs, tiers, earning rules', false),
  ('loyalty.adjust.request', 'Request a loyalty adjustment', false),
  ('loyalty.adjust.approve', 'Approve loyalty adjustments', false),
  ('rewards.read', 'View reward catalog', false),
  ('rewards.manage', 'Create and edit rewards', false),
  ('rewards.redeem.verify', 'Validate and complete reward redemptions', false),
  ('campaigns.read', 'View campaigns and results', false),
  ('campaigns.manage', 'Create, publish, pause and end campaigns', false),
  ('analytics.location.read', 'View location analytics', false),
  ('analytics.network.read', 'View network and regional analytics', false),
  ('transactions.read', 'View POS transactions', false),
  ('pos.read', 'View POS connection status and errors', false),
  ('pos.manage', 'Connect, map and reconcile POS integrations', false),
  ('support.submit', 'Submit support cases', false),
  ('support.resolve', 'Review and resolve support cases', false),
  ('audit.read', 'View audit logs', false);

insert into togiva.role_definitions (key, name, description, scope, assignable_by_location_managers, is_system) values
  ('corporate_admin', 'Corporate Administrator', 'Manages the entire organization', 'organization', false, true),
  ('corporate_analyst', 'Corporate Analyst', 'Network reporting without modification rights', 'organization', false, true),
  ('regional_manager', 'Regional Manager', 'Sees and manages assigned regions only', 'region', false, true),
  ('franchise_owner', 'Franchise Owner', 'Manages owned locations', 'franchise', false, true),
  ('general_manager', 'General Manager', 'Manages assigned locations', 'location', true, true),
  ('store_employee', 'Store Employee', 'Customer identification, reward verification, customer service', 'location', true, true);

with grants(role_key, perms) as (values
  ('corporate_admin', array['organization.read','organization.manage','location.read','location.manage','region.read','region.manage',
    'franchise.read','franchise.manage','staff.read','staff.manage','customer.identify','customer.read_membership','customer.read_pii',
    'customer.manage','connection.associate','loyalty.read','loyalty.configure','loyalty.adjust.request','loyalty.adjust.approve',
    'rewards.read','rewards.manage','rewards.redeem.verify','campaigns.read','campaigns.manage','analytics.location.read',
    'analytics.network.read','transactions.read','pos.read','pos.manage','support.submit','support.resolve','audit.read']),
  ('corporate_analyst', array['organization.read','location.read','region.read','franchise.read','loyalty.read','rewards.read',
    'campaigns.read','analytics.location.read','analytics.network.read','transactions.read','pos.read']),
  ('regional_manager', array['location.read','region.read','franchise.read','staff.read','customer.read_membership','loyalty.read',
    'rewards.read','campaigns.read','analytics.location.read','transactions.read','pos.read','support.submit']),
  ('franchise_owner', array['location.read','staff.read','staff.manage','customer.identify','customer.read_membership',
    'connection.associate','loyalty.read','loyalty.adjust.request','rewards.read','rewards.redeem.verify','campaigns.read',
    'analytics.location.read','transactions.read','pos.read','pos.manage','support.submit']),
  ('general_manager', array['location.read','staff.read','staff.manage','customer.identify','customer.read_membership',
    'connection.associate','loyalty.read','loyalty.adjust.request','rewards.read','rewards.redeem.verify','campaigns.read',
    'analytics.location.read','transactions.read','pos.read','support.submit']),
  ('store_employee', array['location.read','customer.identify','customer.read_membership','connection.associate','rewards.read',
    'rewards.redeem.verify','support.submit'])
)
insert into togiva.role_permissions (role_id, permission_code)
select r.id, unnest(g.perms) from grants g
join togiva.role_definitions r on r.key = g.role_key and r.organization_id is null;
