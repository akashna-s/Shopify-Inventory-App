/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  nonNegativeInventory,
  sumNonNegativeInventory,
} from "../app/inventory-rules.server.js";

test("negative inventory contributes zero to reporting totals", () => {
  assert.equal(nonNegativeInventory(-15), 0);
  assert.equal(nonNegativeInventory(0), 0);
  assert.equal(nonNegativeInventory(12), 12);
  assert.equal(nonNegativeInventory(null), 0);
});

test("store-month inventory sums positive balances without subtracting negatives", () => {
  const rows = [
    { starting_inventory: 100, ending_inventory: 80 },
    { starting_inventory: -20, ending_inventory: -5 },
    { starting_inventory: 10, ending_inventory: 4 },
  ];

  assert.equal(sumNonNegativeInventory(rows, "starting_inventory"), 110);
  assert.equal(sumNonNegativeInventory(rows, "ending_inventory"), 84);
});
