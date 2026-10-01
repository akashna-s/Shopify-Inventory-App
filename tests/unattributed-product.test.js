/* eslint-env node */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateNewArrivalReport } from "../app/new-arrival-engine.server.js";

test("unattributed sales are visible without becoming a product, cohort, inventory or conversion", () => {
  const months = ["2026-01", "2026-02"];
  const report = generateNewArrivalReport(
    [
      {
        productId: "101",
        period: "2026-01",
        title: "Known dress",
        productType: "Dress",
        startingInventory: 5,
        endingInventory: 4,
        totalSales: 100,
        landingSessions: 10,
        orders: 2,
      },
      {
        isUnattributed: true,
        period: "2026-01",
        title: "Unattributed Shopify Data",
        productType: "Unknown",
        startingInventory: 999,
        endingInventory: 999,
        totalSales: 25,
        landingSessions: 999,
        orders: 999,
      },
      {
        isUnattributed: true,
        period: "2026-02",
        totalSales: 40,
      },
    ],
    months,
    { "2026-01": 125, "2026-02": 40 },
  );

  assert.equal(report.productCount, 1);
  assert.equal(report.details.length, 1);
  assert.equal(report.overall.launchedProductCounts["2026-01"], 1);

  const unknown = report.overall.rows.find((row) => row.isUnattributed);
  assert.equal(unknown.label, "Unattributed");
  assert.equal(unknown.values["2026-01"].naSales, 25);
  assert.equal(unknown.values["2026-02"].naSales, 40);
  assert.equal(unknown.values["2026-01"].naSalesRate, 0.2);
  assert.equal(unknown.values["2026-01"].naProducts, null);
  assert.equal(unknown.values["2026-01"].naInventory, null);
  assert.equal(unknown.values["2026-01"].conversionRate, null);

  assert.equal(report.overall.grand["2026-01"].naSales, 125);
  assert.equal(report.overall.grand["2026-01"].naInventory, 4);
  assert.equal(report.overall.grand["2026-01"].naProducts, 1);
  assert.ok(report.byProductType.some(({ type }) => type === "Unknown"));
});

test("unattributed tag classification uses None and remains out of product details", () => {
  const report = generateNewArrivalReport(
    [{ isUnattributed: true, period: "2026-01", totalSales: 15 }],
    ["2026-01"],
    { "2026-01": 15 },
    "tag",
  );

  assert.equal(report.productCount, 0);
  assert.deepEqual(report.details, []);
  assert.ok(report.byProductType.some(({ type }) => type === "None"));
});

test("migration creates one protected unattributed product per store", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/202609300007_unattributed_product_bucket.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /record_kind in \('shopify', 'unattributed'\)/);
  assert.match(sql, /unique index[\s\S]+where record_kind = 'unattributed'/i);
  assert.match(sql, /ensure_audit_unattributed_product/);
  assert.match(sql, /record_kind = 'shopify'[\s\S]+catalog_state in \('missing', 'deleted'\)/);
  assert.match(sql, /when product\.record_kind = 'unattributed' then 'UNATTRIBUTED'/);
});
