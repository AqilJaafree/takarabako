// MapLibre 6 runs tile parsing in a module Worker loaded from a URL, and
// browsers only allow same-origin workers. Copy the worker and the shared
// chunk it imports into public/ so /maplibre/… serves them (KioskMap sets
// the URL). Runs after install and before every build.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules/maplibre-gl/dist");
const to = join(root, "public/maplibre");
mkdirSync(to, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(from, f), join(to, f));
console.log("[maplibre] worker copied to public/maplibre/");
