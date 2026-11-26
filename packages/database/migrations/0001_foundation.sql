-- 0001_foundation: schema, runtime roles, request context and shared trigger helpers.
--
-- All TOGIVA tables live in the `togiva` schema, never `public`, so a Supabase
-- PostgREST deployment does not expose them to browsers by default.
--
-- Runtime roles (cluster-level, created if missing):
--   togiva_app     API request role. Subject to row-level security. The API sets
--                  request context (user, organization) per transaction.
--   togiva_service Trusted domain services and background jobs. BYPASSRLS, used
--                  only after the API has authorized the caller in code, and by workers.
-- Both are NOLOGIN; the deploying login role is granted membership and switches
-- with SET ROLE (see packages/database/src/client.ts).

create schema if not exists togiva;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'togiva_app') then
    create role togiva_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'togiva_service') then
    create role togiva_service nologin bypassrls;
  end if;
end $$;

grant usage on schema togiva to togiva_app, togiva_service;

-- ---------------------------------------------------------------------------
-- Request context. The API calls togiva.set_request_context() at the start of
-- every transaction. On Supabase, the JWT `sub` claim is used as a fallback so
-- the same policies work if a table is ever read through PostgREST.
-- ---------------------------------------------------------------------------
create or replace function togiva.current_user_id() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('togiva.user_id', true), '')::uuid,
    nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
  )
$$;

create or replace function togiva.current_request_id() returns text
language sql stable as $$
  select nullif(current_setting('togiva.request_id', true), '')
$$;

create or replace function togiva.set_request_context(p_user_id uuid, p_request_id text default null)
returns void language sql as $$
  select set_config('togiva.user_id', coalesce(p_user_id::text, ''), true),
         set_config('togiva.request_id', coalesce(p_request_id, ''), true);
$$;

-- updated_at maintenance
create or replace function togiva.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Append-only guard for ledgers, audit logs and event stores. Corrections are
-- made with compensating rows, never by UPDATE or DELETE.
create or replace function togiva.prevent_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'table %.% is append-only (% rejected)', tg_table_schema, tg_table_name, tg_op
    using errcode = 'P0001';
end $$;
