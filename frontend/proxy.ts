import { NextResponse, type NextRequest } from "next/server";

/// Optimistic check only: no session cookie → /login. The backend still
/// validates every request, and a 401 from it sends the user to /login too.
export function proxy(req: NextRequest) {
  if (!req.cookies.has("tb_session")) {
    const url = new URL("/login", req.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/qr", "/yield", "/send", "/withdraw", "/history"],
};
