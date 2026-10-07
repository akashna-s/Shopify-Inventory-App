/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Render uses a stateless free web service with an unauthenticated health check", async () => {
  const [blueprint, health, dockerfile, vite] = await Promise.all([
    readFile(new URL("../render.yaml", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/health.jsx", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.js", import.meta.url), "utf8"),
  ]);
  assert.match(blueprint, /runtime: docker/);
  assert.match(blueprint, /plan: free/);
  assert.match(blueprint, /region: singapore/);
  assert.match(blueprint, /healthCheckPath: \/health/);
  assert.match(blueprint, /autoDeployTrigger: "off"/);
  assert.match(health, /status: "ok"/);
  assert.doesNotMatch(health, /authenticate/);
  assert.match(dockerfile, /ENV HOST=0\.0\.0\.0/);
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

test("daily refresh waits through a Render free-tier cold start", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/analytics-daily-refresh.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /wake_attempt/);
  assert.match(workflow, /warm-render/);
  assert.match(workflow, /04:55 Asia\/Kolkata/);
  assert.match(workflow, /05:00 Asia\/Kolkata/);
  assert.match(workflow, /\.status == "ok"/);
  assert.match(workflow, /Waiting for the web service to wake up/);
  assert.match(workflow, /has\("processed"\)/);
});
