/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/202609300001_monthly_product_metadata_snapshots.sql", import.meta.url),
  "utf8",
);

test("monthly metadata migration stores only title, product type and handle snapshots", () => {
  assert.match(migration, /title_snapshot text/i);
  assert.match(migration, /product_type_snapshot text/i);
  assert.match(migration, /handle_snapshot text/i);
  assert.doesNotMatch(migration, /tags_snapshot|tag_snapshot/i);
});

test("monthly replacement preserves an existing product-month snapshot", () => {
  assert.match(migration, /v_existing_snapshots jsonb/i);
  assert.match(migration, /coalesce\(existing\.title_snapshot, metric\.title_snapshot/i);
  assert.match(migration, /coalesce\(existing\.product_type_snapshot, metric\.product_type_snapshot/i);
  assert.match(migration, /coalesce\(existing\.handle_snapshot, metric\.handle_snapshot/i);
});
