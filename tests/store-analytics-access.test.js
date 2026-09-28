/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import { createAuthenticatedStoreAnalytics } from "../app/store-analytics-access.server.js";

function installStoreApi() {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://test.supabase.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  const calls = [];

  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.endsWith("/audit_stores") && (!options.method || options.method === "GET")) {
      const shop = String(url.searchParams.get("shop_domain")).replace("eq.", "");
      const stores = {
        "store-a.myshopify.com": { id: 1, shop_domain: shop, currency_code: "USD", status: "active" },
        "store-b.myshopify.com": { id: 2, shop_domain: shop, currency_code: "USD", status: "active" },
      };
      return Response.json(stores[shop] ? [stores[shop]] : []);
    }
    if (!options.method || options.method === "GET") return Response.json([]);
    if (options.method === "POST") return Response.json(1);
    return new Response(null, { status: 204 });
  };

  return {
    calls,
    restore() {
      global.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = originalUrl;
      if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    },
  };
}

test("authenticated gateways force their own store on reads, updates, deletes and month writes", async () => {
  const api = installStoreApi();
  try {
    const storeA = await createAuthenticatedStoreAnalytics({ shop: "store-a.myshopify.com" });
    const storeB = await createAuthenticatedStoreAnalytics({ shop: "store-b.myshopify.com" });

    await storeA.selectProductMonths({
      filters: [
        ["store_id", "eq", 2],
        ["month", "eq", "2026-06-01"],
      ],
    });
    await storeB.selectProductMonths();
    await storeA.updateJob(99, { status: "completed" });
    await storeA.deleteExpiredMonths("2025-04-01");
    await storeA.replaceMonth({
      month: "2026-06-01",
      productMetrics: [],
      storeMetrics: { active_products: 0 },
    });
  } finally {
    api.restore();
  }

  const productReads = api.calls.filter(({ url }) =>
    url.pathname.endsWith("/audit_product_month_metrics"),
  );
  assert.equal(productReads.length, 3);
  assert.equal(productReads[0].url.searchParams.get("store_id"), "eq.1");
  assert.equal(productReads[0].url.searchParams.getAll("store_id").length, 1);
  assert.equal(productReads[1].url.searchParams.get("store_id"), "eq.2");
  assert.equal(productReads[2].url.searchParams.get("store_id"), "eq.1");

  const jobUpdate = api.calls.find(({ url, options }) =>
    url.pathname.endsWith("/audit_sync_jobs") && options.method === "PATCH",
  );
  assert.equal(jobUpdate.url.searchParams.get("store_id"), "eq.1");
  assert.equal(jobUpdate.url.searchParams.get("id"), "eq.99");

  const storeMonthDelete = api.calls.find(({ url, options }) =>
    url.pathname.endsWith("/audit_store_month_metrics") && options.method === "DELETE",
  );
  assert.equal(storeMonthDelete.url.searchParams.get("store_id"), "eq.1");

  const monthReplace = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/replace_audit_store_month"),
  );
  assert.equal(JSON.parse(monthReplace.options.body).p_store_id, 1);
});

test("store analytics access refuses requests without an authenticated Shopify session", async () => {
  await assert.rejects(
    createAuthenticatedStoreAnalytics({}),
    /authenticated Shopify session is required/,
  );
});
