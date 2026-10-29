import { NextResponse } from "next/server";
import { LOCK_COOKIE } from "@/lib/lock";

/** POST → forget the unlock on this device. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(LOCK_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return res;
}
