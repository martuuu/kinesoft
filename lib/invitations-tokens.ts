import "server-only";
import { createHash } from "node:crypto";

/**
 * Invitation tokens are stored HASHED (never in cleartext) — the raw token
 * only ever lives in the emailed URL. A DB leak then can't be used to accept
 * invitations. Lookups hash the incoming URL token and match on the digest.
 * SHA-256 is sufficient: the token is a 24-byte random value, so there is no
 * low-entropy space to brute-force.
 *
 * Lives in its own module (not the `"use server"` invitations.ts, which may
 * only export async functions) so both the actions and the accept route can
 * share it.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
