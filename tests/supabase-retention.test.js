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
    assert.equal(options.method, "DELETE");
    const url = new URL(input);
    const table = url.pathname.split("/").at(-1);
    const storeId = Number(String(url.searchParams.get("store_id")).replace("eq.", ""));
    const cutoff = String(url.searchParams.get("month")).replace("lt.", "");

    rowsByTable[table] = rowsByTable[table].filter(
      (row) => !(row.store_id === storeId && row.month < cutoff),
    );
    return new Response(null, { status: 204 });
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
  };
  const restore = installInMemorySupabase(rows);

  try {
    await deleteExpiredMonthlyMetrics(1, "2025-04-01");
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
    return new Response("2", { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const written = await replaceSupabaseStoreMonth({
      storeId: 7,
      month: "2026-06-01",
      productMetrics: [{ product_id: 101, total_sales_minor: 120000 }],
      storeMetrics: { active_products: 1, total_sales_minor: 120000 },
    });
    assert.equal(written, 2);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.input, "https://test.supabase.invalid/rest/v1/rpc/replace_audit_store_month");
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
