import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "bcryptjs"],
  outputFileTracingExcludes: { "*": [".pgdata/**", "storage/**"] },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
