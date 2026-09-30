/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import { matchLandingSessions } from "../app/landing-session-matcher.server.js";

test("matches current and historical handles and preserves unmatched sessions", () => {
  const result = matchLandingSessions([
    { landing_page_path: "/products/pink-dress?utm_source=old", sessions: 4 },
    { landing_page_path: "/products/rose-dress", sessions: 6 },
    { landing_page_path: "/products/unknown-product", sessions: 3 },
  ], [
    { shopify_product_id: "18446744073709551615", handle: "pink-dress" },
    { shopify_product_id: "18446744073709551615", handle: "rose-dress" },
  ]);

  assert.equal(result.matched.get("18446744073709551615"), 10);
  assert.equal(result.unmatched.get("unknown-product"), 3);
});

test("keeps a reused ambiguous handle unmatched instead of assigning it incorrectly", () => {
  const result = matchLandingSessions([
    { landing_page_path: "/products/reused-handle", sessions: 5 },
  ], [
    { shopify_product_id: "18446744073709551614", handle: "reused-handle" },
    { shopify_product_id: "18446744073709551615", handle: "reused-handle" },
  ]);

  assert.equal(result.matched.size, 0);
  assert.equal(result.unmatched.get("reused-handle"), 5);
});
