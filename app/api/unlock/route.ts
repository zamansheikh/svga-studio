import { NextResponse, type NextRequest } from "next/server";
import { configuredPin, LOCK_COOKIE, LOCK_MAX_AGE, makeToken, pinMatches } from "@/lib/lock";

/**
 * POST { pin } → sets the unlock cookie when the PIN is right.
 *
 * A 4-digit PIN has only 10,000 values, so guessing is slowed down: every
 * wrong answer waits, and after 5 wrong answers from one address that
 * address waits a minute (doubling on each further lockout). The counts live
 * in this server instance's memory.
 */
const MAX_TRIES = 5;
const tries = new Map<string, { fails: number; until: number; lockouts: number }>();

function clientId(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}

export async function POST(req: NextRequest) {
  if (!configuredPin()) {
    return NextResponse.json({ ok: false, error: "This studio has no PIN set up yet (STUDIO_PIN)." }, { status: 503 });
  }
  const id = clientId(req);
  const now = Date.now();
  const t = tries.get(id) ?? { fails: 0, until: 0, lockouts: 0 };
  if (t.until > now) {
    return NextResponse.json({ ok: false, error: "Too many wrong PINs.", retryAfter: Math.ceil((t.until - now) / 1000) }, { status: 429 });
  }

  let pin = "";
  try {
    const body = (await req.json()) as { pin?: unknown };
    pin = typeof body.pin === "string" ? body.pin : "";
  } catch {
    /* empty or malformed body: a wrong PIN */
  }

  if (!pinMatches(pin)) {
    await new Promise((r) => setTimeout(r, 600));
    t.fails++;
    let retryAfter = 0;
    if (t.fails >= MAX_TRIES) {
      t.lockouts++;
      retryAfter = 60 * 2 ** Math.min(6, t.lockouts - 1);
      t.until = now + retryAfter * 1000;
      t.fails = 0;
    }
    tries.set(id, t);
    if (tries.size > 5000) tries.clear();
    return NextResponse.json(
      { ok: false, error: retryAfter ? "Too many wrong PINs." : "Wrong PIN.", left: retryAfter ? 0 : MAX_TRIES - t.fails, retryAfter },
      { status: retryAfter ? 429 : 401 },
    );
  }

  tries.delete(id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(LOCK_COOKIE, makeToken(now + LOCK_MAX_AGE * 1000), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: LOCK_MAX_AGE,
  });
  return res;
}
