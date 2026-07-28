import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
    Deliberately NOT `output: "standalone"`. Its dependency tracing prunes files
    the Edge middleware adapter loads dynamically, and the container crashes at
    boot with a missing `async-storage/request-store`. A full node_modules costs
    image size and nothing else.
  */
  serverExternalPackages: ["pg", "bcryptjs"],
  outputFileTracingExcludes: { "*": [".pgdata/**", "storage/**"] },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
