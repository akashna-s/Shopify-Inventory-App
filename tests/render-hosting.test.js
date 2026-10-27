/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Render uses a stateless free web service with an unauthenticated health check", async () => {
  const [blueprint, health, dockerfile, dockerignore, vite] = await Promise.all([
    readFile(new URL("../render.yaml", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/health.jsx", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.js", import.meta.url), "utf8"),
  ]);
  assert.match(blueprint, /runtime: docker/);
  assert.match(blueprint, /name: secondlook/);
  assert.match(blueprint, /plan: free/);
  assert.match(blueprint, /region: singapore/);
  assert.match(blueprint, /healthCheckPath: \/health/);
  assert.match(blueprint, /autoDeployTrigger: "off"/);
  assert.doesNotMatch(blueprint, /maxShutdownDelaySeconds/);
  assert.match(health, /status: "ok"/);
  assert.doesNotMatch(health, /authenticate/);
  assert.match(dockerfile, /ENV HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /RUN npm run setup && npm run build/);
  assert.match(dockerfile, /CMD \["npm", "run", "start"\]/);
  assert.doesNotMatch(dockerfile, /CMD \["npm", "run", "docker-start"\]/);
  assert.match(dockerignore, /prisma\/\*\.sqlite/);
  assert.match(dockerignore, /prisma\/\*\.sqlite-journal/);
  assert.match(vite, /\^https\?:\\\/\\\//);
});

test("Shopify sessions persist in a service-role-only Supabase table", async () => {
  const [migration, storage, shopify] = await Promise.all([
    readFile(new URL("../supabase/migrations/202610070002_shopify_sessions.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/supabase-session-storage.server.js", import.meta.url), "utf8"),
    readFile(new URL("../app/shopify.server.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /create table if not exists public\.audit_shopify_sessions/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all.*anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete.*service_role/);
  assert.match(storage, /class SupabaseSessionStorage/);
  assert.match(storage, /resolution=merge-duplicates/);
  assert.match(shopify, /new SupabaseSessionStorage/);
  assert.match(shopify, /fallback: localSessionStorage/);
});

test("Shopify lifecycle webhooks update persistent Supabase state", async () => {
  const [uninstall, scopes, analytics, migration, retentionMigration, cronRoute] = await Promise.all([
    readFile(new URL("../app/routes/webhooks.app.uninstalled.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/webhooks.app.scopes_update.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/supabase-analytics.server.js", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/202610120001_store_uninstall_lifecycle.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/202610140001_uninstalled_store_retention.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/api.analytics-cron.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(uninstall, /sessionStorage\.findSessionsByShop/);
  assert.match(uninstall, /sessionStorage\.deleteSessions/);
  assert.match(uninstall, /markSupabaseStoreUninstalled/);
  assert.doesNotMatch(uninstall, /db\.session/);
  assert.match(scopes, /sessionStorage\.storeSession/);
  assert.match(analytics, /rpc\/mark_audit_store_uninstalled/);
  assert.match(migration, /status = 'uninstalled'/);
  assert.match(migration, /uninstalled_at = now\(\)/);
  assert.match(migration, /grant execute.*mark_audit_store_uninstalled/s);
  assert.match(retentionMigration, /p_retention_days integer default 15/);
  assert.match(retentionMigration, /delete from public\.audit_stores/);
  assert.match(cronRoute, /purgeExpiredUninstalledStores/);
});

test("daily refresh is a manual fallback that waits through a Render cold start", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/analytics-daily-refresh.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /wake_attempt/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /cron-job\.org/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /cron:/);
  assert.match(workflow, /\.status == "ok"/);
  assert.match(workflow, /Waiting for the web service to wake up/);
  assert.match(workflow, /has\("processed"\)/);
});

test("product audit source comparison uses the production token refresh path", async () => {
  const comparison = await readFile(
    new URL("../scripts/compare-product-audit-sources.mjs", import.meta.url),
    "utf8",
  );
  assert.match(comparison, /import\("\.\.\/app\/shopify\.server\.js"\)/);
  assert.match(comparison, /unauthenticated\.admin\(store\.shop_domain\)/);
  assert.match(comparison, /runShopifyQL\(admin,/);
  assert.doesNotMatch(comparison, /new SupabaseSessionStorage/);
  assert.doesNotMatch(comparison, /X-Shopify-Access-Token/);
});

test("office-hours keep-alive only pings Render health every ten minutes", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/render-office-hours-keepalive.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /cron: "\*\/10 8-21 \* \* \*"/);
  assert.match(workflow, /timezone: "Asia\/Kolkata"/);
  assert.match(workflow, /https:\/\/secondlook-bu80\.onrender\.com\/health/);
  assert.match(workflow, /timeout-minutes: 2/);
  assert.match(workflow, /permissions: \{\}/);
  assert.doesNotMatch(workflow, /api\/analytics-cron/);
  assert.doesNotMatch(workflow, /Authorization:/);
  assert.doesNotMatch(workflow, /request POST/);
});
