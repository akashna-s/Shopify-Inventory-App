/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteExpiredMonthlyMetrics,
  replaceSupabaseStoreMonth,
} from "../app/supabase-analytics.server.js";

function installInMemorySupabase(rowsByTable) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://test.supabase.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(options.method, "POST");
    assert.equal(
      url.pathname.endsWith("/rpc/delete_expired_audit_monthly_metrics_with_counts"),
      true,
    );
    const body = JSON.parse(options.body);
    let deleted = 0;
    for (const table of Object.keys(rowsByTable)) {
      const before = rowsByTable[table].length;
      rowsByTable[table] = rowsByTable[table].filter(
        (row) => !(row.store_id === body.p_store_id && row.month < body.p_retain_from_month),
      );
      deleted += before - rowsByTable[table].length;
    }
    return Response.json({
      rows_processed: 0,
      rows_inserted: 0,
      rows_updated: 0,
      rows_deleted: deleted,
    });
  };

  return () => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  };
}

test("retention cleanup deletes only the selected store's expired rows", async () => {
  const rows = {
    audit_product_month_metrics: [
      { store_id: 1, month: "2025-01-01" },
      { store_id: 1, month: "2025-04-01" },
      { store_id: 2, month: "2025-01-01" },
      { store_id: 2, month: "2025-04-01" },
    ],
    audit_store_month_metrics: [
      { store_id: 1, month: "2025-01-01" },
      { store_id: 1, month: "2025-04-01" },
      { store_id: 2, month: "2025-01-01" },
      { store_id: 2, month: "2025-04-01" },
    ],
    audit_unmatched_landing_sessions: [
      { store_id: 1, month: "2025-01-01" },
      { store_id: 1, month: "2025-04-01" },
      { store_id: 2, month: "2025-01-01" },
      { store_id: 2, month: "2025-04-01" },
    ],
  };
  const restore = installInMemorySupabase(rows);

  try {
    const counts = await deleteExpiredMonthlyMetrics(1, "2025-04-01");
    assert.equal(counts.rowsDeleted, 3);
  } finally {
    restore();
  }

  for (const tableRows of Object.values(rows)) {
    assert.deepEqual(tableRows, [
      { store_id: 1, month: "2025-04-01" },
      { store_id: 2, month: "2025-01-01" },
      { store_id: 2, month: "2025-04-01" },
    ]);
  }
});

test("retention cleanup refuses to run without a store ID", async () => {
  await assert.rejects(
    deleteExpiredMonthlyMetrics(undefined, "2025-04-01"),
    /store ID is required/,
  );
});

test("monthly replacement sends the complete store-month in one RPC call", async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://test.supabase.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  const calls = [];
  global.fetch = async (input, options = {}) => {
    calls.push({ input, options });
    return Response.json({
      rows_processed: 2,
      rows_inserted: 2,
      rows_updated: 0,
      rows_deleted: 1,
    });
  };

  try {
    const counts = await replaceSupabaseStoreMonth({
      storeId: 7,
      month: "2026-06-01",
      productMetrics: [{ product_id: 101, total_sales_minor: 120000 }],
      storeMetrics: { active_products: 1, total_sales_minor: 120000 },
    });
    assert.deepEqual(counts, {
      rowsProcessed: 2,
      rowsInserted: 2,
      rowsUpdated: 0,
      rowsDeleted: 1,
    });
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(
    call.input,
    "https://test.supabase.invalid/rest/v1/rpc/replace_audit_store_month_with_counts",
  );
  assert.equal(call.options.method, "POST");
  assert.deepEqual(JSON.parse(call.options.body), {
    p_store_id: 7,
    p_month: "2026-06-01",
    p_product_metrics: [{ product_id: 101, total_sales_minor: 120000 }],
    p_store_metrics: { active_products: 1, total_sales_minor: 120000 },
  });
});

test("monthly replacement refuses incomplete input before calling Supabase", async () => {
  await assert.rejects(
    replaceSupabaseStoreMonth({
      storeId: 7,
      month: "2026-06-15",
      productMetrics: [],
      storeMetrics: {},
    }),
    /first-of-month date is required/,
  );
});
