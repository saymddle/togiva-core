-- 0009_row_level_security: grants and policies.
--
-- Model:
--   * Every table in the togiva schema has RLS enabled. No policy = no access.
--   * togiva_app (request role) gets only the privileges listed here, and
--     policies scope every row to the caller via the permission functions in
--     0002. Ledgers, POS raw data, jobs and credentials are not writable (or
--     not readable) by togiva_app at all.
--   * togiva_service bypasses RLS and is used by trusted domain services after
--     authorization in code, and by background workers.
--   * Platform admins see organizations, not customer data.

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'togiva' loop
    execute format('alter table togiva.%I enable row level security', t.tablename);
    execute format('grant select, insert, update, delete on togiva.%I to togiva_service', t.tablename);
  end loop;
end $$;
grant usage on all sequences in schema togiva to togiva_service;
grant execute on all functions in schema togiva to togiva_app, togiva_service;

-- Helpers -------------------------------------------------------------------
create or replace function togiva.is_org_customer(p_org uuid, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select exists (select 1 from organization_customers oc join customer_profiles cp on cp.id = oc.customer_profile_id
                 where oc.organization_id = p_org and cp.user_id = p_user and oc.status = 'active')
$$;

create or replace function togiva.has_region_permission(p_region uuid, p_permission text, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select exists (
    select 1 from regions r
    where r.id = p_region and (
      togiva.has_org_permission(r.organization_id, p_permission, p_user)
      or exists (select 1 from region_memberships rm join role_permissions rp on rp.role_id = rm.role_id
                 join regions r2 on r2.id = p_region and (r2.id = rm.region_id or r2.parent_region_id = rm.region_id)
                 where rm.user_id = p_user and rm.status = 'active' and rp.permission_code = p_permission
                   and togiva.is_active_org_member(rm.organization_id, p_user))))
$$;

create or replace function togiva.can_view_staff_user(p_target uuid, p_user uuid default togiva.current_user_id())
returns boolean language sql stable security definer set search_path = togiva, pg_temp as $$
  select exists (select 1 from organization_memberships m where m.user_id = p_target and m.status <> 'revoked'
                   and togiva.has_org_permission(m.organization_id, 'staff.read', p_user))
      or exists (select 1 from location_memberships lm where lm.user_id = p_target and lm.status = 'active'
                   and togiva.has_location_permission(lm.location_id, 'staff.read', p_user))
$$;

-- Jobs are enqueued by request handlers only through this function.
create or replace function togiva.enqueue_job(p_job_type text, p_payload jsonb, p_organization_id uuid default null,
  p_idempotency_key text default null, p_run_at timestamptz default now(), p_queue text default 'default')
returns bigint language plpgsql security definer set search_path = togiva, pg_temp as $$
declare v_id bigint;
begin
  insert into background_jobs (organization_id, queue, job_type, payload, run_at, idempotency_key)
  values (p_organization_id, p_queue, p_job_type, coalesce(p_payload, '{}'::jsonb), p_run_at, p_idempotency_key)
  on conflict (job_type, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from background_jobs where job_type = p_job_type and idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end $$;
grant execute on function togiva.enqueue_job(text, jsonb, uuid, text, timestamptz, text) to togiva_app;

-- ---------------------------------------------------------------------------
-- Organizations and access
-- ---------------------------------------------------------------------------
grant select, update on togiva.organizations to togiva_app;
create policy org_select on togiva.organizations for select to togiva_app
  using (togiva.is_active_org_member(id) or togiva.is_org_customer(id) or togiva.is_platform_admin());
create policy org_update on togiva.organizations for update to togiva_app
  using (togiva.has_org_permission(id, 'organization.manage')) with check (togiva.has_org_permission(id, 'organization.manage'));

grant select, update on togiva.organization_settings to togiva_app;
create policy org_settings_select on togiva.organization_settings for select to togiva_app
  using (togiva.is_active_org_member(organization_id));
create policy org_settings_update on togiva.organization_settings for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'organization.manage'));

grant select, insert, update on togiva.locations to togiva_app;
create policy locations_select_staff on togiva.locations for select to togiva_app
  using (togiva.has_location_permission(id, 'location.read'));
-- Customers (and prospective members) may browse participating active locations.
create policy locations_select_public on togiva.locations for select to togiva_app
  using (status = 'active' and loyalty_participating);
create policy locations_write on togiva.locations for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'location.manage'));
create policy locations_update on togiva.locations for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'location.manage'))
  with check (togiva.has_org_permission(organization_id, 'location.manage'));

grant select, insert, update on togiva.regions, togiva.location_regions to togiva_app;
create policy regions_select on togiva.regions for select to togiva_app
  using (togiva.has_region_permission(id, 'region.read'));
create policy regions_insert on togiva.regions for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'region.manage'));
create policy regions_update on togiva.regions for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'region.manage'));
create policy location_regions_select on togiva.location_regions for select to togiva_app
  using (togiva.has_region_permission(region_id, 'region.read'));
create policy location_regions_insert on togiva.location_regions for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'region.manage'));
create policy location_regions_update on togiva.location_regions for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'region.manage'));

grant select, update (first_name, last_name, display_name, phone) on togiva.user_profiles to togiva_app;
create policy user_profiles_select on togiva.user_profiles for select to togiva_app
  using (id = togiva.current_user_id() or togiva.can_view_staff_user(id));
create policy user_profiles_update_self on togiva.user_profiles for update to togiva_app
  using (id = togiva.current_user_id()) with check (id = togiva.current_user_id());

grant select on togiva.platform_admins to togiva_app;
create policy platform_admins_select on togiva.platform_admins for select to togiva_app
  using (user_id = togiva.current_user_id() or togiva.is_platform_admin());

grant select, insert, update on togiva.franchise_owners, togiva.franchise_owner_members,
  togiva.franchise_location_ownerships, togiva.franchise_role_assignments to togiva_app;
create policy franchise_owners_select on togiva.franchise_owners for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'franchise.read')
         or exists (select 1 from togiva.franchise_owner_members m where m.franchise_owner_id = id and m.user_id = togiva.current_user_id() and m.status = 'active'));
create policy franchise_owners_insert on togiva.franchise_owners for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'franchise.manage'));
create policy franchise_owners_update on togiva.franchise_owners for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'franchise.manage'));
create policy franchise_owner_members_select on togiva.franchise_owner_members for select to togiva_app
  using (user_id = togiva.current_user_id() or togiva.has_any_permission_in_org(organization_id, 'franchise.read'));
create policy franchise_owner_members_write on togiva.franchise_owner_members for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'franchise.manage'));
create policy franchise_owner_members_update on togiva.franchise_owner_members for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'franchise.manage'));
create policy flo_select on togiva.franchise_location_ownerships for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'franchise.read'));
create policy flo_insert on togiva.franchise_location_ownerships for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'franchise.manage'));
create policy flo_update on togiva.franchise_location_ownerships for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'franchise.manage'));
create policy fra_select on togiva.franchise_role_assignments for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'franchise.read'));
create policy fra_insert on togiva.franchise_role_assignments for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'franchise.manage'));

grant select on togiva.permissions, togiva.role_permissions to togiva_app;
grant select, insert on togiva.role_definitions to togiva_app;
create policy permissions_select on togiva.permissions for select to togiva_app using (true);
create policy role_permissions_select on togiva.role_permissions for select to togiva_app using (true);
create policy role_definitions_select on togiva.role_definitions for select to togiva_app
  using (organization_id is null or togiva.is_active_org_member(organization_id));
create policy role_definitions_insert on togiva.role_definitions for insert to togiva_app
  with check (organization_id is not null and not is_system and togiva.has_org_permission(organization_id, 'staff.manage'));

grant select, insert, update on togiva.organization_memberships, togiva.region_memberships, togiva.location_memberships to togiva_app;
create policy org_memberships_select on togiva.organization_memberships for select to togiva_app
  using (user_id = togiva.current_user_id() or togiva.has_org_permission(organization_id, 'staff.read') or togiva.can_view_staff_user(user_id));
create policy org_memberships_insert on togiva.organization_memberships for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'staff.manage'));
create policy org_memberships_update on togiva.organization_memberships for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'staff.manage'));
create policy region_memberships_select on togiva.region_memberships for select to togiva_app
  using (user_id = togiva.current_user_id() or togiva.has_org_permission(organization_id, 'staff.read'));
create policy region_memberships_insert on togiva.region_memberships for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'staff.manage'));
create policy region_memberships_update on togiva.region_memberships for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'staff.manage'));
create policy location_memberships_select on togiva.location_memberships for select to togiva_app
  using (user_id = togiva.current_user_id() or togiva.has_location_permission(location_id, 'staff.read'));
create policy location_memberships_insert on togiva.location_memberships for insert to togiva_app
  with check (togiva.has_location_permission(location_id, 'staff.manage'));
create policy location_memberships_update on togiva.location_memberships for update to togiva_app
  using (togiva.has_location_permission(location_id, 'staff.manage'))
  with check (togiva.has_location_permission(location_id, 'staff.manage'));

grant select on togiva.staff_invitations to togiva_app;
create policy staff_invitations_select on togiva.staff_invitations for select to togiva_app
  using (togiva.has_org_permission(organization_id, 'staff.manage')
         or (location_id is not null and togiva.has_location_permission(location_id, 'staff.manage')));

-- ---------------------------------------------------------------------------
-- Customers: a customer sees only their own rows. Staff see membership data
-- with customer.read_membership and contact details only with customer.read_pii.
-- ---------------------------------------------------------------------------
grant select, insert, update (first_name, last_name, birth_month, birth_day, locale) on togiva.customer_profiles to togiva_app;
create policy customer_profiles_self on togiva.customer_profiles for select to togiva_app
  using (user_id = togiva.current_user_id()
         or exists (select 1 from togiva.organization_customers oc where oc.customer_profile_id = id
                    and togiva.has_org_permission(oc.organization_id, 'customer.read_pii')));
create policy customer_profiles_insert_self on togiva.customer_profiles for insert to togiva_app
  with check (user_id = togiva.current_user_id());
create policy customer_profiles_update_self on togiva.customer_profiles for update to togiva_app
  using (user_id = togiva.current_user_id()) with check (user_id = togiva.current_user_id());

grant select on togiva.organization_customers to togiva_app;
create policy org_customers_select on togiva.organization_customers for select to togiva_app
  using (id in (select togiva.my_organization_customer_ids())
         or togiva.has_any_permission_in_org(organization_id, 'customer.read_membership'));

grant select, insert, update on togiva.customer_preferences, togiva.customer_location_preferences,
  togiva.customer_notification_preferences to togiva_app;
grant select, insert on togiva.customer_consents to togiva_app;
create policy customer_preferences_self on togiva.customer_preferences for all to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids()))
  with check (organization_customer_id in (select togiva.my_organization_customer_ids()));
create policy customer_location_prefs_self on togiva.customer_location_preferences for all to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids()))
  with check (organization_customer_id in (select togiva.my_organization_customer_ids()));
create policy customer_notification_prefs_self on togiva.customer_notification_preferences for all to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids()))
  with check (organization_customer_id in (select togiva.my_organization_customer_ids()));
create policy customer_consents_self_select on togiva.customer_consents for select to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids())
         or togiva.has_org_permission(organization_id, 'customer.read_pii'));
create policy customer_consents_self_insert on togiva.customer_consents for insert to togiva_app
  with check (organization_customer_id in (select togiva.my_organization_customer_ids()));

-- ---------------------------------------------------------------------------
-- Governance
-- ---------------------------------------------------------------------------
grant select on togiva.audit_logs, togiva.administrative_events, togiva.support_access_logs,
  togiva.data_export_logs, togiva.integration_errors to togiva_app;
create policy audit_logs_select on togiva.audit_logs for select to togiva_app
  using (organization_id is not null and togiva.has_org_permission(organization_id, 'audit.read'));
create policy administrative_events_select on togiva.administrative_events for select to togiva_app
  using (organization_id is not null and togiva.has_org_permission(organization_id, 'audit.read'));
create policy support_access_logs_select on togiva.support_access_logs for select to togiva_app
  using (togiva.has_org_permission(organization_id, 'audit.read'));
create policy data_export_logs_select on togiva.data_export_logs for select to togiva_app
  using (togiva.has_org_permission(organization_id, 'audit.read'));
create policy integration_errors_select on togiva.integration_errors for select to togiva_app
  using (organization_id is not null and (
    togiva.has_org_permission(organization_id, 'pos.read')
    or (location_id is not null and togiva.has_location_permission(location_id, 'pos.read'))));

grant select, insert, update on togiva.support_cases to togiva_app;
create policy support_cases_select on togiva.support_cases for select to togiva_app
  using (submitted_by = togiva.current_user_id()
         or togiva.has_org_permission(organization_id, 'support.resolve')
         or (location_id is not null and togiva.has_location_permission(location_id, 'support.submit')));
create policy support_cases_insert on togiva.support_cases for insert to togiva_app
  with check (submitted_by = togiva.current_user_id() and status = 'open' and (
    (location_id is not null and togiva.has_location_permission(location_id, 'support.submit'))
    or (location_id is null and togiva.has_any_permission_in_org(organization_id, 'support.submit'))));
create policy support_cases_update on togiva.support_cases for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'support.resolve'));

-- background_jobs, rate_limit_buckets: no togiva_app access (functions only).

-- ---------------------------------------------------------------------------
-- POS. Credentials columns are excluded from the app grant.
-- ---------------------------------------------------------------------------
grant select on togiva.pos_providers to togiva_app;
create policy pos_providers_select on togiva.pos_providers for select to togiva_app using (true);

grant select (id, organization_id, provider_code, environment, merchant_external_id, display_name, status, granted_scopes,
  connected_by, connected_at, last_sync_at, last_webhook_at, webhook_status, created_at, updated_at)
  on togiva.pos_connections to togiva_app;
create policy pos_connections_select on togiva.pos_connections for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'pos.read'));

grant select on togiva.pos_location_mappings, togiva.pos_sync_jobs, togiva.pos_reconciliation_runs,
  togiva.pos_integration_logs to togiva_app;
create policy pos_location_mappings_select on togiva.pos_location_mappings for select to togiva_app
  using (togiva.has_location_permission(location_id, 'pos.read'));
create policy pos_sync_jobs_select on togiva.pos_sync_jobs for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'pos.read'));
create policy pos_reconciliation_runs_select on togiva.pos_reconciliation_runs for select to togiva_app
  using (togiva.has_org_permission(organization_id, 'pos.read')
         or (location_id is not null and togiva.has_location_permission(location_id, 'pos.read')));
create policy pos_integration_logs_select on togiva.pos_integration_logs for select to togiva_app
  using (organization_id is not null and togiva.has_org_permission(organization_id, 'pos.read'));

grant select on togiva.pos_transactions, togiva.pos_transaction_items to togiva_app;
create policy pos_transactions_select on togiva.pos_transactions for select to togiva_app
  using (togiva.has_location_permission(location_id, 'transactions.read')
         or exists (select 1 from togiva.customer_transaction_associations a
                    where a.pos_transaction_id = id and a.status = 'confirmed'
                      and a.organization_customer_id in (select togiva.my_organization_customer_ids())));
create policy pos_transaction_items_select on togiva.pos_transaction_items for select to togiva_app
  using (exists (select 1 from togiva.pos_transactions t where t.id = pos_transaction_id));
-- pos_webhook_events, pos_customer_mappings: service only.

-- ---------------------------------------------------------------------------
-- Loyalty. Ledger, projections and redemptions are written only by the
-- loyalty service (togiva_service). Configuration drafts are editable by
-- loyalty.configure; publishing goes through the service.
-- ---------------------------------------------------------------------------
grant select, insert, update on togiva.loyalty_programs, togiva.loyalty_program_versions, togiva.loyalty_tiers,
  togiva.loyalty_earning_rules to togiva_app;
create policy loyalty_programs_select on togiva.loyalty_programs for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'loyalty.read')
         or (status = 'active' and togiva.is_org_customer(organization_id)));
create policy loyalty_programs_write on togiva.loyalty_programs for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'loyalty.configure') and status = 'draft');
create policy loyalty_programs_update on togiva.loyalty_programs for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'loyalty.configure'))
  with check (togiva.has_org_permission(organization_id, 'loyalty.configure'));
create policy lpv_select on togiva.loyalty_program_versions for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'loyalty.read')
         or (status = 'published' and togiva.is_org_customer(organization_id)));
create policy lpv_insert on togiva.loyalty_program_versions for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'loyalty.configure') and status = 'draft');
create policy lpv_update on togiva.loyalty_program_versions for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'loyalty.configure') and status = 'draft')
  with check (status = 'draft');
create policy loyalty_tiers_select on togiva.loyalty_tiers for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'loyalty.read') or togiva.is_org_customer(organization_id));
create policy loyalty_tiers_write on togiva.loyalty_tiers for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'loyalty.configure')
              and exists (select 1 from togiva.loyalty_program_versions v where v.id = program_version_id and v.status = 'draft'));
create policy loyalty_tiers_update on togiva.loyalty_tiers for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'loyalty.configure')
         and exists (select 1 from togiva.loyalty_program_versions v where v.id = program_version_id and v.status = 'draft'));
create policy earning_rules_select on togiva.loyalty_earning_rules for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'loyalty.read'));
create policy earning_rules_write on togiva.loyalty_earning_rules for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'loyalty.configure')
              and exists (select 1 from togiva.loyalty_program_versions v where v.id = program_version_id and v.status = 'draft'));
create policy earning_rules_update on togiva.loyalty_earning_rules for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'loyalty.configure')
         and exists (select 1 from togiva.loyalty_program_versions v where v.id = program_version_id and v.status = 'draft'));

grant select on togiva.loyalty_accounts, togiva.loyalty_ledger, togiva.loyalty_balance_projections,
  togiva.loyalty_qualification_progress, togiva.reward_redemptions to togiva_app;
create policy loyalty_accounts_select on togiva.loyalty_accounts for select to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids())
         or togiva.has_any_permission_in_org(organization_id, 'customer.read_membership'));
create policy loyalty_ledger_select on togiva.loyalty_ledger for select to togiva_app
  using (exists (select 1 from togiva.loyalty_accounts a where a.id = loyalty_account_id));
create policy balance_projection_select on togiva.loyalty_balance_projections for select to togiva_app
  using (exists (select 1 from togiva.loyalty_accounts a where a.id = loyalty_account_id));
create policy qualification_progress_select on togiva.loyalty_qualification_progress for select to togiva_app
  using (exists (select 1 from togiva.loyalty_accounts a where a.id = loyalty_account_id));
create policy reward_redemptions_select on togiva.reward_redemptions for select to togiva_app
  using (exists (select 1 from togiva.loyalty_accounts a where a.id = loyalty_account_id
                 and a.organization_customer_id in (select togiva.my_organization_customer_ids()))
         or togiva.has_location_permission(location_id, 'rewards.redeem.verify')
         or togiva.has_org_permission(organization_id, 'customer.read_membership'));

grant select, insert, update on togiva.rewards, togiva.reward_location_eligibility, togiva.reward_inventory to togiva_app;
create policy rewards_select on togiva.rewards for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'rewards.read')
         or (status = 'active' and not is_surprise and togiva.is_org_customer(organization_id)));
create policy rewards_insert on togiva.rewards for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'rewards.manage'));
create policy rewards_update on togiva.rewards for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'rewards.manage'));
create policy reward_eligibility_select on togiva.reward_location_eligibility for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'rewards.read') or togiva.is_org_customer(organization_id));
create policy reward_eligibility_write on togiva.reward_location_eligibility for all to togiva_app
  using (togiva.has_org_permission(organization_id, 'rewards.manage'))
  with check (togiva.has_org_permission(organization_id, 'rewards.manage'));
create policy reward_inventory_select on togiva.reward_inventory for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'rewards.read'));
create policy reward_inventory_write on togiva.reward_inventory for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'rewards.manage'));
create policy reward_inventory_update on togiva.reward_inventory for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'rewards.manage'));

grant select, insert on togiva.loyalty_adjustment_requests to togiva_app;
create policy adjustment_requests_select on togiva.loyalty_adjustment_requests for select to togiva_app
  using (requested_by = togiva.current_user_id() or togiva.has_org_permission(organization_id, 'loyalty.adjust.approve'));
create policy adjustment_requests_insert on togiva.loyalty_adjustment_requests for insert to togiva_app
  with check (requested_by = togiva.current_user_id() and status = 'pending' and (
    togiva.has_org_permission(organization_id, 'loyalty.adjust.request')
    or (location_id is not null and togiva.has_location_permission(location_id, 'loyalty.adjust.request'))));

-- ---------------------------------------------------------------------------
-- Connection codes. Defense in depth: the service runs these as togiva_app,
-- and a transition guard rejects any state change a caller is not entitled to.
-- ---------------------------------------------------------------------------
grant select, insert, update on togiva.customer_connection_codes to togiva_app;
create policy connection_codes_customer_select on togiva.customer_connection_codes for select to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids()));
create policy connection_codes_staff_select on togiva.customer_connection_codes for select to togiva_app
  using (togiva.has_location_permission(location_id, 'customer.identify'));
create policy connection_codes_customer_insert on togiva.customer_connection_codes for insert to togiva_app
  with check (status = 'active'
              and organization_customer_id in (select togiva.my_organization_customer_ids())
              and togiva.is_org_customer(organization_id)
              and exists (select 1 from togiva.locations l where l.id = location_id and l.organization_id = organization_id
                          and l.status = 'active' and l.loyalty_participating));
create policy connection_codes_customer_update on togiva.customer_connection_codes for update to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids()));
create policy connection_codes_staff_update on togiva.customer_connection_codes for update to togiva_app
  using (togiva.has_location_permission(location_id, 'customer.identify'))
  with check (togiva.has_location_permission(location_id, 'customer.identify'));

create or replace function togiva.guard_connection_code_transition() returns trigger
language plpgsql as $$
declare
  v_me uuid := togiva.current_user_id();
  v_is_owner boolean;
begin
  if current_user <> 'togiva_app' then
    return new; -- trusted service / sweeper
  end if;
  if new.code_hash <> old.code_hash or new.organization_id <> old.organization_id or new.location_id <> old.location_id
     or new.organization_customer_id <> old.organization_customer_id or new.created_at <> old.created_at
     or new.expires_at <> old.expires_at or new.key_version <> old.key_version then
    raise exception 'connection code identity fields are immutable' using errcode = '42501';
  end if;
  if new.status = old.status then
    if new.status = 'reserved' and new.reservation_idempotency_key is not distinct from old.reservation_idempotency_key
       and new.reserved_by_user_id = old.reserved_by_user_id then
      return new;
    end if;
    raise exception 'connection code status unchanged' using errcode = '42501';
  end if;
  v_is_owner := old.organization_customer_id in (select togiva.my_organization_customer_ids());

  if old.status = 'active' and new.status = 'revoked' and v_is_owner then
    return new;
  elsif old.status = 'active' and new.status = 'reserved' and new.reserved_by_user_id = v_me
        and old.expires_at > now() and togiva.has_location_permission(old.location_id, 'customer.identify') then
    return new;
  elsif old.status = 'reserved' and new.status = 'active' and old.reserved_by_user_id = v_me then
    return new;
  elsif old.status = 'reserved' and new.status = 'consumed' and old.reserved_by_user_id = v_me
        and togiva.has_location_permission(old.location_id, 'connection.associate') then
    return new;
  end if;
  raise exception 'connection code transition % -> % not permitted', old.status, new.status using errcode = '42501';
end $$;
create trigger customer_connection_codes_transition before update on togiva.customer_connection_codes
  for each row execute function togiva.guard_connection_code_transition();

grant select, insert on togiva.customer_transaction_associations to togiva_app;
create policy associations_select on togiva.customer_transaction_associations for select to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids())
         or togiva.has_location_permission(location_id, 'connection.associate')
         or togiva.has_location_permission(location_id, 'transactions.read'));
create policy associations_insert on togiva.customer_transaction_associations for insert to togiva_app
  with check (associated_by_user_id = togiva.current_user_id()
              and status = 'pending_pos_confirmation'
              and togiva.has_location_permission(location_id, 'connection.associate'));

grant select, insert on togiva.customer_connection_events to togiva_app;
grant usage on all sequences in schema togiva to togiva_app;
create policy connection_events_select on togiva.customer_connection_events for select to togiva_app
  using (actor_user_id = togiva.current_user_id() or togiva.has_org_permission(organization_id, 'audit.read'));
create policy connection_events_insert on togiva.customer_connection_events for insert to togiva_app
  with check (actor_user_id = togiva.current_user_id());

-- ---------------------------------------------------------------------------
-- Campaigns and offers
-- ---------------------------------------------------------------------------
grant select, insert, update on togiva.campaigns, togiva.campaign_locations, togiva.campaign_segments,
  togiva.campaign_eligibility_rules to togiva_app;
create policy campaigns_select on togiva.campaigns for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'campaigns.read'));
create policy campaigns_insert on togiva.campaigns for insert to togiva_app
  with check (togiva.has_org_permission(organization_id, 'campaigns.manage') and status = 'draft');
create policy campaigns_update on togiva.campaigns for update to togiva_app
  using (togiva.has_org_permission(organization_id, 'campaigns.manage'));
create policy campaign_locations_all on togiva.campaign_locations for all to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'campaigns.read'))
  with check (togiva.has_org_permission(organization_id, 'campaigns.manage'));
create policy campaign_segments_all on togiva.campaign_segments for all to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'campaigns.read'))
  with check (togiva.has_org_permission(organization_id, 'campaigns.manage'));
create policy campaign_rules_all on togiva.campaign_eligibility_rules for all to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'campaigns.read'))
  with check (togiva.has_org_permission(organization_id, 'campaigns.manage'));

grant select on togiva.customer_offers, togiva.offer_redemptions, togiva.campaign_events to togiva_app;
create policy customer_offers_select on togiva.customer_offers for select to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids())
         or togiva.has_org_permission(organization_id, 'campaigns.read'));
create policy offer_redemptions_select on togiva.offer_redemptions for select to togiva_app
  using (exists (select 1 from togiva.customer_offers o where o.id = customer_offer_id));
create policy campaign_events_select on togiva.campaign_events for select to togiva_app
  using (togiva.has_org_permission(organization_id, 'campaigns.read'));

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
grant select, update (read_at) on togiva.notifications to togiva_app;
create policy notifications_own on togiva.notifications for select to togiva_app
  using (recipient_user_id = togiva.current_user_id());
create policy notifications_mark_read on togiva.notifications for update to togiva_app
  using (recipient_user_id = togiva.current_user_id());
grant select, insert, update on togiva.notification_preferences, togiva.push_subscriptions to togiva_app;
create policy notification_preferences_own on togiva.notification_preferences for all to togiva_app
  using (user_id = togiva.current_user_id()) with check (user_id = togiva.current_user_id());
create policy push_subscriptions_own on togiva.push_subscriptions for all to togiva_app
  using (user_id = togiva.current_user_id()) with check (user_id = togiva.current_user_id());
grant select on togiva.notification_templates to togiva_app;
create policy notification_templates_select on togiva.notification_templates for select to togiva_app
  using (organization_id is null or togiva.has_org_permission(organization_id, 'organization.read'));

-- ---------------------------------------------------------------------------
-- Analytics (read-only for the app)
-- ---------------------------------------------------------------------------
grant select on togiva.location_daily_metrics, togiva.regional_daily_metrics, togiva.network_daily_metrics,
  togiva.customer_activity_aggregates, togiva.campaign_performance_aggregates, togiva.reward_performance_aggregates to togiva_app;
create policy location_metrics_select on togiva.location_daily_metrics for select to togiva_app
  using (togiva.has_location_permission(location_id, 'analytics.location.read'));
create policy regional_metrics_select on togiva.regional_daily_metrics for select to togiva_app
  using (togiva.has_region_permission(region_id, 'analytics.location.read'));
create policy network_metrics_select on togiva.network_daily_metrics for select to togiva_app
  using (togiva.has_org_permission(organization_id, 'analytics.network.read'));
create policy customer_activity_select on togiva.customer_activity_aggregates for select to togiva_app
  using (organization_customer_id in (select togiva.my_organization_customer_ids())
         or togiva.has_org_permission(organization_id, 'customer.read_membership'));
create policy campaign_perf_select on togiva.campaign_performance_aggregates for select to togiva_app
  using (togiva.has_org_permission(organization_id, 'campaigns.read'));
create policy reward_perf_select on togiva.reward_performance_aggregates for select to togiva_app
  using (togiva.has_any_permission_in_org(organization_id, 'rewards.read'));
