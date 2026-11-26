import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Verified identity extracted from an access token. */
export interface Identity {
  userId: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Provider-neutral token verification. Supabase Auth is the initial identity
 * provider (registration, login, email verification, password recovery and
 * session refresh happen against it), but TOGIVA Core only depends on this
 * interface: any OIDC/JWT provider whose `sub` is a UUID works.
 */
export interface IdentityVerifier {
  verify(token: string): Promise<Identity>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class JwtIdentityVerifier implements IdentityVerifier {
  private readonly key: Uint8Array | ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: { jwtSecret?: string; jwksUrl?: string; issuer?: string; audience: string }) {
    if (opts.jwksUrl) this.key = createRemoteJWKSet(new URL(opts.jwksUrl));
    else if (opts.jwtSecret) this.key = new TextEncoder().encode(opts.jwtSecret);
    else throw new Error("JwtIdentityVerifier needs jwtSecret or jwksUrl");
  }

  async verify(token: string): Promise<Identity> {
    const { payload } = await jwtVerify(token, this.key as Uint8Array, {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      algorithms: this.opts.jwksUrl ? ["RS256", "ES256"] : ["HS256"],
    });
    return toIdentity(payload);
  }
}

export function toIdentity(payload: JWTPayload): Identity {
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) throw new Error("token subject must be a UUID");
  const meta = (payload as { user_metadata?: Record<string, unknown> }).user_metadata ?? {};
  const email = typeof payload.email === "string" ? payload.email : null;
  // Supabase sets user_metadata.email_verified; generic OIDC uses email_verified.
  const emailVerified = payload.email_verified === true || meta.email_verified === true;
  return { userId: payload.sub.toLowerCase(), email, emailVerified };
}
