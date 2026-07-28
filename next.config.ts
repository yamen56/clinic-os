import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server bundle so the container image carries only
  // what the app actually imports, instead of all of node_modules.
  output: "standalone",
  serverExternalPackages: ["pg", "bcryptjs"],
  outputFileTracingExcludes: { "*": [".pgdata/**", "storage/**"] },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
