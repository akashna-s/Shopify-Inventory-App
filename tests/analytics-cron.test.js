/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeDailyRefreshError,
  refreshFirstDueAnalyticsStore,
} from "../app/analytics-cron.server.js";

const stores = [
  { id: 1, shop_domain: "broken.myshopify.com", month: "2026-10" },
  { id: 2, shop_domain: "healthy.myshopify.com", month: "2026-10" },
];

test("daily refresh describes Response failures instead of logging undefined", () => {
  assert.deepEqual(
    describeDailyRefreshError(new Response(undefined, {
      status: 500,
      statusText: "Internal Server Error",
    })),
    {
      message: "HTTP 500 Internal Server Error",
      status: 500,
      code: null,
    },
  );
});

test("a broken store does not block the next due store", async () => {
  const logged = [];
  const result = await refreshFirstDueAnalyticsStore({
    dueStores: stores,
    now: new Date("2026-10-12T02:30:00.000Z"),
    authenticateStore: async (store) => {
      if (store.id === 1) {
        throw new Response(undefined, {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
      return { admin: {}, session: {} };
    },
    syncStore: async () => ({ status: "completed", storageMode: "database" }),
    logFailure: (failure) => logged.push(failure),
  });

  assert.equal(result.processed, true);
  assert.equal(result.storeId, "2");
  assert.equal(result.remainingDue, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].shopDomain, "broken.myshopify.com");
  assert.equal(result.failures[0].phase, "authentication");
  assert.equal(result.failures[0].error, "HTTP 500 Internal Server Error");
  assert.equal(logged.length, 1);
});

test("workflow-provided store IDs are skipped on later calls", async () => {
  const authenticated = [];
  const result = await refreshFirstDueAnalyticsStore({
    dueStores: stores,
    skippedStoreIds: ["1"],
    now: new Date("2026-10-12T02:30:00.000Z"),
    authenticateStore: async (store) => {
      authenticated.push(store.id);
      return { admin: {}, session: {} };
    },
    syncStore: async () => ({ status: "completed", storageMode: "database" }),
  });

  assert.deepEqual(authenticated, [2]);
  assert.equal(result.storeId, "2");
  assert.deepEqual(result.failures, []);
});
