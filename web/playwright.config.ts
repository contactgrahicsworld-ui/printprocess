import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs the real Next.js app (next dev) with local drivers:
 * PGlite (real migrations), HMAC-signed local storage URLs, dev staff auth (refused in production).
 * Supabase/Vercel are not involved — see docs/DEPLOYMENT.md for the live verification checklist.
 */
const PORT = 3100;
const env = {
  APP_URL: `http://127.0.0.1:${PORT}`,
  APP_SECRET: "e2e-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
  DB_DRIVER: "pglite",
  PGLITE_DATA_DIR: ".e2e/pglite",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: ".e2e/storage",
  AUTH_DRIVER: "dev",
  CRON_SECRET: "e2e-cron-secret-123456",
  NEXT_TELEMETRY_DISABLED: "1",
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: env.APP_URL, trace: "retain-on-failure" },
  projects: [
    { name: "mobile-firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 412, height: 915 } } },
  ],
  webServer: {
    command: `node scripts/dev-seed.mjs --reset && next dev -H 127.0.0.1 -p ${PORT}`,
    url: `${env.APP_URL}/api/health`,
    timeout: 600_000,
    reuseExistingServer: false,
    env,
  },
});
