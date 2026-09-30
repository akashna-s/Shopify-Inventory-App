/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/202609300002_atomic_product_tag_refresh.sql", import.meta.url),
  "utf8",
);

test("tag refresh validates before deleting and inserts in the same function", () => {
  const validation = migration.indexOf("every tag must be non-empty");
  const deletion = migration.indexOf("delete from public.audit_product_tags");
  const insertion = migration.indexOf("insert into public.audit_product_tags");
  assert.ok(validation >= 0 && validation < deletion);
  assert.ok(deletion < insertion);
  assert.match(migration, /security definer/i);
});
