/* eslint-env node */

import assert from "node:assert/strict";
import test from "node:test";

import {
  loadNewArrivalMonthlySource,
  newArrivalLookbackBounds,
  newArrivalSourceFromDatabaseReport,
  newArrivalSourceFromMonthlyReport,
} from "../app/new-arrival-monthly-source.server.js";

test("saved New Arrival source keeps the two-month cohort lookback out of visible rows", () => {
  const source = newArrivalSourceFromMonthlyReport(
    {
      rows: [
        {
          day: "2026-01-01",
          productId: "101",
          startingInventory: 2,
          endingInventory: 1,
          totalSales: 0,
        },
        {
          day: "2026-03-01",
          productId: "101",
          title: "Existing product",
          productType: "Dress",
          tags: ["Best Sellers"],
          handle: "existing-product",
          imageUrl: "https://cdn.example/product.jpg",
          productUrl: "https://shop.example/products/existing-product",
          startingInventory: 1,
          endingInventory: 0,
          totalSales: 50,
          orders: 1,
          landingSessions: 10,
        },
        {
          day: "2026-03-01",
          productId: "UNATTRIBUTED",
          isUnattributed: true,
          totalSales: 5,
        },
      ],
      monthlyStoreSales: {
        "2026-01": 0,
        "2026-03": 55,
      },
      shopCurrency: "INR",
      dataSource: "supabase-database-monthly",
      catalogRefreshedAt: "2026-03-31T05:00:00.000Z",
    },
    {
      start: "2026-03-01",
      end: "2026-03-31",
      lookbackStart: "2026-01-01",
    },
  );

  assert.deepEqual([...source.firstCohortProductIds], ["101"]);
  assert.equal(source.sourceRows.length, 2);
  assert.equal(source.sourceRows[0].period, "2026-03");
  assert.equal(source.sourceRows[0].productTags[0], "Best Sellers");
  assert.equal(source.sourceRows[1].isUnattributed, true);
  assert.deepEqual(source.monthlyStoreSales, { "2026-03": 55 });
});

test("saved New Arrival lookback starts two calendar months before the selected range", () => {
  assert.deepEqual(newArrivalLookbackBounds("2026-03-01"), {
    start: "2026-01-01",
    end: "2026-02-28",
  });
});

test("partial first months stay on the existing live ShopifyQL path", async () => {
  const source = await loadNewArrivalMonthlySource({
    session: null,
    start: "2026-03-12",
    end: "2026-03-31",
    shopInfo: { currency: "INR", shopUrl: "https://shop.example" },
  });
  assert.equal(source, null);
});

test("compact database source uses monthly metadata snapshots and exact coverage", () => {
  const source = newArrivalSourceFromDatabaseReport(
    {
      products: [{
        shopify_product_id: "101",
        title: "Current title",
        product_type: "Current type",
        handle: "current-handle",
        image_url: "https://cdn.example/101.jpg",
        tags: ["Current tag"],
      }],
      product_metrics: [
        {
          month: "2026-01-01",
          shopify_product_id: "101",
          currency_code: "INR",
          title_snapshot: "January title",
          product_type_snapshot: "January type",
          handle_snapshot: "january-handle",
          starting_inventory: 2,
          ending_inventory: 1,
          total_sales_minor: 10000,
        },
        {
          month: "2026-03-01",
          shopify_product_id: "101",
          currency_code: "INR",
          title_snapshot: "March title",
          product_type_snapshot: "March type",
          handle_snapshot: "march-handle",
          starting_inventory: 1,
          ending_inventory: 0,
          landing_sessions: 10,
          product_orders: 2,
          total_sales_minor: 50000,
        },
      ],
      store_metrics: [
        ["2026-01-01", "2026-01-31", 10000],
        ["2026-02-01", "2026-02-28", 0],
        ["2026-03-01", "2026-03-31", 55000],
      ].map(([month, sourceEnd, total]) => ({
        month,
        currency_code: "INR",
        total_sales_minor: total,
        source_range_start: month,
        source_range_end: sourceEnd,
        cache_schema_version: 1,
        refreshed_at: "2026-03-31T05:00:00.000Z",
      })),
    },
    {
      start: "2026-03-01",
      end: "2026-03-31",
      lookbackStart: "2026-01-01",
      shopInfo: {
        shopUrl: "https://shop.example",
        shopCurrency: "INR",
      },
    },
  );

  assert.deepEqual([...source.firstCohortProductIds], ["101"]);
  assert.equal(source.sourceRows.length, 1);
  assert.equal(source.sourceRows[0].title, "March title");
  assert.equal(source.sourceRows[0].productType, "March type");
  assert.equal(source.sourceRows[0].handle, "march-handle");
  assert.equal(source.sourceRows[0].totalSales, 500);
  assert.equal(source.monthlyStoreSales["2026-03"], 550);
});

