import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    // Prevent webpack from trying to bundle Node.js-only modules that are not
    // needed in the browser. Required by @irys/web-upload and related packages.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      child_process: false,
    };
    return config;
  },
};

export default nextConfig;
