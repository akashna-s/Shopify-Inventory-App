import assert from "node:assert/strict";
import test from "node:test";

import { deleteExpiredMonthlyMetrics } from "../app/supabase-analytics.server.js";

function installInMemorySupabase(rowsByTable) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://test.supabase.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  globalThis.fetch = async (input, options = {}) => {
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
    globalThis.fetch = originalFetch;
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
