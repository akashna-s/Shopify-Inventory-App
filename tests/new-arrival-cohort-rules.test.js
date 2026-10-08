/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateNewArrivalReport } from "../app/new-arrival-engine.server.js";

function reportWithInventoryAuditDate(firstInventoryDate) {
  return generateNewArrivalReport(
    [
      {
        productId: "101",
        period: "2026-01",
        title: "Protected cohort product",
        productType: "Dress",
        startingInventory: 0,
        endingInventory: 0,
        totalSales: 0,
        // Include both common source spellings so neither can accidentally
        // become an input to launch-cohort assignment in the future.
        firstDayInInventory: firstInventoryDate,
        first_day_in_inventory: firstInventoryDate,
      },
      {
        productId: "101",
        period: "2026-02",
        title: "Protected cohort product",
        productType: "Dress",
        startingInventory: 10,
        endingInventory: 8,
        totalSales: 100,
        firstDayInInventory: firstInventoryDate,
        first_day_in_inventory: firstInventoryDate,
      },
    ],
    ["2026-01", "2026-02"],
    { "2026-01": 0, "2026-02": 100 },
  );
}

test("first_day_in_inventory never changes New Arrival cohort assignment", () => {
  const earlyAuditDate = reportWithInventoryAuditDate("2024-01-05");
  const lateAuditDate = reportWithInventoryAuditDate("2026-12-20");

  assert.equal(earlyAuditDate.details[0].cohort, "2026-02");
  assert.equal(lateAuditDate.details[0].cohort, "2026-02");
  assert.deepEqual(
    earlyAuditDate.overall.launchedProductCounts,
    lateAuditDate.overall.launchedProductCounts,
  );
});

test("cohort details can be deferred for a smaller initial response", () => {
  const report = generateNewArrivalReport(
    [{
      productId: "101",
      period: "2026-03",
      title: "Product 101",
      productType: "Dress",
      endingInventory: 1,
      totalSales: 10,
    }],
    ["2026-03"],
    { "2026-03": 10 },
    "type",
    { deferDetails: true },
  );
  assert.equal(report.details, null);
  assert.equal(report.overall.grand["2026-03"].naSales, 10);
});

test("Product terminology keeps the existing New Arrival count and percentage calculations", () => {
  const report = generateNewArrivalReport(
    [
      {
        productId: "101",
        period: "2026-01",
        productType: "Dress",
        startingInventory: 10,
        endingInventory: 8,
        totalSales: 100,
      },
      {
        productId: "101",
        period: "2026-02",
        productType: "Dress",
        startingInventory: 8,
        endingInventory: 6,
        totalSales: 50,
      },
      {
        productId: "102",
        period: "2026-01",
        productType: "Top",
        startingInventory: 0,
        endingInventory: 0,
        totalSales: 0,
      },
      {
        productId: "102",
        period: "2026-02",
        productType: "Top",
        startingInventory: 5,
        endingInventory: 4,
        totalSales: 20,
      },
    ],
    ["2026-01", "2026-02"],
    { "2026-01": 100, "2026-02": 70 },
  );

  const januaryCohort = report.overall.rows.find(
    ({ cohort }) => cohort === "2026-01",
  );
  const februaryCohort = report.overall.rows.find(
    ({ cohort }) => cohort === "2026-02",
  );

  assert.deepEqual(report.overall.launchedProductCounts, {
    "2026-01": 1,
    "2026-02": 1,
  });
  assert.equal(januaryCohort.values["2026-02"].naProducts, 1);
  assert.equal(januaryCohort.values["2026-02"].naProductRate, 1);
  assert.equal(januaryCohort.values["2026-02"].naProductTotalRate, 0.5);
  assert.equal(februaryCohort.values["2026-02"].naProducts, 1);
  assert.equal(februaryCohort.values["2026-02"].naProductRate, 1);
  assert.equal(februaryCohort.values["2026-02"].naProductTotalRate, 0.5);
  assert.equal(report.overall.grand["2026-02"].naProducts, 2);
  assert.equal(report.overall.grand["2026-02"].naProductRate, 1);
  assert.equal(report.overall.grand["2026-02"].naProductTotalRate, 1);
  assert.equal("naSkus" in report.overall.grand["2026-02"], false);
});

test("New Arrival labels and formulas consistently use Product terminology", async () => {
  const route = await readFile(
    new URL("../app/routes/app.new-arrivals.jsx", import.meta.url),
    "utf8",
  );

  assert.match(route, /"NA Products"/);
  assert.match(route, /"NA Product %"/);
  assert.match(route, /"NA Product % \(Total\)"/);
  assert.match(route, /Total products launched in cohort/);
  assert.match(route, /Active store products/);
  assert.doesNotMatch(route, /\bSKU(?:s)?\b/i);
});
