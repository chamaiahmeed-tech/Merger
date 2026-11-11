import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @libsql/client يحتاج ملفات ثنائية أصلية — نستثنيها من التجميع
  serverExternalPackages: ["@libsql/client"],
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
