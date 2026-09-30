/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { shopifyIdText } from "../app/shopify-id.js";

test("Shopify IDs remain exact decimal text above JavaScript's safe integer limit", () => {
  const largeId = "18446744073709551615";
  assert.equal(shopifyIdText(largeId), largeId);
  assert.equal(shopifyIdText(`gid://shopify/Product/${largeId}`), largeId);
  assert.equal(typeof shopifyIdText(largeId), "string");
});

test("unsafe numeric Shopify IDs are rejected before silent rounding", () => {
  assert.throws(
    () => shopifyIdText(9_007_199_254_740_992),
    /unsafe JavaScript number/,
  );
});

test("Shopify ID migration uses text while internal IDs remain bigint", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/202609300006_shopify_ids_as_text.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /alter column shopify_product_id type text/);
  assert.match(sql, /p_seen_product_ids text\[\]/);
  assert.match(sql, /p_shopify_product_id text/);
  assert.doesNotMatch(sql, /alter column id type text/);
  assert.doesNotMatch(sql, /alter column store_id type text/);
});
