import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
    Deliberately NOT `output: "standalone"`. Its dependency tracing prunes files
    the Edge middleware adapter loads dynamically, and the container crashes at
    boot with a missing `async-storage/request-store`. A full node_modules costs
    image size and nothing else.
  */
  /*
    `next dev` and `next build` both write to the dist directory, and a build
    run while the dev server is live produces chunk errors that look like
    application bugs. Set NEXT_DIST_DIR to build into a scratch directory
    instead of stopping the dev server.
  */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pg", "bcryptjs"],
  outputFileTracingExcludes: { "*": [".pgdata/**", "storage/**"] },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
