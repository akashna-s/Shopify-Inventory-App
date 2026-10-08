/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  analyticsResponseBytes,
  normalizeAnalyticsPerformanceEvent,
} from "../app/analytics-performance.server.js";

test("analytics performance events contain bounded operational metadata only", () => {
  const event = normalizeAnalyticsPerformanceEvent({
    phase: "browser_ready",
    requestKind: "initial",
    requestId: "request-123",
    source: "supabase-database-new-arrival",
    cacheStatus: "memory",
    interval: "month",
    durationMs: "4123",
    serverDurationMs: 3500,
    responseBytes: 1234,
    rowCount: 24282,
    start: "2025-08-01",
    end: "2026-10-07",
    shop: "must-not-be-recorded.myshopify.com",
    productTitle: "Must not be recorded",
  });

  assert.equal(event.event, "analytics_performance");
  assert.equal(event.durationMs, 4123);
  assert.equal(event.source, "supabase-database-new-arrival");
  assert.equal(event.start, "2025-08-01");
  assert.equal(event.end, "2026-10-07");
  assert.equal("shop" in event, false);
  assert.equal("productTitle" in event, false);
});

test("analytics performance events reject arbitrary client labels and invalid values", () => {
  const event = normalizeAnalyticsPerformanceEvent({
    phase: "other",
    source: "merchant-name.myshopify.com",
    cacheStatus: "secret-value",
    durationMs: -10,
    start: "not-a-date",
  });

  assert.equal(event.phase, "server_loader");
  assert.equal(event.source, "unknown");
  assert.equal(event.cacheStatus, "unknown");
  assert.equal(event.durationMs, 0);
  assert.equal("start" in event, false);
});

test("analytics response sizing measures the serialized response", () => {
  assert.equal(analyticsResponseBytes({ ok: true }), 11);
});

test("browser performance reporting is authenticated and cannot reload reports", async () => {
  const [endpoint, appRoute, reportRoute] = await Promise.all([
    readFile(
      new URL("../app/routes/app.analytics-performance.jsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/routes/app.jsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/routes/app.new-arrivals.jsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(endpoint, /authenticate\.admin\(request\)/);
  assert.match(endpoint, /request\.method !== "POST"/);
  assert.match(appRoute, /__newArrivalNavigationStartedAt/);
  assert.match(appRoute, /formAction === "\/app\/analytics-performance"/);
  assert.match(reportRoute, /performanceFetcher\.submit/);
  assert.match(reportRoute, /phase: "server_loader"/);
  assert.match(reportRoute, /formAction === "\/app\/analytics-performance"/);
});
