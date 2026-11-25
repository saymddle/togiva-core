-- DEVELOPMENT FIXTURES ONLY. Not business data. Loaded by `pnpm db:seed:dev`,
-- which refuses to run with NODE_ENV=production. Every value is synthetic.
-- Users here have no credentials; create matching identities in your local
-- Supabase Auth (or mint dev tokens) with the same UUIDs.

begin;

insert into togiva.organizations (id, slug, name, status) values
  ('00000000-0000-4000-8000-000000000001', 'fixture-brand', 'Fixture Brand (development)', 'active')
on conflict (id) do nothing;
insert into togiva.organization_settings (organization_id) values ('00000000-0000-4000-8000-000000000001') on conflict do nothing;

insert into togiva.locations (id, organization_id, store_code, name, status, loyalty_participating, timezone, city, region_code, country_code) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'DEV-001', 'Fixture Store 1', 'active', true, 'America/Chicago', 'Devtown', 'TX', 'US'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 'DEV-002', 'Fixture Store 2', 'active', true, 'America/Chicago', 'Devtown', 'TX', 'US')
on conflict (id) do nothing;

insert into togiva.user_profiles (id, email, first_name, email_verified_at) values
  ('00000000-0000-4000-8000-00000000a001', 'corporate.admin@fixture.invalid', 'Corp', now()),
  ('00000000-0000-4000-8000-00000000a002', 'cashier.one@fixture.invalid', 'Cashier', now()),
  ('00000000-0000-4000-8000-00000000a003', 'member.one@fixture.invalid', 'Member', now())
on conflict (id) do nothing;

insert into togiva.organization_memberships (organization_id, user_id, role_id)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001', id from togiva.role_definitions where key = 'corporate_admin' and organization_id is null
on conflict do nothing;
insert into togiva.organization_memberships (organization_id, user_id) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a002') on conflict do nothing;
insert into togiva.location_memberships (organization_id, location_id, user_id, role_id)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-00000000a002', id
from togiva.role_definitions where key = 'store_employee' and organization_id is null
and not exists (select 1 from togiva.location_memberships where user_id = '00000000-0000-4000-8000-00000000a002');

insert into togiva.customer_profiles (id, user_id, first_name) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a003', 'Member') on conflict do nothing;
insert into togiva.organization_customers (organization_id, customer_profile_id, membership_number) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000c001', '9000000001') on conflict do nothing;

insert into togiva.pos_connections (id, organization_id, provider_code, environment, merchant_external_id, display_name, status) values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000001', 'fixture', 'fixture', 'fixture-merchant-1', 'Fixture POS', 'active')
on conflict (id) do nothing;

commit;
