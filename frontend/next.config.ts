import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The server builds each release into a fresh directory while the current
  // one keeps serving, then switches over (zero-downtime deploys).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
