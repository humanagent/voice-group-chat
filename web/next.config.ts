import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/sw.js",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
      ],
    }];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  telemetry: false,
  // We export numeric timings, not navigation traces.
  suppressOnRouterTransitionStartWarning: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG || !process.env.SENTRY_PROJECT,
    deleteSourcemapsAfterUpload: true,
  },
});
