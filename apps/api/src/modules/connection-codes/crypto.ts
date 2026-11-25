import { createHmac, randomInt } from "node:crypto";

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
  /** Hash with the active key, for issuing. */
  issue(organizationId: string, locationId: string, code: string): { hash: Buffer; keyVersion: number } {
    return { hash: codeHash(this.keys.get(this.activeVersion)!, organizationId, locationId, code), keyVersion: this.activeVersion };
  }
  /** Hashes under every configured key, so lookups keep working during key rotation. */
  candidates(organizationId: string, locationId: string, code: string): Buffer[] {
    return [...this.keys.values()].map((k) => codeHash(k, organizationId, locationId, code));
  }
}
