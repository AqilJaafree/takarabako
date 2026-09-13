// Copy this file to config.js and point it at the right backend for this
// deployment target — the real config.js is gitignored so each target (the
// Pi's local kiosk, a public demo build, ...) can carry its own value
// without fighting over one committed file.
//
// Local dev / the Pi (backend running on the same LAN):
//   window.BACKEND_URL = "http://<this-laptop's-LAN-IP>:4000";
//
// Public demo build (backend deployed separately, e.g. on Railway):
//   window.BACKEND_URL = "https://<your-backend>.up.railway.app";
window.BACKEND_URL = "http://localhost:4000";
