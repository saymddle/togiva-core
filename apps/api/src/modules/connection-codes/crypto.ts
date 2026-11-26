import { createHash, createHmac, randomInt } from "node:crypto";

/** Uniform, cryptographically secure four-digit code, leading zeros kept. */
export function generateCode(): string {
  return randomInt(0, 10_000).toString().padStart(4, "0");
}

/**
 * Keyed lookup hash. The organization and location are bound into the MAC so
 * a code only matches at the location it was issued for, and the 10,000-value
 * code space cannot be reversed from the database without the server key.
 */
export function codeHash(key: Buffer, organizationId: string, locationId: string, code: string): Buffer {
  return createHmac("sha256", key).update(`togiva.connection-code.v1|${organizationId}|${locationId}|${code}`).digest();
}

export class ConnectionCodeHasher {
  constructor(private readonly keys: Map<number, Buffer>, readonly activeVersion: number) {
    if (!keys.has(activeVersion)) throw new Error("active key version missing");
  }
  /** Redemption tokens share the server keys, domain-separated by their MAC prefix. */
  redemptionTokens(): RedemptionTokens {
    return new RedemptionTokens(this.keys, this.activeVersion);
  }
  /** Hash with the active key, for issuing. */
  issue(organizationId: string, locationId: string, code: string): { hash: Buffer; keyVersion: number } {
    return { hash: codeHash(this.keys.get(this.activeVersion)!, organizationId, locationId, code), keyVersion: this.activeVersion };
  }
  /** Hashes under every configured key, so lookups keep working during key rotation. */
  candidates(organizationId: string, locationId: string, code: string): Buffer[] {
    return [...this.keys.values()].map((k) => codeHash(k, organizationId, locationId, code));
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Uppercases and strips separators so "abcd-efgh …" and "ABCDEFGH…" match. */
export function normalizeToken(token: string): string {
  return token.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/**
 * Derives a high-entropy (80-bit) redemption token from a server key and the
 * redemption id. Deterministic, so the token can be shown again to its owner
 * (and returned on an idempotent retry) without ever being stored: only its
 * SHA-256 is persisted. Shown as four groups of four Crockford base32 chars.
 */
export function deriveRedemptionToken(key: Buffer, redemptionId: string): string {
  const mac = createHmac("sha256", key).update(`togiva.redemption-token.v1|${redemptionId}`).digest();
  let bits = 0n;
  for (const b of mac.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) out = CROCKFORD[Number(bits & 31n)]! + out, bits >>= 5n;
  return out.match(/.{4}/g)!.join("-");
}

export const tokenHash = (token: string): Buffer => createHash("sha256").update(normalizeToken(token)).digest();

export class RedemptionTokens {
  constructor(private readonly keys: Map<number, Buffer>, private readonly activeVersion: number) {}
  issue(redemptionId: string): { token: string; hash: Buffer } {
    const token = deriveRedemptionToken(this.keys.get(this.activeVersion)!, redemptionId);
    return { token, hash: tokenHash(token) };
  }
  /** Re-derives the token for display, trying every key so rotation does not lose it. */
  reveal(redemptionId: string, storedHash: Buffer): string | null {
    for (const key of this.keys.values()) {
      const t = deriveRedemptionToken(key, redemptionId);
      if (tokenHash(t).equals(storedHash)) return t;
    }
    return null;
  }
}
