# Security, permissions and tenant isolation

## Database roles

| Role | Used by | RLS | Notes |
| --- | --- | --- | --- |
| `togiva_app` | API request handlers | Enforced | Only the grants in `0009_row_level_security.sql`. Cannot write ledgers, POS data, jobs; cannot read POS credentials. |
| `togiva_service` | Trusted services after in-code authorization; workers | Bypassed | Never used directly on unauthenticated input. |
| migration owner | `pnpm db:migrate` | Owner | Owns tables and SECURITY DEFINER functions. |

Both runtime roles are `NOLOGIN`; the API's login role is granted both and uses `SET LOCAL ROLE` per transaction (`packages/database/src/client.ts`). Request context is set with `togiva.set_request_context(user_id, request_id)` and read by `togiva.current_user_id()` (falls back to Supabase's `request.jwt.claims.sub`).

## Actors and roles

| Brief role | How it is modelled | Scope |
| --- | --- | --- |
| Platform Super Administrator | `platform_admins` row | Platform. Sees organizations; **no** customer PII by default. Support access must be logged in `support_access_logs`. |
| Corporate Administrator | `organization_memberships.role_id` = `corporate_admin` | Whole organization |
| Corporate Analyst | `corporate_analyst` | Whole organization, read-only reporting |
| Regional Manager | `region_memberships` with `regional_manager` | Locations currently in the region (and one level of child regions) |
| Franchise Owner | `franchise_owner_members` + `franchise_role_assignments` (`franchise_owner`) | Locations the owner entity currently owns (`franchise_location_ownerships`, date-bounded, history kept) |
| General Manager | `location_memberships` with `general_manager` | Assigned locations |
| Store Employee | `location_memberships` with `store_employee` | Assigned locations |
| Customer | `organization_customers` | Own membership only |

Every staff path also requires an active `organization_memberships` row in an active organization and an active `user_profiles` row. Suspending the org membership removes all access at once.

Role templates and the permission catalogue are seeded in `0002`. The authoritative mapping is in that migration; `@togiva/shared-types` mirrors the codes and a test fails if they drift. Organizations can add custom roles (`role_definitions.organization_id` set).

## Permission resolution (single implementation)

- `togiva.permitted_location_ids(permission)` → every `(organization_id, location_id)` where the caller holds the permission via organization role, region role, franchise ownership, or location role.
- `togiva.has_location_permission(location, permission)`, `has_org_permission(org, permission)`, `has_any_permission_in_org`, `has_region_permission`, `is_org_customer`, `my_organization_customer_ids()`.
- RLS policies and the API route layer (`apps/api/src/http/register.ts`) both call these. Handlers do not hand-roll role checks.

## Privilege escalation guards

- Location roles can be granted by org-level `staff.manage` holders, or by location managers (`staff.manage` at that location) only for roles flagged `assignable_by_location_managers` (GM, store employee). Enforced by RLS plus trigger `location_memberships_grant_guard`.
- Organization and region memberships are writable only with organization-level `staff.manage`, so franchise owners cannot create corporate or regional access.
- Adjustment approval cannot be done by the requester (`check (reviewed_by <> requested_by)`).

## Tenant isolation

- `organization_id` on every tenant row; composite FKs `(organization_id, x_id) → parent(organization_id, id)` make cross-tenant references impossible at the schema level.
- RLS enabled on all 76 tables (a test asserts this). No policy means no access.
- Customer identity is global but everything else (membership, consents, balances, history, codes) is per organization.
- Tested in `packages/database/test/tenancy-and-rls.test.ts`: cross-org visibility, platform admin without PII, regional scoping, franchise ownership start/end, employee scoping, suspended members, escalation attempts, append-only ledgers, credential column protection.

## Connection codes

See `CONNECTION_CODES.md`. HMAC lookup hashes with versioned server keys, location-bound, atomic reservation, per-employee and per-location lockouts, minimal disclosure via `connection_code_customer_summary`, DB-level state-transition guard.

## Other controls

- Input validation: every route parses params/query/body with its zod contract; malformed input never reaches SQL.
- Rate limiting: `togiva.rate_limit_hit` fixed windows (code issuing); lookup lockouts from failure events. Add edge rate limiting (CDN/WAF) in front of the API for volumetric protection.
- Secrets: JWT secret / JWKS, HMAC keys, POS credential encryption key come from the environment / secret store. `.env` is git-ignored. Logs redact the `authorization` header; connection codes are never logged or stored.
- Audit: `togiva.write_audit()` stamps actor and request id from context; `audit_logs` is append-only. Connection activity has its own append-only `customer_connection_events`.
- Retention: `organization_settings.retention_*` columns; purge jobs are Phase 8.
- Credentials: `pos_connections.*_ciphertext` columns are excluded from the request role's column grant.

## Known gaps (tracked in IMPLEMENTATION_STATUS.md)

- Support-access workflow for platform admins (grant, time-box, log) is schema only.
- Credential encryption helper and key rotation for POS secrets not written yet (Phase 7).
- Data retention purge jobs not written yet (Phase 8).
