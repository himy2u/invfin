import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Portable to Cloud Run/ECS/Azure Container Apps later, not just Vercel.
  // See .claude/rules/cloud-portability.md.
  output: "standalone",
};

export default nextConfig;
