// Server code only (proxy, route handlers, server components): it reads the PIN.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The studio lock: a 4-digit PIN guards the tool pages (/edit, /icons).
 *
 * The PIN lives only on the server (env STUDIO_PIN). Entering it sets a
 * signed, httpOnly cookie; the proxy checks the cookie before any tool page
 * is served. Changing the PIN signs everyone out, since the PIN is part of
 * the signing key. STUDIO_SECRET (optional, any long random string) makes
 * the cookie impossible to forge even for someone who knows the PIN format.
 */

export const LOCK_COOKIE = "studio_unlock";
/** How long a device stays unlocked. */
export const LOCK_MAX_AGE = 60 * 60 * 24 * 30;

/** The pages behind the lock, and where to go after unlocking. */
export const LOCKED_PATHS = ["/edit", "/icons", "/lab"];

export function configuredPin(): string | null {
  const pin = (process.env.STUDIO_PIN ?? "").trim();
  return /^\d{4}$/.test(pin) ? pin : null;
}

function key(pin: string): Buffer {
  return createHash("sha256").update(`svga-studio|${process.env.STUDIO_SECRET ?? ""}|${pin}`).digest();
}

const sign = (pin: string, payload: string) => createHmac("sha256", key(pin)).update(payload).digest("base64url");

/** Constant-time PIN check (no early exit that would leak how many digits matched). */
export function pinMatches(attempt: string): boolean {
  const pin = configuredPin();
  if (!pin || !/^\d{4}$/.test(attempt)) return false;
  return timingSafeEqual(Buffer.from(sign(pin, attempt)), Buffer.from(sign(pin, pin)));
}

/** A cookie value that proves the PIN was entered, valid until `expires` (ms). */
export function makeToken(expires: number): string {
  const pin = configuredPin();
  if (!pin) throw new Error("STUDIO_PIN is not set");
  const payload = `v1.${expires}`;
  return `${payload}.${sign(pin, payload)}`;
}

export function tokenValid(token: string | undefined | null): boolean {
  const pin = configuredPin();
  if (!pin || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const want = Buffer.from(sign(pin, `${parts[0]}.${parts[1]}`));
  const got = Buffer.from(parts[2]);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Only our own tool pages are valid places to return to (no open redirect). */
export function safeNext(next: string | null | undefined): string {
  const path = (next ?? "").split("?")[0];
  return LOCKED_PATHS.includes(path) ? path : "/edit";
}
