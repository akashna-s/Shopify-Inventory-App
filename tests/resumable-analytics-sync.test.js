/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dailyRefreshDue } from "../app/analytics-daily-refresh.server.js";

test("daily refresh becomes due after the store's local morning", () => {
  const now = new Date("2026-10-07T00:30:00.000Z"); // 06:00 in India
  assert.equal(dailyRefreshDue({
    now,
    timeZone: "Asia/Kolkata",
    refreshedAt: "2026-10-06T01:00:00.000Z",
    sourceRangeEnd: "2026-10-05",
    refreshHour: 5,
  }), true);
  assert.equal(dailyRefreshDue({
    now,
    timeZone: "Asia/Kolkata",
    refreshedAt: "2026-10-07T00:10:00.000Z",
    sourceRangeEnd: "2026-10-06",
    refreshHour: 5,
  }), false);
});

test("resumable preparation upgrades one legacy month instead of replacing it", async () => {
  const [migration, sync, route, bootstrap] = await Promise.all([
    readFile(new URL("../supabase/migrations/202610070001_resumable_monthly_sync.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/shopify-supabase-sync.server.js", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/app.analytics-sync.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/analytics-bootstrap.client.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /upgrade_audit_store_month_sessions_v1/);
  assert.match(migration, /cache_schema_version = 1/);
  assert.match(migration, /completed_checkout_sessions/);
  assert.match(sync, /monthly_v1_selective_upgrade/);
  assert.match(sync, /syncNextAnalyticsPreparationStep/);
  assert.match(sync, /Number\(legacy\[0\]\.cache_schema_version\) < 1/);
  assert.match(sync, /month !== preparation\.requiredMonths\[0\]/);
  assert.match(route, /syncNextAnalyticsPreparationStep/);
  assert.doesNotMatch(route, /syncLatest18MonthsToSupabase\(admin, session\)/);
  assert.match(bootstrap, /while \(!status\.preparation\?\.ready\)/);
});

test("deployed daily refresh is secret-protected and processes one due store", async () => {
  const [route, workflow, example] = await Promise.all([
    readFile(new URL("../app/routes/api.analytics-cron.jsx", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/analytics-daily-refresh.yml", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /due\[0\]/);
  assert.match(route, /daily_current_month_refresh/);
  assert.match(workflow, /cron: "25 23 \* \* \*"/);
  assert.match(workflow, /cron: "30 23 \* \* \*"/);
  assert.match(workflow, /cron: "15 \* \* \* \*"/);
  assert.match(workflow, /health_url=/);
  assert.match(workflow, /ANALYTICS_CRON_SECRET/);
  assert.match(example, /ANALYTICS_DAILY_REFRESH_HOUR=5/);
});
