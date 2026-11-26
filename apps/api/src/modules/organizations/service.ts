import type { Database } from "@togiva/database";
import type { LocationSummary, OrganizationSummary } from "@togiva/shared-types";
import { AppError } from "../../errors.js";

const locationSql = `select l.id, l.organization_id as "organizationId", l.store_code as "storeCode", l.name, l.status,
  l.loyalty_participating as "loyaltyParticipating", l.timezone,
  json_build_object('line1', l.address_line1, 'line2', l.address_line2, 'city', l.city, 'regionCode', l.region_code,
                    'postalCode', l.postal_code, 'countryCode', l.country_code) as address,
  l.latitude::float8 as latitude, l.longitude::float8 as longitude, l.phone
  from togiva.locations l`;

/** RLS decides visibility: staff see permitted locations, everyone else sees active participating ones. */
export async function listLocations(db: Database, ctx: { userId: string | null; requestId: string }, organizationId: string, page: { cursor?: string; limit: number }) {
  return db.asUser(ctx, async (tx) => {
    const r = await tx.query<LocationSummary>(
      `${locationSql} where l.organization_id = $1 and ($2::text is null or l.name || l.id::text > $2) order by l.name || l.id::text limit $3`,
      [organizationId, page.cursor ? Buffer.from(page.cursor, "base64url").toString() : null, page.limit + 1],
    );
    const items = r.rows.slice(0, page.limit);
    const last = items.at(-1);
    return { items, nextCursor: r.rows.length > page.limit && last ? Buffer.from(last.name + last.id).toString("base64url") : null };
  });
}

export async function getLocation(db: Database, ctx: { userId: string | null; requestId: string }, organizationId: string, locationId: string) {
  return db.asUser(ctx, async (tx) => {
    const r = await tx.query<LocationSummary>(`${locationSql} where l.organization_id = $1 and l.id = $2`, [organizationId, locationId]);
    if (!r.rows[0]) throw new AppError("not_found", "Location not found");
    return r.rows[0];
  });
}

/**
 * Public lookup used by client applications to turn their configured
 * organization slug into an id before sign-in. Only active organizations are
 * resolvable, and only the public summary fields are returned. Runs as the
 * service role because anonymous callers have no RLS grant on organizations.
 */
export async function getOrganizationBySlug(db: Database, ctx: { userId: string | null; requestId: string }, slug: string) {
  return db.asService(ctx, async (tx) => {
    const r = await tx.query<OrganizationSummary>(
      `select id, slug, name, status, default_currency as "defaultCurrency", default_timezone as "defaultTimezone"
       from togiva.organizations where slug = $1 and status = 'active'`,
      [slug],
    );
    if (!r.rows[0]) throw new AppError("not_found", "Organization not found");
    return r.rows[0];
  });
}
