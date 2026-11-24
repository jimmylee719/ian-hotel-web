import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};

export default withNextIntl(nextConfig);

initOpenNextCloudflareForDev();
