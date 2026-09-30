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
    if (options.method === "POST") {
      if (url.pathname.includes("_with_counts")) {
        return Response.json({
          rows_processed: 1,
          rows_inserted: 1,
          rows_updated: 0,
          rows_deleted: 0,
        });
      }
      return Response.json(1);
    }
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
    await storeA.selectReportProducts({ filters: [["store_id", "eq", 2]] });
    await storeA.replaceProductTags(
      [{ product_id: 101, tag: "Summer" }],
      [101],
    );
    await storeA.reconcileCatalog([101, 102], "2026-09-29T10:00:00.000Z");
    await storeA.ensureUnattributedProduct();
    await storeA.reconcileProductHandles(
      [{ shopify_product_id: 101, handle: "pink-dress" }],
      "2026-09-29T10:00:00.000Z",
    );
    await storeA.selectProductHandleHistory();
    await storeA.markProductDeleted(102, "2026-09-29T11:00:00.000Z");
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
  assert.equal(productReads.length, 2);
  assert.equal(productReads[0].url.searchParams.get("store_id"), "eq.1");
  assert.equal(productReads[0].url.searchParams.getAll("store_id").length, 1);
  assert.equal(productReads[1].url.searchParams.get("store_id"), "eq.2");

  const reportProductRead = api.calls.find(({ url }) =>
    url.pathname.endsWith("/audit_products_with_effective_status"),
  );
  assert.equal(reportProductRead.url.searchParams.get("store_id"), "eq.1");
  assert.equal(reportProductRead.url.searchParams.getAll("store_id").length, 1);

  const catalogReconcile = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/reconcile_audit_product_catalog"),
  );
  assert.deepEqual(JSON.parse(catalogReconcile.options.body), {
    p_store_id: 1,
    p_seen_product_ids: ["101", "102"],
    p_seen_at: "2026-09-29T10:00:00.000Z",
  });

  const tagReplacement = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/replace_audit_product_tags_with_counts"),
  );
  assert.deepEqual(JSON.parse(tagReplacement.options.body), {
    p_store_id: 1,
    p_refreshed_product_ids: [101],
    p_tags: [{ product_id: 101, tag: "Summer" }],
  });
  assert.equal(api.calls.some(({ url, options }) =>
    url.pathname.endsWith("/audit_product_tags") && options.method === "DELETE"), false);

  const unattributedProduct = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/ensure_audit_unattributed_product"),
  );
  assert.deepEqual(JSON.parse(unattributedProduct.options.body), {
    p_store_id: 1,
  });

  const productDelete = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/mark_audit_product_deleted"),
  );
  assert.deepEqual(JSON.parse(productDelete.options.body), {
    p_store_id: 1,
    p_shopify_product_id: "102",
    p_deleted_at: "2026-09-29T11:00:00.000Z",
  });

  const handleReconcile = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/reconcile_audit_product_handles"),
  );
  assert.deepEqual(JSON.parse(handleReconcile.options.body), {
    p_store_id: 1,
    p_handles: [{ shopify_product_id: "101", handle: "pink-dress" }],
    p_seen_at: "2026-09-29T10:00:00.000Z",
  });

  const handleRead = api.calls.find(({ url }) =>
    url.pathname.endsWith("/audit_product_handle_history_with_product"),
  );
  assert.equal(handleRead.url.searchParams.get("store_id"), "eq.1");

  const jobUpdate = api.calls.find(({ url, options }) =>
    url.pathname.endsWith("/audit_sync_jobs") && options.method === "PATCH",
  );
  assert.equal(jobUpdate.url.searchParams.get("store_id"), "eq.1");
  assert.equal(jobUpdate.url.searchParams.get("id"), "eq.99");

  const retentionCleanup = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/delete_expired_audit_monthly_metrics_with_counts"),
  );
  assert.deepEqual(JSON.parse(retentionCleanup.options.body), {
    p_store_id: 1,
    p_retain_from_month: "2025-04-01",
  });

  const orphanCleanup = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/cleanup_audit_orphan_products"),
  );
  assert.equal(JSON.parse(orphanCleanup.options.body).p_store_id, 1);

  const monthReplace = api.calls.find(({ url }) =>
    url.pathname.endsWith("/rpc/replace_audit_store_month_with_counts"),
  );
  assert.equal(JSON.parse(monthReplace.options.body).p_store_id, 1);
});

test("store analytics access refuses requests without an authenticated Shopify session", async () => {
  await assert.rejects(
    createAuthenticatedStoreAnalytics({}),
    /authenticated Shopify session is required/,
  );
});
