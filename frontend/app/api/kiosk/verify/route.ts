import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";
import { kioskLoginResponse } from "@/lib/kiosk";

/// POST /api/kiosk/verify { email } — kiosk email login (full access), as on
/// the original kiosk page: the person is standing at the box.
export async function POST(req: NextRequest) {
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  if (!email) return NextResponse.json({ error: "Enter an email first" }, { status: 400 });
  try {
    return await kioskLoginResponse(req, await backendFetch("/verify", { body: { email } }));
  } catch (err) {
    return errorResponse(err);
  }
}
