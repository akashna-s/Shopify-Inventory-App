/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildFileCatalogSnapshot,
  buildFileMonthPayload,
} from "../app/shopify-file-cache-sync.server.js";
import {
  analyticsFilePaths,
  writeAnalyticsMonth,
} from "../app/analytics-file-cache.server.js";

test("file catalog keeps handle history when a product handle changes", () => {
  const previous = {
    products: [{
      shopifyProductId: "90071992547409930",
      title: "Pink dress",
      handle: "pink-dress",
      productType: "Dress",
      tags: [],
      catalogState: "present",
    }],
    handleHistory: [{
      shopify_product_id: "90071992547409930",
      handle: "pink-dress",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: null,
      last_seen_at: "2026-05-01T00:00:00.000Z",
    }],
  };
  const snapshot = buildFileCatalogSnapshot([{
    id: "gid://shopify/Product/90071992547409930",
    title: "Rose dress",
    handle: "rose-dress",
    productType: "Dress",
    tags: ["New"],
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
  }], previous, "2026-10-03T00:00:00.000Z");

  assert.equal(snapshot.handleHistory.length, 2);
  assert.equal(snapshot.handleHistory[0].valid_to, "2026-10-03T00:00:00.000Z");
  assert.equal(snapshot.handleHistory[1].handle, "rose-dress");
  assert.equal(snapshot.products[0].shopifyProductId, "90071992547409930");
});

test("monthly file is self-contained and follows existing inventory rules", () => {
  const catalog = {
    products: [{
      shopifyProductId: "123",
      title: "Product A",
      handle: "product-a",
      productType: "Dress",
      status: "ACTIVE",
      imageUrl: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      tags: ["Launch"],
      catalogState: "present",
    }],
    handleHistory: [{
      shopify_product_id: "123",
      handle: "product-a",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: null,
    }],
  };
  const payload = buildFileMonthPayload({
    month: "2026-09",
    currency: "INR",
    catalog,
    result: {
      start: "2026-09-01",
      end: "2026-09-30",
      inventory: { rows: [{ product_id: "123", starting_inventory_units: -4, ending_inventory_units: 8 }] },
      sales: { rows: [{ product_id: "123", orders: 2, total_sales: 123.45 }] },
      sessions: { rows: [{ landing_page_path: "/products/product-a", sessions: 9, sessions_that_completed_checkout: 2 }] },
      storeSessions: { rows: [{ sessions: 20 }] },
      store: { rows: [{ orders: 2, total_sales: 123.45 }] },
    },
  });

  assert.equal(payload.productMetrics[0].shopify_product_id, "123");
  assert.equal(payload.productMetrics[0].total_sales_minor, 12345);
  assert.equal(payload.productMetrics[0].landing_sessions, 9);
  assert.equal(payload.productMetrics[0].completed_checkout_sessions, 2);
  assert.equal(payload.storeMetrics.non_negative_starting_inventory, 0);
  assert.equal(payload.storeMetrics.non_negative_ending_inventory, 8);
});

test("file paths are store-separated and monthly files upload compressed", async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "server-secret";
  const calls = [];
  global.fetch = async (input, options) => {
    calls.push({ input: String(input), options });
    return Response.json({ Key: "stored" });
  };
  try {
    assert.equal(
      analyticsFilePaths(12).month("2026-09"),
      "stores/12/months/2026-09.json.gz",
    );
    const entry = await writeAnalyticsMonth(12, "2026-09", {
      productMetrics: [{ shopify_product_id: "123" }],
    });
    assert.equal(entry.productRows, 1);
    assert.ok(entry.compressedBytes > 0);
    assert.match(calls[0].input, /analytics-monthly-cache\/stores\/12\/months\/2026-09\.json\.gz$/);
    assert.equal(calls[0].options.headers.Authorization, "Bearer server-secret");
    assert.equal(calls[0].options.headers["x-upsert"], "true");
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});

test("private bucket and authenticated browser cache route are enforced", async () => {
  const [migration, route, appRoute] = await Promise.all([
    readFile(new URL("../supabase/migrations/202610030002_analytics_file_cache_bucket.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/app.analytics-cache.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/app.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /analytics-monthly-cache/);
  assert.match(migration, /public,\s*file_size_limit[\s\S]+false/);
  assert.match(route, /authenticate\.admin\(request\)/);
  assert.match(route, /storage_mode !== "file_cache"/);
  assert.match(appRoute, /bootstrapAnalyticsData/);
});

test("Product Audit monthly reads are versioned and day/week requests keep ShopifyQL", async () => {
  const [migration, productRoute, bootstrap] = await Promise.all([
    readFile(new URL("../supabase/migrations/202610030003_product_audit_monthly_reads.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/app.products.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/analytics-bootstrap.client.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /completed_checkout_sessions/);
  assert.match(migration, /source_range_start/);
  assert.match(migration, /cache_schema_version/);
  assert.match(migration, /get_audit_product_month_report/);
  assert.match(productRoute, /loadProductAuditMonthlyReport/);
  assert.match(productRoute, /resolution"\) === "daily"/);
  assert.match(productRoute, /key === "day" \|\| key === "week"/);
  assert.match(bootstrap, /Preparing saved analytics: \$\{completed\} of \$\{required\}/);
  assert.match(bootstrap, /runOneStep/);
  assert.match(bootstrap, /analytics-report-ready/);
  assert.match(bootstrap, /method: "POST"/);
});
