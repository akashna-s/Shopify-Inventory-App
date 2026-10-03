/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyticsDatabaseCapacityPolicy,
  analyticsStorageSizing,
  projectedStoreStorageBytes,
} from "../app/analytics-storage-routing.server.js";
import { createAuthenticatedStoreAnalytics } from "../app/store-analytics-access.server.js";

function withCapacityEnvironment(callback) {
  const names = [
    "ANALYTICS_DATABASE_LIMIT_BYTES",
    "ANALYTICS_DATABASE_SOFT_LIMIT_PERCENT",
    "ANALYTICS_DATABASE_BASELINE_BYTES",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const name of names) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
    });
}

test("projected store storage reserves a mature 18-month allowance", () => {
  assert.equal(projectedStoreStorageBytes(0), 8_000_000);
  assert.equal(projectedStoreStorageBytes(100), 8_000_000);
  assert.equal(projectedStoreStorageBytes(4_003), 60_045_000);
  assert.deepEqual(analyticsStorageSizing, {
    minimumStoreBytes: 8_000_000,
    bytesPerProduct: 15_000,
  });
});

test("capacity policy defaults to the selected 80 percent safety limit", async () => {
  await withCapacityEnvironment(() => {
    delete process.env.ANALYTICS_DATABASE_LIMIT_BYTES;
    delete process.env.ANALYTICS_DATABASE_SOFT_LIMIT_PERCENT;
    delete process.env.ANALYTICS_DATABASE_BASELINE_BYTES;
    assert.deepEqual(analyticsDatabaseCapacityPolicy(), {
      databaseLimitBytes: 500_000_000,
      softLimitPercent: 80,
      softLimitBytes: 400_000_000,
      databaseBaselineBytes: 15_000_000,
    });
  });
});

test("new stores receive one atomic capacity assignment instead of a direct upsert", async () => {
  await withCapacityEnvironment(async () => {
    process.env.SUPABASE_URL = "https://test.supabase.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (input, options = {}) => {
      calls.push({ url: new URL(input), options });
      return Response.json([{
        id: 9,
        shop_domain: "new-store.myshopify.com",
        currency_code: "INR",
        iana_timezone: "Asia/Kolkata",
        status: "active",
        storage_mode: "database",
        storage_mode_assigned_at: "2026-10-03T00:00:00.000Z",
        projected_storage_bytes: 60_045_000,
        storage_assignment_reason: "within_projected_80_percent_capacity",
        existing_assignment: false,
      }]);
    };

    try {
      const analytics = await createAuthenticatedStoreAnalytics(
        { shop: "new-store.myshopify.com" },
        {
          createStore: true,
          currencyCode: "INR",
          ianaTimeZone: "Asia/Kolkata",
          projectedStorageBytes: 60_045_000,
        },
      );
      assert.equal(analytics.store.storage_mode, "database");
    } finally {
      global.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    assert.match(calls[0].url.pathname, /rpc\/assign_audit_store_storage$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      p_shop_domain: "new-store.myshopify.com",
      p_currency_code: "INR",
      p_iana_timezone: "Asia/Kolkata",
      p_projected_storage_bytes: 60_045_000,
      p_database_limit_bytes: 500_000_000,
      p_soft_limit_percent: 80,
      p_database_baseline_bytes: 15_000_000,
    });
  });
});

test("migration locks concurrent assignments and preserves existing storage mode", async () => {
  const sql = await readFile(
    new URL(
      "../supabase/migrations/202610030001_analytics_storage_routing.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(sql, /storage_mode in \('database', 'file_cache'\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /if found then[\s\S]+never change storage_mode/i);
  assert.match(sql, /greatest\([\s\S]+p_database_baseline_bytes \+ v_reserved_database_bytes/);
  assert.match(sql, /v_projected_database_bytes <= v_soft_limit_bytes/);
  assert.match(sql, /set_audit_store_storage_mode/);
  assert.match(
    sql,
    /revoke insert, update on table public\.audit_stores from service_role/,
  );
});

test("the authenticated app shell starts assignment for a new store without changing reports", async () => {
  const [appRoute, assignmentRoute] = await Promise.all([
    readFile(new URL("../app/routes/app.jsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/routes/app.analytics-storage.jsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(appRoute, /action: "\/app\/analytics-storage"/);
  assert.match(appRoute, /!storageAssigned/);
  assert.match(assignmentRoute, /authenticate\.admin\(request\)/);
  assert.match(
    assignmentRoute,
    /ensureShopifyStoreStorageAssignment/,
  );
  assert.doesNotMatch(assignmentRoute, /app\.products|app\.new-arrivals/);
});
