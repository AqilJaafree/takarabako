import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

type Context = { params: Promise<{ net: string; path: string[] }> };

/// Relays the self-custody flow to the backend's /self/:net/* routes, for any network it offers
/// (it answers for a network it doesn't know). Only these paths are relayed, so this can't be used
/// to reach other backend routes with the customer's session.
const GET_PATHS = /^(wallet|market|positions|dashout)$/;
const POST_PATHS = /^(preview|prepare|record|dashout\/prepare|positions\/[\w-]+\/close\/(prepare|record))$/;
const NETWORK = /^[a-z][a-z-]*$/;

const notFound = () => NextResponse.json({ error: "unknown self-custody route" }, { status: 404 });

/// GET /api/self/:net/{wallet,market,positions,dashout}, with its query string.
export async function GET(req: NextRequest, { params }: Context) {
  const { net, path } = await params;
  const route = path.join("/");
  if (!NETWORK.test(net) || !GET_PATHS.test(route)) return notFound();
  return relay("web", `/self/${net}/${route}${req.nextUrl.search}`);
}

/// POST /api/self/:net/{preview,prepare,record,dashout/prepare,positions/:id/close/*}.
export async function POST(req: NextRequest, { params }: Context) {
  const { net, path } = await params;
  const route = path.join("/");
  if (!NETWORK.test(net) || !POST_PATHS.test(route)) return notFound();
  return relay("web", `/self/${net}/${route}`, { body: await req.json().catch(() => ({})) });
}
