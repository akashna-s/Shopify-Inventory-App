/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/202609300003_monthly_currency_history.sql", import.meta.url),
  "utf8",
);

test("currency is stored on product and store monthly rows", () => {
  assert.match(migration, /alter table public\.audit_product_month_metrics[\s\S]*currency_code varchar\(3\)/i);
  assert.match(migration, /alter table public\.audit_store_month_metrics[\s\S]*currency_code varchar\(3\)/i);
  assert.match(migration, /currency_code ~ '\^\[A-Z\]\{3\}\$'/i);
});

test("cross-currency month replacement is blocked without conversion", () => {
  assert.match(migration, /cannot replace existing % month % with currency % without conversion/i);
  assert.match(migration, /v_existing_store_currency <> v_incoming_currency/i);
});
