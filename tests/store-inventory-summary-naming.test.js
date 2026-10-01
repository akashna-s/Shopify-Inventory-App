/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/202610010001_clear_store_inventory_summary_names.sql",
  import.meta.url,
);
const syncUrl = new URL("../app/shopify-supabase-sync.server.js", import.meta.url);

test("store inventory summaries use explicit non-negative validation names", async () => {
  const [migration, sync] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(syncUrl, "utf8"),
  ]);

  assert.match(
    migration,
    /rename column starting_inventory to non_negative_starting_inventory/i,
  );
  assert.match(
    migration,
    /rename column ending_inventory to non_negative_ending_inventory/i,
  );
  assert.match(
    migration,
    /not the NA Inventory percentage denominator/i,
  );
  assert.match(sync, /non_negative_starting_inventory:\s*sumNonNegativeInventory/);
  assert.match(sync, /non_negative_ending_inventory:\s*sumNonNegativeInventory/);
});

test("product-month inventory keeps Shopify's original field names", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /audit_product_month_metrics[\s\S]*starting_inventory, ending_inventory/,
  );
  assert.match(
    migration,
    /metric\.non_negative_starting_inventory,[\s\S]*metric\.starting_inventory/,
  );
});
