import { NextResponse, type NextRequest } from "next/server";
import { LOCK_COOKIE, tokenValid } from "@/lib/lock";

/**
 * The tool pages need the studio PIN. Without a valid unlock cookie the
 * request goes to /unlock, which sends the visitor back here afterwards.
 */
export function proxy(request: NextRequest) {
  if (tokenValid(request.cookies.get(LOCK_COOKIE)?.value)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/edit", "/icons", "/lab"],
};
