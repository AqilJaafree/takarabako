import "server-only";
import { redirect } from "next/navigation";
import { BackendError, backendFetch, sessionToken } from "./backend";

/// Server-component data loading for the signed-in customer pages. A missing
/// or expired session goes to /login; other failures surface as the page's
/// error state.
export async function loadForPage<T>(path: string): Promise<T> {
  const token = await sessionToken("web");
  if (!token) redirect("/login");
  let expired = false;
  try {
    return await backendFetch<T>(path, { token });
  } catch (err) {
    if (err instanceof BackendError && err.status === 401) expired = true;
    else throw err;
  }
  // redirect() throws, so it stays outside the try.
  if (expired) redirect("/login");
  throw new Error("unreachable");
}

export async function loadPublic<T>(path: string): Promise<T> {
  return backendFetch<T>(path);
}
