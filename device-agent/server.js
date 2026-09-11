// Zero-dependency static server for the kiosk page — PRD §7.1/§7.2: the Pi
// drives a local browser kiosk page. Phase 4 swaps `deposit()` below for a
// real GPIO pulse-counter (or pyserial ccTalk reader) instead of the button
// in public/app.js; everything else stays the same.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.KIOSK_PORT || 8080;
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url;
  try {
    const filePath = join(PUBLIC_DIR, path);
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`kiosk page on :${PORT} — set BACKEND_URL in index.html/app.js for a non-local backend`);
});
