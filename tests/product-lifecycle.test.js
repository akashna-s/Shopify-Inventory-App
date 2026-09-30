/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveProductStatus,
  isValidCatalogState,
} from "../app/product-lifecycle.server.js";

test("effective status prioritizes lifecycle over stale Shopify status", () => {
  assert.equal(effectiveProductStatus({ status: "ACTIVE", catalog_state: "missing", record_kind: "unattributed" }), "UNATTRIBUTED");
  assert.equal(effectiveProductStatus({ status: "ACTIVE", catalog_state: "deleted" }), "DELETED");
  assert.equal(effectiveProductStatus({ status: "ACTIVE", catalog_state: "missing" }), "MISSING");
  assert.equal(effectiveProductStatus({ status: "DRAFT", catalog_state: "present" }), "DRAFT");
  assert.equal(effectiveProductStatus({ status: "ARCHIVED" }), "ARCHIVED");
});

test("catalog states are restricted to present, missing and deleted", () => {
  assert.equal(isValidCatalogState("present"), true);
  assert.equal(isValidCatalogState("missing"), true);
  assert.equal(isValidCatalogState("deleted"), true);
  assert.equal(isValidCatalogState("active"), false);
});
