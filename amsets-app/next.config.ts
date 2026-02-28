import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack (Next.js 16 default) handles Node.js module resolution automatically.
  // The turbopack config below silences the "custom webpack config" warning
  // while still letting @irys/web-upload work in the browser.
  turbopack: {},
};

export default nextConfig;
